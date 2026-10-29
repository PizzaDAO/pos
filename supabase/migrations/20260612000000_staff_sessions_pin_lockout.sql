-- ============================================================================
-- Migration: staff_sessions_pin_lockout
--
--   * terminal_staff_sessions: server-side record of each PIN switch-in. The
--     signed `pos_active_staff` cookie carries a session id (nonce) bound to the
--     device login's auth user; the server honours it only while the row exists,
--     is unexpired and not revoked. Switch-out revokes the row; sign-out revokes
--     every row of that user — so a copied cookie dies with them.
--   * staff.pin_failed_attempts / pin_locked_until + record_pin_failure(): a
--     per-staff PIN lockout (5 failures → 15-minute lock), atomic under a row
--     lock, in addition to the per-IP rate limit.
--   * tenants.suspended_by_platform: an explicit flag set in the SAME update as
--     the platform's suspend (cleared on reactivate), so self-serve go-live can
--     refuse platform-suspended tenants without scanning the audit log.
--
-- SECURITY DEFINER functions pin search_path = public, pg_temp; service_role
-- only. IDEMPOTENT.
-- ============================================================================

-- ---- Platform suspension flag ------------------------------------------------
alter table public.tenants
  add column if not exists suspended_by_platform boolean not null default false;

-- ---- PIN lockout ---------------------------------------------------------------
alter table public.staff
  add column if not exists pin_failed_attempts integer not null default 0;
alter table public.staff
  add column if not exists pin_locked_until timestamptz;

-- record_pin_failure(p_tenant_id, p_staff_id, p_max, p_lock_minutes) → jsonb
--   { attempts: int, locked_until: timestamptz|null }
-- An expired lock is cleared first; reaching p_max failures sets the lock and
-- resets the counter.
create or replace function public.record_pin_failure(
  p_tenant_id uuid,
  p_staff_id uuid,
  p_max integer default 5,
  p_lock_minutes integer default 15
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_staff public.staff%rowtype;
  v_attempts integer;
  v_locked timestamptz;
begin
  select * into v_staff from public.staff
   where id = p_staff_id and tenant_id = p_tenant_id
   for update;
  if not found then
    return jsonb_build_object('attempts', 0, 'locked_until', null);
  end if;

  if v_staff.pin_locked_until is not null and v_staff.pin_locked_until > now() then
    return jsonb_build_object('attempts', v_staff.pin_failed_attempts,
                              'locked_until', v_staff.pin_locked_until);
  end if;

  v_attempts := (case when v_staff.pin_locked_until is not null
                      then 0 else v_staff.pin_failed_attempts end) + 1;
  v_locked := null;
  if v_attempts >= p_max then
    v_locked := now() + make_interval(mins => p_lock_minutes);
    v_attempts := 0;
  end if;

  update public.staff
     set pin_failed_attempts = v_attempts,
         pin_locked_until = v_locked
   where id = p_staff_id;

  return jsonb_build_object('attempts', v_attempts, 'locked_until', v_locked);
end;
$$;

revoke all on function public.record_pin_failure(uuid, uuid, integer, integer)
  from public, anon, authenticated;
grant execute on function public.record_pin_failure(uuid, uuid, integer, integer)
  to service_role;

-- ---- Terminal staff sessions ---------------------------------------------------
create table if not exists public.terminal_staff_sessions (
  id uuid primary key,
  user_id uuid not null,
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  staff_id uuid not null references public.staff (id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);
create index if not exists terminal_staff_sessions_user_idx
  on public.terminal_staff_sessions (user_id) where revoked_at is null;

alter table public.terminal_staff_sessions enable row level security;
alter table public.terminal_staff_sessions force row level security;
-- No policies: only the server (service_role, BYPASSRLS) touches this table.
revoke all on public.terminal_staff_sessions from anon;
revoke all on public.terminal_staff_sessions from authenticated;
grant select, insert, update, delete on public.terminal_staff_sessions
  to service_role;
