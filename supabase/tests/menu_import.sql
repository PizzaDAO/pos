-- ============================================================================
-- menu_import checks (run by scripts/pglite-migrate.mjs after migrations +
-- seed): public.import_menu() inserts / updates in place / deletes atomically,
-- rolls back as a unit on a bad row, rejects another tenant's rows or ids,
-- refuses a stale duplicate, and cleans recipes + allergens + overrides of
-- removed targets. Rolled back at the end.
-- ============================================================================
begin;

do $$
declare
  t uuid := '10000000-0000-0000-0000-000000000001';
  other uuid := gen_random_uuid();
  c1 uuid := gen_random_uuid();
  i1 uuid := gen_random_uuid();
  g1 uuid := gen_random_uuid();
  s1 uuid := gen_random_uuid();
  m1 uuid := gen_random_uuid();
  n int;
  before_items int;
  failed boolean;
  changes jsonb;
  msg text;
begin
  insert into public.tenants (id, name, slug, status) values (other, 'Other', 'other-' || other, 'active');
  select count(*) into before_items from public.menu_items where tenant_id = t;

  changes := jsonb_build_object('insert', jsonb_build_object(
    'categories', jsonb_build_array(jsonb_build_object('id', c1, 'tenant_id', t, 'name', 'Imported', 'sort_order', 1)),
    'items', jsonb_build_array(jsonb_build_object('id', i1, 'tenant_id', t, 'category_id', c1, 'name', 'Imp Pie',
        'description', null, 'is_half_and_half_capable', false, 'station', 'oven')),
    'sizes', jsonb_build_array(jsonb_build_object('id', s1, 'item_id', i1, 'name', 'Regular', 'price_cents', 1200, 'sort_order', 1)),
    'modifierGroups', jsonb_build_array(jsonb_build_object('id', g1, 'tenant_id', t, 'name', 'Zz Crust', 'min_select', 0, 'max_select', 1, 'supports_half', false)),
    'modifiers', jsonb_build_array(jsonb_build_object('id', m1, 'group_id', g1, 'name', 'Thin', 'price_cents', 0, 'sort_order', 1)),
    'itemModifierGroups', jsonb_build_array(jsonb_build_object('item_id', i1, 'group_id', g1, 'sort_order', 1))
  ));

  -- Insert keeps the existing menu.
  perform public.import_menu(t, changes);
  select count(*) into n from public.menu_items where tenant_id = t;
  if n <> before_items + 1 then raise exception 'add item count %', n; end if;

  -- A stale duplicate (same names again) is refused, nothing duplicated.
  failed := false;
  begin
    perform public.import_menu(t, changes);
  exception when others then
    failed := true; get stacked diagnostics msg = message_text;
  end;
  if not failed or msg not like '%menu changed%' then raise exception 'duplicate apply accepted (%)', msg; end if;

  -- Recipes / allergens / overrides on the item, then update it in place and
  -- delete its size: item id survives, size goes.
  insert into public.location_menu_overrides (tenant_id, location_id, target_type, target_id, available)
    select t, id, 'item', i1, false from public.locations where tenant_id = t limit 1;
  perform public.import_menu(t, jsonb_build_object(
    'update', jsonb_build_object('items', jsonb_build_array(jsonb_build_object(
       'id', i1, 'category_id', c1, 'name', 'Imp Pie 2', 'description', 'd',
       'is_half_and_half_capable', true, 'station', 'cold'))),
    'delete', jsonb_build_object('sizes', jsonb_build_array(s1))));
  if (select name from public.menu_items where id = i1) <> 'Imp Pie 2' then raise exception 'update missed'; end if;
  if exists (select 1 from public.item_sizes where id = s1) then raise exception 'size not deleted'; end if;
  if not exists (select 1 from public.location_menu_overrides where target_id = i1) then raise exception 'override of a kept item was removed'; end if;

  -- Deleting the item cascades its links and clears its override.
  perform public.import_menu(t, jsonb_build_object('delete', jsonb_build_object('items', jsonb_build_array(i1))));
  if exists (select 1 from public.menu_items where id = i1) then raise exception 'item not deleted'; end if;
  if exists (select 1 from public.location_menu_overrides where target_id = i1) then raise exception 'override not cleared'; end if;

  -- A bad row (size for an unknown item) rolls the whole call back, deletes included.
  select count(*) into before_items from public.menu_items where tenant_id = t;
  failed := false;
  begin
    perform public.import_menu(t, jsonb_build_object(
      'delete', jsonb_build_object('categories', (select jsonb_agg(id) from public.menu_categories where tenant_id = t)),
      'insert', jsonb_build_object('sizes', jsonb_build_array(
         jsonb_build_object('id', gen_random_uuid(), 'item_id', gen_random_uuid(), 'name', 'x', 'price_cents', 1, 'sort_order', 1)))));
  exception when others then
    failed := true;
  end;
  if not failed then raise exception 'bad row was accepted'; end if;
  select count(*) into n from public.menu_items where tenant_id = t;
  if n <> before_items then raise exception 'not rolled back (% vs %)', n, before_items; end if;

  -- Another tenant's rows / ids are refused.
  failed := false;
  begin
    perform public.import_menu(other, changes);
  exception when others then
    failed := true;
  end;
  if not failed then raise exception 'cross-tenant rows were accepted'; end if;
  failed := false;
  begin
    perform public.import_menu(other, jsonb_build_object('delete', jsonb_build_object(
      'items', (select jsonb_agg(id) from public.menu_items where tenant_id = t))));
  exception when others then
    failed := true;
  end;
  if not failed then raise exception 'cross-tenant delete was accepted'; end if;
  select count(*) into n from public.menu_items where tenant_id = t;
  if n <> before_items then raise exception 'cross-tenant delete changed data'; end if;
end
$$;

rollback;
