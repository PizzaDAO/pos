-- ============================================================================
-- Migration: staff_sessions_pin_lockout   (PR #20 rebased; was
-- 20260612000000_staff_sessions_pin_lockout, renumbered after main's
-- 20261101000300. Nothing in it overlaps main's schema.)
--
--   * terminal_staff_sessions: server-side record of each PIN switch-in. The
--     signed `pos_active_staff` cookie carries a session id (nonce) bound to the
--     device login's auth user; the server honours it only while the row exists,
--     is unexpired and not revoked. Switch-out revokes the row; sign-out revokes
--     every row of that user — so a copied cookie dies with them.
--   * staff.pin_failed_attempts / pin_locked_until + begin_pin_attempt(): a
--     per-staff PIN lockout (5 attempts without a success → 15-minute lock).
--     Each attempt is counted atomically under a row lock BEFORE the PIN is
--     checked, so concurrent guesses can't race past it; on top of the per-IP
--     rate limit. staff SELECT for `authenticated` becomes column-level, so
--     pin_hash and the lockout state are never readable with a user JWT.
--   * tenant_onboarding becomes server-write-only (owner write policy dropped).
--   * tenants.suspended_by_platform: an explicit flag set in the SAME update as
--     the platform's suspend (cleared on reactivate), so self-serve go-live can
--     refuse platform-suspended tenants without scanning the audit log.
--     Backfilled for tenants suspended before the flag existed.
--   * tenants.status / suspended_by_platform are SERVER-WRITE-ONLY: the
--     tenants_update policy lets an owner/manager update their tenant row via
--     PostgREST, which would let a platform-suspended tenant reactivate itself
--     (status = 'active') or clear the flag. Table-level UPDATE is revoked from
--     authenticated and re-granted on `name` only. The app writes tenants only
--     through the service-role server driver.
--
-- The server driver reads/writes these columns, so apply this migration BEFORE
-- deploying the code that uses it.
--
-- SECURITY DEFINER functions pin search_path = public, pg_temp; service_role
-- only. IDEMPOTENT.
-- ============================================================================

-- ---- Platform suspension flag ------------------------------------------------
alter table public.tenants
  add column if not exists suspended_by_platform boolean not null default false;

-- Backfill: tenants the platform suspended BEFORE this flag existed. A tenant
-- is platform-suspended when its latest tenant_suspend audit is not followed by
-- a tenant_reactivate. The audit write is best-effort, so the log alone can
-- miss one: any suspended tenant that is NOT a mid-signup tenant (signup
-- creates tenants as 'suspended' with a not-yet-live tenant_onboarding row)
-- is ambiguous and is also treated as platform-suspended (fail closed).
-- Mid-signup tenants with no suspend audit stay false so they can go live.
-- Re-running only ever re-sets true on rows matching the same rule.
update public.tenants t
   set suspended_by_platform = true
 where t.status = 'suspended'
   and t.suspended_by_platform = false
   and (
     exists (
       select 1 from public.audit_log s
        where s.tenant_id = t.id
          and s.action = 'tenant_suspend'
          and not exists (
            select 1 from public.audit_log r
             where r.tenant_id = t.id
               and r.action = 'tenant_reactivate'
               and r.created_at > s.created_at
          )
     )
     or not exists (
       select 1 from public.tenant_onboarding o
        where o.tenant_id = t.id and o.live = false
     )
   );

-- Owners/managers keep UPDATE on the display name only (column privilege);
-- status, slug and the platform flag are written by the server alone.
revoke update on public.tenants from authenticated;
grant update (name) on public.tenants to authenticated;
revoke update on public.tenants from anon;

-- ---- tenant_onboarding is SERVER-WRITE-ONLY -----------------------------------
-- tenant_onboarding_write let an owner write their own wizard row through
-- PostgREST — e.g. flip `live` / completed_steps and skip the server's go-live
-- checks (plan paid, not platform-suspended). The app writes it only through
-- the service-role server driver. Members keep SELECT (tenant_onboarding_select).
drop policy if exists tenant_onboarding_write on public.tenant_onboarding;
revoke insert, update, delete on public.tenant_onboarding from authenticated;
revoke insert, update, delete on public.tenant_onboarding from anon;

-- ---- PIN lockout ---------------------------------------------------------------
alter table public.staff
  add column if not exists pin_failed_attempts integer not null default 0;
alter table public.staff
  add column if not exists pin_locked_until timestamptz;

-- record_pin_failure() (an earlier, unapplied draft of this migration) counted
-- a failure only AFTER the PIN was checked against a separate "is it locked?"
-- read, so N concurrent guesses could all pass the read. Replaced by
-- begin_pin_attempt(); drop the draft if a dev database has it.
drop function if exists public.record_pin_failure(uuid, uuid, integer, integer);

-- begin_pin_attempt(p_tenant_id, p_staff_id, p_max, p_lock_minutes) → jsonb
--   { allowed: bool, just_locked: bool, attempts: int, locked_until: timestamptz|null }
-- Called BEFORE the PIN is verified, under a row lock (FOR UPDATE), so
-- concurrent attempts serialize:
--   * locked (locked_until > now())      → refused;
--   * an expired lock                     → cleared (fresh budget);
--   * p_max attempts already spent       → sets the lock, refused (just_locked);
--   * otherwise                           → attempts + 1, allowed.
-- A verified PIN then resets the count with a CONDITIONAL update
-- (… where pin_locked_until is null): a lock set meanwhile by a concurrent burst
-- is never cleared by a success. At most p_max PINs are ever checked per lock
-- window, however many requests race.
create or replace function public.begin_pin_attempt(
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
  v_attempts integer;
  v_locked timestamptz;
begin
  select pin_failed_attempts, pin_locked_until
    into v_attempts, v_locked
    from public.staff
   where id = p_staff_id and tenant_id = p_tenant_id
   for update;
  if not found then
    return jsonb_build_object('allowed', false, 'just_locked', false,
                              'attempts', 0, 'locked_until', null);
  end if;

  if v_locked is not null and v_locked > now() then
    return jsonb_build_object('allowed', false, 'just_locked', false,
                              'attempts', v_attempts, 'locked_until', v_locked);
  end if;
  if v_locked is not null then
    v_attempts := 0;  -- the lock expired: fresh budget
  end if;

  if v_attempts >= p_max then
    v_locked := now() + make_interval(mins => p_lock_minutes);
    update public.staff
       set pin_failed_attempts = 0, pin_locked_until = v_locked
     where id = p_staff_id and tenant_id = p_tenant_id;
    return jsonb_build_object('allowed', false, 'just_locked', true,
                              'attempts', 0, 'locked_until', v_locked);
  end if;

  v_attempts := v_attempts + 1;
  update public.staff
     set pin_failed_attempts = v_attempts, pin_locked_until = null
   where id = p_staff_id and tenant_id = p_tenant_id;
  return jsonb_build_object('allowed', true, 'just_locked', false,
                            'attempts', v_attempts, 'locked_until', null);
end;
$$;

revoke all on function public.begin_pin_attempt(uuid, uuid, integer, integer)
  from public, anon, authenticated;
grant execute on function public.begin_pin_attempt(uuid, uuid, integer, integer)
  to service_role;

-- ---- staff: PIN secrets are not readable by tenant users ----------------------
-- staff_select lets every tenant member read the staff rows via PostgREST —
-- including pin_hash (an offline-crackable 4–6 digit PIN hash) and the lockout
-- state. Replace the table-wide SELECT with a column-level grant on everything
-- else. (The app reads staff ONLY through the service-role server driver;
-- listStaff strips pin_hash. Nothing selects staff with a user JWT.)
-- NOTE: a new staff column must be added to this grant to be user-readable.
revoke select on public.staff from authenticated;
revoke select on public.staff from anon;
grant select (id, tenant_id, name, role, active, created_at)
  on public.staff to authenticated;

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
