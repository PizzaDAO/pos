-- ============================================================================
-- staff_admin_gate checks (migration 20261113000200).
-- Run by scripts/pglite-migrate.mjs after the migrations + seed. Rolled back.
--
--   * begin_pin_limit_attempt counts attempts, locks once the budget is spent,
--     refuses while locked, and release_pin_limit_attempt un-counts one attempt
--     (never below 0, never clearing a lock)
--   * an expired window starts a fresh budget
--   * client roles can't read/write pin_attempt_limits or call the functions,
--     and can't read the new staff contact columns
--   * terminal_staff_sessions.kind defaults to 'till' and rejects other values
-- ============================================================================
begin;
set client_min_messages = warning;
-- As the service role (no JWT user): an earlier check file can leave the
-- claims GUC as '' (not JSON), which auth.uid() in the staff triggers rejects.
select set_config('request.jwt.claims', '{}', true);

do $$
declare
  r jsonb;
  i int;
begin
  -- 3 attempts allowed, the 4th trips the lock.
  for i in 1..3 loop
    r := public.begin_pin_limit_attempt('device', 'u-1', 3, 15, 15);
    if not (r->>'allowed')::boolean then raise exception 'attempt % refused early', i; end if;
  end loop;
  -- A verified PIN releases its own attempt: one more fits.
  perform public.release_pin_limit_attempt('device', 'u-1');
  r := public.begin_pin_limit_attempt('device', 'u-1', 3, 15, 15);
  if not (r->>'allowed')::boolean then raise exception 'release did not un-count'; end if;
  r := public.begin_pin_limit_attempt('device', 'u-1', 3, 15, 15);
  if (r->>'allowed')::boolean or not (r->>'just_locked')::boolean then
    raise exception 'budget spent but not locked: %', r;
  end if;
  r := public.begin_pin_limit_attempt('device', 'u-1', 3, 15, 15);
  if (r->>'allowed')::boolean or (r->>'just_locked')::boolean or r->>'locked_until' is null then
    raise exception 'not refused while locked: %', r;
  end if;
  -- A release never clears a lock.
  perform public.release_pin_limit_attempt('device', 'u-1');
  r := public.begin_pin_limit_attempt('device', 'u-1', 3, 15, 15);
  if (r->>'allowed')::boolean then raise exception 'release cleared a lock'; end if;

  -- Buckets are independent per scope/key.
  r := public.begin_pin_limit_attempt('location', 'u-1', 3, 15, 15);
  if not (r->>'allowed')::boolean then raise exception 'scopes share a bucket'; end if;

  -- An expired lock / window starts a fresh budget.
  update public.pin_attempt_limits
     set locked_until = now() - interval '1 minute'
   where scope = 'device' and key = 'u-1';
  r := public.begin_pin_limit_attempt('device', 'u-1', 3, 15, 15);
  if not (r->>'allowed')::boolean or (r->>'attempts')::int <> 1 then
    raise exception 'expired lock did not reset: %', r;
  end if;
  update public.pin_attempt_limits
     set attempts = 3, window_started_at = now() - interval '20 minutes'
   where scope = 'device' and key = 'u-1';
  r := public.begin_pin_limit_attempt('device', 'u-1', 3, 15, 15);
  if not (r->>'allowed')::boolean or (r->>'attempts')::int <> 1 then
    raise exception 'expired window did not reset: %', r;
  end if;

  -- Release never goes below zero.
  perform public.release_pin_limit_attempt('location', 'fresh');
  perform public.begin_pin_limit_attempt('location', 'fresh', 3, 15, 15);
  perform public.release_pin_limit_attempt('location', 'fresh');
  perform public.release_pin_limit_attempt('location', 'fresh');
  if (select attempts from public.pin_attempt_limits where scope = 'location' and key = 'fresh') <> 0 then
    raise exception 'release went below zero';
  end if;

  -- ---- grants --------------------------------------------------------------
  if has_table_privilege('authenticated', 'public.pin_attempt_limits', 'SELECT')
     or has_table_privilege('authenticated', 'public.pin_attempt_limits', 'INSERT')
     or has_table_privilege('authenticated', 'public.pin_attempt_limits', 'UPDATE')
     or has_table_privilege('anon', 'public.pin_attempt_limits', 'SELECT') then
    raise exception 'a client role can touch pin_attempt_limits';
  end if;
  if has_function_privilege('authenticated',
       'public.begin_pin_limit_attempt(text, text, integer, integer, integer)', 'EXECUTE')
     or has_function_privilege('anon',
       'public.begin_pin_limit_attempt(text, text, integer, integer, integer)', 'EXECUTE')
     or has_function_privilege('authenticated',
       'public.release_pin_limit_attempt(text, text)', 'EXECUTE') then
    raise exception 'a client role can call the PIN limit functions';
  end if;
  if has_column_privilege('authenticated', 'public.staff', 'contact_email', 'SELECT')
     or has_column_privilege('authenticated', 'public.staff', 'contact_phone', 'SELECT') then
    raise exception 'staff contact details are readable with a user JWT';
  end if;
  if has_table_privilege('authenticated', 'public.staff', 'UPDATE') then
    raise exception 'authenticated can update staff';
  end if;

  -- ---- session kind ----------------------------------------------------------
  insert into public.staff (id, tenant_id, name, role)
  values ('5ec0d000-0000-4000-8000-000000000001', '10000000-0000-0000-0000-000000000001',
          'Gate Owner', 'owner');
  insert into public.terminal_staff_sessions (id, user_id, tenant_id, staff_id, expires_at)
  values ('5ec0d000-0000-4000-8000-0000000000a1', '5ec0d000-0000-4000-8000-0000000000b1',
          '10000000-0000-0000-0000-000000000001', '5ec0d000-0000-4000-8000-000000000001',
          now() + interval '10 minutes');
  if (select kind from public.terminal_staff_sessions
       where id = '5ec0d000-0000-4000-8000-0000000000a1') <> 'till' then
    raise exception 'session kind does not default to till';
  end if;
  begin
    insert into public.terminal_staff_sessions (id, user_id, tenant_id, staff_id, expires_at, kind)
    values (gen_random_uuid(), '5ec0d000-0000-4000-8000-0000000000b1',
            '10000000-0000-0000-0000-000000000001', '5ec0d000-0000-4000-8000-000000000001',
            now(), 'root');
    raise exception 'bad session kind accepted';
  exception when check_violation then
    null;
  end;

  -- ---- last owner -----------------------------------------------------------
  -- The demo tenant now has two active owners (Tony + Gate Owner): one may go.
  update public.staff set role = 'manager' where id = '5ec0d000-0000-4000-8000-000000000001';
  -- Tony is now the last active owner: demote and deactivate are refused.
  begin
    update public.staff set role = 'cashier' where id = '80000000-0000-0000-0000-000000000001';
    raise exception 'last owner demoted';
  exception when check_violation then
    null;
  end;
  begin
    update public.staff set active = false where id = '80000000-0000-0000-0000-000000000001';
    raise exception 'last owner deactivated';
  exception when check_violation then
    null;
  end;
  -- Unrelated edits of the last owner still work.
  update public.staff set name = 'Tony S.' where id = '80000000-0000-0000-0000-000000000001';
  -- Re-promote the second owner, then the first may step down.
  update public.staff set role = 'owner' where id = '5ec0d000-0000-4000-8000-000000000001';
  update public.staff set active = false where id = '80000000-0000-0000-0000-000000000001';

  -- New audit values exist.
  perform 'staff_pin_reset'::public.audit_action;
  perform 'admin_unlock'::public.audit_action;
  perform 'staff_create'::public.audit_action;
end
$$;

rollback;
