-- ============================================================================
-- Migration: menu_import
--
-- Back-office menu import (Square / Toast / Clover / generic CSV).
--
--   1. audit_action gains 'menu_import' (the app records one entry per apply).
--      Audit writes are fail-open, so until this value exists the entry would be
--      dropped silently: DEPLOY ORDER migration first, then code.
--   2. public.import_menu(p_tenant_id, p_replace, p_rows): applies an import in
--      ONE transaction (a PostgREST client cannot span statements). The app
--      builds the exact rows (ids included); this function only deletes (when
--      replacing) and inserts, and refuses any row that touches another tenant.
--
--      p_replace = true removes the tenant's whole menu: categories (cascade to
--      items, sizes, item_modifier_groups), modifier groups (cascade to
--      modifiers) and every per-location override (their targets are gone).
--      Historical orders are unaffected: order_items / order_item_modifiers
--      snapshot names, sizes and prices and keep item ids with NO foreign key,
--      exactly as deleting an item in the menu manager behaves today.
--
-- Additive and live-safe: an enum value + a new function; no table changes.
-- Callable only by service_role (the server driver). Re-runnable.
-- ============================================================================

begin;
set local lock_timeout = '3s';

alter type public.audit_action add value if not exists 'menu_import';

create or replace function public.import_menu(
  p_tenant_id uuid,
  p_replace boolean,
  p_rows jsonb
) returns jsonb
language plpgsql
as $$
declare
  v_cats jsonb := coalesce(p_rows -> 'categories', '[]'::jsonb);
  v_items jsonb := coalesce(p_rows -> 'items', '[]'::jsonb);
  v_sizes jsonb := coalesce(p_rows -> 'sizes', '[]'::jsonb);
  v_groups jsonb := coalesce(p_rows -> 'modifierGroups', '[]'::jsonb);
  v_mods jsonb := coalesce(p_rows -> 'modifiers', '[]'::jsonb);
  v_links jsonb := coalesce(p_rows -> 'itemModifierGroups', '[]'::jsonb);
begin
  if p_tenant_id is null then
    raise exception 'tenant is required';
  end if;
  if not exists (select 1 from public.tenants where id = p_tenant_id) then
    raise exception 'unknown tenant';
  end if;

  -- Rows that carry a tenant must carry THIS tenant.
  if exists (
       select 1 from jsonb_populate_recordset(null::public.menu_categories, v_cats) r
        where r.tenant_id is distinct from p_tenant_id)
     or exists (
       select 1 from jsonb_populate_recordset(null::public.menu_items, v_items) r
        where r.tenant_id is distinct from p_tenant_id)
     or exists (
       select 1 from jsonb_populate_recordset(null::public.modifier_groups, v_groups) r
        where r.tenant_id is distinct from p_tenant_id) then
    raise exception 'row belongs to another tenant';
  end if;

  if p_replace then
    delete from public.location_menu_overrides where tenant_id = p_tenant_id;
    delete from public.menu_categories where tenant_id = p_tenant_id;
    delete from public.modifier_groups where tenant_id = p_tenant_id;
  end if;

  insert into public.menu_categories
    select * from jsonb_populate_recordset(null::public.menu_categories, v_cats);
  insert into public.menu_items
    select * from jsonb_populate_recordset(null::public.menu_items, v_items);
  insert into public.modifier_groups
    select * from jsonb_populate_recordset(null::public.modifier_groups, v_groups);
  insert into public.item_sizes
    select * from jsonb_populate_recordset(null::public.item_sizes, v_sizes);
  insert into public.modifiers
    select * from jsonb_populate_recordset(null::public.modifiers, v_mods);
  insert into public.item_modifier_groups
    select * from jsonb_populate_recordset(null::public.item_modifier_groups, v_links);

  -- Foreign keys prove the parents exist; this proves they are THIS tenant's.
  if exists (
       select 1 from public.menu_items i
         join public.menu_categories c on c.id = i.category_id
        where i.tenant_id = p_tenant_id and c.tenant_id <> p_tenant_id)
     or exists (
       select 1 from public.item_sizes s
         join public.menu_items i on i.id = s.item_id
        where i.tenant_id <> p_tenant_id
          and s.id in (select (x ->> 'id')::uuid from jsonb_array_elements(v_sizes) x))
     or exists (
       select 1 from public.modifiers m
         join public.modifier_groups g on g.id = m.group_id
        where g.tenant_id <> p_tenant_id
          and m.id in (select (x ->> 'id')::uuid from jsonb_array_elements(v_mods) x))
     or exists (
       select 1 from public.item_modifier_groups l
         join public.menu_items i on i.id = l.item_id
         join public.modifier_groups g on g.id = l.group_id
        where (i.tenant_id <> p_tenant_id or g.tenant_id <> p_tenant_id)
          and (l.item_id, l.group_id) in (
            select (x ->> 'item_id')::uuid, (x ->> 'group_id')::uuid
              from jsonb_array_elements(v_links) x)) then
    raise exception 'row references another tenant';
  end if;

  return jsonb_build_object(
    'categories', jsonb_array_length(v_cats),
    'items', jsonb_array_length(v_items),
    'sizes', jsonb_array_length(v_sizes),
    'modifierGroups', jsonb_array_length(v_groups),
    'modifiers', jsonb_array_length(v_mods)
  );
end;
$$;

revoke all on function public.import_menu(uuid, boolean, jsonb) from public, anon, authenticated;
grant execute on function public.import_menu(uuid, boolean, jsonb) to service_role;

commit;

notify pgrst, 'reload schema';
