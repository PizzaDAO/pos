-- ============================================================================
-- Migration: staff_admin_gate (security audit M1 + staff management)
--
--   * staff.contact_email / contact_phone: optional contact details an owner or
--     manager records in Admin > Staff. Informational ONLY: they are not an
--     identity key (the login link stays staff.user_id), they never reach the
--     core outbox (its staff snapshot is ids only) and they are NOT added to the
--     `authenticated` column grant on staff, so tenant users can't read them
--     through PostgREST. The server (service role) reads and writes them.
--   * terminal_staff_sessions.kind: 'till' (a PIN switch-in at the terminal,
--     as before) or 'admin' (a short-lived back-office unlock by an owner or
--     manager PIN). The till only honours 'till' sessions and the admin gate
--     only 'admin' ones, so a session id of one kind can't be replayed as the
--     other (e.g. an admin unlock id passed as an offline order's session).
--   * pin_attempt_limits + begin_pin_limit_attempt / release_pin_limit_attempt:
--     per-DEVICE (device login) and per-LOCATION PIN attempt budgets, on top of
--     the per-staff lockout (begin_pin_attempt) and the per-IP rate limit. An
--     attempt is counted under a row lock BEFORE the PIN is checked; a verified
--     PIN releases (un-counts) its own attempt, so only unproven attempts spend
--     the budget and concurrent guesses can't race past it. Budget spent inside
--     the window -> locked for p_lock_minutes.
--   * audit_action values for staff management and the admin unlock.
--
-- DEPLOY ORDER: migration first, then code (the code writes the new columns,
-- calls the new functions and writes the new audit values).
-- SECURITY DEFINER functions pin search_path; service_role only. IDEMPOTENT.
-- ============================================================================

begin;
set local lock_timeout = '3s';

-- ---- staff contact details ---------------------------------------------------
alter table public.staff add column if not exists contact_email text;
alter table public.staff add column if not exists contact_phone text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'staff_contact_len_chk'
       and conrelid = 'public.staff'::regclass
  ) then
    alter table public.staff
      add constraint staff_contact_len_chk
      check (
        (contact_email is null or char_length(contact_email) <= 254)
        and (contact_phone is null or char_length(contact_phone) <= 32)
      );
  end if;
end
$$;

-- ---- never lose the last owner ------------------------------------------------
-- The app refuses to demote or deactivate the last active owner; this trigger
-- makes it hold under concurrency too (two admins demoting the only two owners
-- at once) and for every write path. The owner rows of the tenant are locked
-- FOR UPDATE before counting, so concurrent demotions serialize and the second
-- one sees the first.
create or replace function public.staff_keep_an_owner()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_others integer;
begin
  if not (old.role = 'owner' and old.active)
     or (new.role = 'owner' and new.active and new.tenant_id = old.tenant_id) then
    return new;
  end if;
  perform 1 from public.staff
    where tenant_id = old.tenant_id and role = 'owner' and active
    for update;
  select count(*) into v_others
    from public.staff
   where tenant_id = old.tenant_id and role = 'owner' and active and id <> old.id;
  if v_others = 0 then
    raise exception 'cannot demote or deactivate the last active owner'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function public.staff_keep_an_owner() from public, anon, authenticated;

drop trigger if exists staff_keep_an_owner on public.staff;
create trigger staff_keep_an_owner
  before update of role, active, tenant_id on public.staff
  for each row execute function public.staff_keep_an_owner();

-- ---- staff session kind --------------------------------------------------------
alter table public.terminal_staff_sessions
  add column if not exists kind text not null default 'till';

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'terminal_staff_sessions_kind_chk'
       and conrelid = 'public.terminal_staff_sessions'::regclass
  ) then
    alter table public.terminal_staff_sessions
      add constraint terminal_staff_sessions_kind_chk
      check (kind in ('till', 'admin'));
  end if;
end
$$;

-- "Last sign-in" in Admin > Staff reads the newest session per staff member.
create index if not exists terminal_staff_sessions_staff_idx
  on public.terminal_staff_sessions (tenant_id, staff_id, created_at desc);

-- ---- per-device / per-location PIN attempt budgets ----------------------------
create table if not exists public.pin_attempt_limits (
  scope text not null check (scope in ('device', 'location')),
  key text not null,
  attempts integer not null default 0,
  window_started_at timestamptz not null default now(),
  locked_until timestamptz,
  primary key (scope, key)
);

alter table public.pin_attempt_limits enable row level security;
alter table public.pin_attempt_limits force row level security;
-- No policies: only the server (service_role) touches this table.
revoke all on public.pin_attempt_limits from anon, authenticated;
grant select, insert, update, delete on public.pin_attempt_limits to service_role;

-- begin_pin_limit_attempt(scope, key, max, window_minutes, lock_minutes) -> jsonb
--   { allowed, just_locked, attempts, locked_until }
--   * locked (locked_until > now())            -> refused;
--   * window (or lock) expired                 -> fresh budget;
--   * p_max unproven attempts already spent    -> lock set, refused (just_locked);
--   * otherwise                                -> attempts + 1, allowed.
create or replace function public.begin_pin_limit_attempt(
  p_scope text,
  p_key text,
  p_max integer,
  p_window_minutes integer,
  p_lock_minutes integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.pin_attempt_limits%rowtype;
  v_now timestamptz := now();
begin
  insert into public.pin_attempt_limits (scope, key)
  values (p_scope, p_key)
  on conflict (scope, key) do nothing;

  select * into v_row
    from public.pin_attempt_limits
   where scope = p_scope and key = p_key
   for update;

  if v_row.locked_until is not null and v_row.locked_until > v_now then
    return jsonb_build_object('allowed', false, 'just_locked', false,
                              'attempts', v_row.attempts,
                              'locked_until', v_row.locked_until);
  end if;
  if v_row.locked_until is not null
     or v_row.window_started_at + make_interval(mins => p_window_minutes) <= v_now then
    v_row.attempts := 0;
    v_row.window_started_at := v_now;
    v_row.locked_until := null;
  end if;

  if v_row.attempts >= p_max then
    v_row.locked_until := v_now + make_interval(mins => p_lock_minutes);
    update public.pin_attempt_limits
       set attempts = 0, window_started_at = v_now, locked_until = v_row.locked_until
     where scope = p_scope and key = p_key;
    return jsonb_build_object('allowed', false, 'just_locked', true,
                              'attempts', 0, 'locked_until', v_row.locked_until);
  end if;

  update public.pin_attempt_limits
     set attempts = v_row.attempts + 1,
         window_started_at = v_row.window_started_at,
         locked_until = null
   where scope = p_scope and key = p_key;
  return jsonb_build_object('allowed', true, 'just_locked', false,
                            'attempts', v_row.attempts + 1, 'locked_until', null);
end;
$$;

-- A verified PIN un-counts its own attempt (never below 0, never clears a lock).
create or replace function public.release_pin_limit_attempt(
  p_scope text,
  p_key text
)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update public.pin_attempt_limits
     set attempts = greatest(attempts - 1, 0)
   where scope = p_scope and key = p_key and locked_until is null;
$$;

revoke all on function public.begin_pin_limit_attempt(text, text, integer, integer, integer)
  from public, anon, authenticated;
grant execute on function public.begin_pin_limit_attempt(text, text, integer, integer, integer)
  to service_role;
revoke all on function public.release_pin_limit_attempt(text, text)
  from public, anon, authenticated;
grant execute on function public.release_pin_limit_attempt(text, text)
  to service_role;

-- ---- audit actions ---------------------------------------------------------------
-- Added inside this transaction but not used in it (allowed since PG 12).
alter type public.audit_action add value if not exists 'staff_create';
alter type public.audit_action add value if not exists 'staff_update';
alter type public.audit_action add value if not exists 'staff_deactivate';
alter type public.audit_action add value if not exists 'staff_reactivate';
alter type public.audit_action add value if not exists 'staff_pin_reset';
alter type public.audit_action add value if not exists 'admin_unlock';

commit;

notify pgrst, 'reload schema';
