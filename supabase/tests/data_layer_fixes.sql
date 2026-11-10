-- ============================================================================
-- data_layer_fixes checks (migrations 20261114000000 + 20261114000010).
-- Run by scripts/pglite-migrate.mjs after the migrations + seed. Rolled back.
--
--   * order_number_counters / menu_versions: RLS enabled + forced, no client
--     grants; the new functions are not executable by anon / authenticated
--   * next_order_number continues after the location's existing numbers and
--     increments by one per call
--   * (location_id, order_number) is unique
--   * create_order_with_lines writes order + lines atomically, suffixes a taken
--     client number, and is idempotent on the id
--   * every menu table write bumps the tenant's menu_versions row
-- ============================================================================
begin;
set client_min_messages = warning;

do $$
declare
  t text;
  r text;
  p text;
  t_id constant uuid := '10000000-0000-0000-0000-000000000001';
  l_id constant uuid := '10000000-0000-0000-0000-000000000101';
  v1 bigint;
  v2 bigint;
  n1 bigint;
  res jsonb;
  oid1 uuid := gen_random_uuid();
  line uuid := gen_random_uuid();
begin
  foreach t in array array['order_number_counters', 'menu_versions'] loop
    if not (select relrowsecurity and relforcerowsecurity from pg_class
             where oid = ('public.' || t)::regclass) then
      raise exception 'RLS not enabled+forced on %', t;
    end if;
    foreach r in array array['anon', 'authenticated'] loop
      foreach p in array array['select', 'insert', 'update', 'delete', 'truncate', 'trigger', 'references'] loop
        if has_table_privilege(r, 'public.' || t, p) then
          raise exception '% has % on %', r, p, t;
        end if;
      end loop;
    end loop;
  end loop;
  foreach r in array array['anon', 'authenticated'] loop
    if has_function_privilege(r, 'public.create_order_with_lines(jsonb, jsonb, jsonb)', 'execute')
       or has_function_privilege(r, 'public.next_order_number(uuid, uuid)', 'execute') then
      raise exception '% can execute the order functions', r;
    end if;
  end loop;

  -- numbering continues after existing A-numbers
  insert into public.orders (id, tenant_id, location_id, totals, order_number)
  values (gen_random_uuid(), t_id, l_id, '{}', 'A-0500');
  n1 := public.next_order_number(t_id, l_id);
  if n1 <= 500 then raise exception 'counter did not continue after A-0500 (got %)', n1; end if;
  if public.next_order_number(t_id, l_id) <> n1 + 1 then raise exception 'counter did not increment by one'; end if;

  begin
    insert into public.orders (id, tenant_id, location_id, totals, order_number)
    values (gen_random_uuid(), t_id, l_id, '{}', 'A-0500');
    raise exception 'duplicate order number accepted';
  exception when unique_violation then null;
  end;

  -- atomic create, suffix, idempotency
  res := public.create_order_with_lines(
    jsonb_build_object('id', oid1, 'tenant_id', t_id, 'location_id', l_id,
      'channel', 'in_store', 'totals', '{}'::jsonb, 'order_number', 'A-0500'),
    jsonb_build_array(jsonb_build_object('id', line, 'item_id', gen_random_uuid(),
      'item_name', 'Pie', 'sort_order', 0)),
    jsonb_build_array(jsonb_build_object('order_item_id', line, 'group_id', gen_random_uuid(),
      'group_name', 'G', 'modifier_id', gen_random_uuid(), 'modifier_name', 'M')));
  if res ->> 'created' <> 'true' or res -> 'order' ->> 'order_number' <> 'A-0500-2'
     or jsonb_array_length(res -> 'items') <> 1 or jsonb_array_length(res -> 'modifiers') <> 1 then
    raise exception 'create_order_with_lines: unexpected result %', res;
  end if;
  res := public.create_order_with_lines(
    jsonb_build_object('id', oid1, 'tenant_id', t_id, 'location_id', l_id,
      'channel', 'in_store', 'totals', '{}'::jsonb), '[]', '[]');
  if res ->> 'created' <> 'false' or jsonb_array_length(res -> 'items') <> 1 then
    raise exception 'create_order_with_lines is not idempotent: %', res;
  end if;
  begin
    perform public.create_order_with_lines(
      jsonb_build_object('id', gen_random_uuid(), 'tenant_id', t_id, 'location_id', l_id,
        'channel', 'in_store', 'totals', '{}'::jsonb),
      '[]',
      jsonb_build_array(jsonb_build_object('order_item_id', line, 'group_id', gen_random_uuid(),
        'group_name', 'G', 'modifier_id', gen_random_uuid(), 'modifier_name', 'M')));
    raise exception 'a modifier for another order''s line was accepted';
  exception when invalid_parameter_value then null;
  end;

  -- menu version bumps on every menu table
  select coalesce((select version from public.menu_versions where tenant_id = t_id), 0) into v1;
  update public.item_sizes s set price_cents = price_cents
    from public.menu_items i where i.id = s.item_id and i.tenant_id = t_id;
  update public.modifiers m set name = m.name
    from public.modifier_groups g where g.id = m.group_id and g.tenant_id = t_id;
  update public.menu_items set name = name where tenant_id = t_id;
  insert into public.location_menu_overrides (tenant_id, location_id, target_type, target_id, available)
  values (t_id, l_id, 'item', gen_random_uuid(), false);
  select version into v2 from public.menu_versions where tenant_id = t_id;
  if v2 is distinct from v1 + 4 then
    raise exception 'menu_versions: expected % after four writes, got %', v1 + 4, v2;
  end if;
end;
$$;

rollback;
