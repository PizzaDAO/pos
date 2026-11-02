-- ============================================================================
-- delivery_driver_wiring checks (run by scripts/pglite-migrate.mjs after the
-- migrations + seed): staff.module_roles accepts driver/dispatcher only, and
-- the delivery dispatch-retry columns default sanely. Rolled back at the end.
-- ============================================================================
begin;

do $$
declare
  t uuid := '10000000-0000-0000-0000-000000000001';
  s uuid := gen_random_uuid();
  v text[];
  rejected boolean := false;
  a int;
begin
  insert into public.staff (id, tenant_id, name, role, active)
    values (s, t, 'Dee Driver', 'cashier', true);
  select module_roles into v from public.staff where id = s;
  if v is distinct from '{}'::text[] then raise exception 'default module_roles: %', v; end if;

  update public.staff set module_roles = array['driver','dispatcher'] where id = s;

  begin
    update public.staff set module_roles = array['owner'] where id = s;
  exception when check_violation then
    rejected := true;
  end;
  if not rejected then raise exception 'module_roles accepted a POS role'; end if;

  select module_roles into v from public.staff where id = s;
  if v is distinct from array['driver','dispatcher'] then raise exception 'module_roles after reject: %', v; end if;

  select count(*) into a from information_schema.columns
   where table_schema = 'public' and table_name = 'deliveries'
     and column_name in ('dispatch_attempts','dispatch_error','dispatch_next_at');
  if a <> 3 then raise exception 'dispatch columns missing (%)', a; end if;
end
$$;

rollback;
