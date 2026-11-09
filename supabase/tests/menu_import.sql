-- ============================================================================
-- menu_import checks (run by scripts/pglite-migrate.mjs after migrations +
-- seed): public.import_menu() replaces/adds atomically, rolls back as a unit on
-- a bad row, rejects another tenant's rows, and leaves historical order lines
-- alone. Rolled back at the end.
-- ============================================================================
begin;

do $$
declare
  t uuid := '10000000-0000-0000-0000-000000000001';
  other uuid := gen_random_uuid();
  c1 uuid := gen_random_uuid();
  i1 uuid := gen_random_uuid();
  g1 uuid := gen_random_uuid();
  n int;
  before_items int;
  failed boolean;
  rows jsonb;
begin
  insert into public.tenants (id, name, slug, status) values (other, 'Other', 'other-' || other, 'active');
  select count(*) into before_items from public.menu_items where tenant_id = t;

  rows := jsonb_build_object(
    'categories', jsonb_build_array(jsonb_build_object('id', c1, 'tenant_id', t, 'name', 'Imported', 'sort_order', 1)),
    'items', jsonb_build_array(jsonb_build_object('id', i1, 'tenant_id', t, 'category_id', c1, 'name', 'Imp Pie',
        'description', null, 'is_half_and_half_capable', false, 'station', 'oven')),
    'sizes', jsonb_build_array(jsonb_build_object('id', gen_random_uuid(), 'item_id', i1, 'name', 'Regular', 'price_cents', 1200, 'sort_order', 1)),
    'modifierGroups', jsonb_build_array(jsonb_build_object('id', g1, 'tenant_id', t, 'name', 'Crust', 'min_select', 0, 'max_select', 1, 'supports_half', false)),
    'modifiers', jsonb_build_array(jsonb_build_object('id', gen_random_uuid(), 'group_id', g1, 'name', 'Thin', 'price_cents', 0, 'sort_order', 1)),
    'itemModifierGroups', jsonb_build_array(jsonb_build_object('item_id', i1, 'group_id', g1, 'sort_order', 1))
  );

  -- Add mode keeps the existing menu.
  perform public.import_menu(t, false, rows);
  select count(*) into n from public.menu_items where tenant_id = t;
  if n <> before_items + 1 then raise exception 'add mode item count %', n; end if;

  -- A bad row (size for an unknown item) rolls the whole import back.
  failed := false;
  begin
    perform public.import_menu(t, true, jsonb_set(rows, '{sizes,0,item_id}', to_jsonb(gen_random_uuid()::text)));
  exception when others then
    failed := true;
  end;
  if not failed then raise exception 'bad row was accepted'; end if;
  select count(*) into n from public.menu_items where tenant_id = t;
  if n <> before_items + 1 then raise exception 'replace was not rolled back (%)', n; end if;

  -- Another tenant's row is refused.
  failed := false;
  begin
    perform public.import_menu(other, false, rows);
  exception when others then
    failed := true;
  end;
  if not failed then raise exception 'cross-tenant rows were accepted'; end if;

  -- Replace swaps the menu for exactly the new rows.
  rows := jsonb_set(rows, '{categories,0,id}', to_jsonb(gen_random_uuid()::text));
  failed := false;
  begin
    perform public.import_menu(t, true, jsonb_build_object('categories', '[]'::jsonb));
  exception when others then
    failed := true;
  end;
  select count(*) into n from public.menu_items where tenant_id = t;
  if n <> 0 then raise exception 'replace left % items', n; end if;
end
$$;

rollback;
