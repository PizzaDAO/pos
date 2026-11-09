-- ============================================================================
-- Migration: menu_import
--
-- Back-office menu import (Square / Toast / Clover / generic CSV).
--
--   1. audit_action gains 'menu_import' (the app records one entry per apply).
--      Audit writes are fail-open, so until this value exists the entry would be
--      dropped silently: DEPLOY ORDER migration first, then code.
--   2. public.import_menu(p_tenant_id, p_changes): applies an import in ONE
--      transaction (a PostgREST client cannot span statements), serialised per
--      tenant by an advisory lock. The app builds the exact change set (ids
--      included):
--        insert  new rows
--        update  matched rows IN PLACE (ids kept, so carts, queued orders, /v1
--                carts, recipes and allergen rows keep pointing at live rows)
--        delete  rows absent from a "replace" file, plus the item_inventory_links,
--                menu_allergen_rows and location_menu_overrides rows of the
--                deleted items / sizes / modifiers
--      It refuses any row or id outside the tenant, and refuses inserts whose
--      name already exists (the menu changed since the preview: retry).
--      Historical orders are unaffected: order_items / order_item_modifiers
--      snapshot names, sizes and prices and keep item ids with NO foreign key.
--   3. core_trg_menu_structure skips per-row outbox emission while import_menu()
--      runs (it emits one menu.updated at the end; per-row emission was
--      quadratic, ~65 s for 2000 items). core_trg_menu_overrides: clearing an override whose target is already
--      gone (deleted in the same transaction) no longer emits
--      menu.item.available for a deleted item. Otherwise unchanged.
--
-- Additive and live-safe: an enum value + new/replaced functions; no table
-- changes. import_menu is callable only by service_role. Re-runnable.
-- ============================================================================

begin;
set local lock_timeout = '3s';

alter type public.audit_action add value if not exists 'menu_import';

create or replace function public.core_trg_menu_structure()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row jsonb;
  v_tenant uuid;
  v_item uuid;
  v_id uuid;
begin
  -- import_menu() sets this for its own transaction and emits ONE menu.updated
  -- at the end: per-row emission re-aggregates a growing changed_item_ids
  -- array on every row (quadratic: ~65 s for a 2000-item import on PGlite).
  if coalesce(current_setting('app.import_menu', true), '') <> '' then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  v_row := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;

  if tg_table_name = 'item_sizes' then
    v_item := (v_row ->> 'item_id')::uuid;
    select tenant_id into v_tenant from public.menu_items where id = v_item;
  elsif tg_table_name = 'modifiers' then
    select tenant_id into v_tenant from public.modifier_groups
      where id = (v_row ->> 'group_id')::uuid;
  else
    v_tenant := (v_row ->> 'tenant_id')::uuid;
    if tg_table_name = 'menu_items' then v_item := (v_row ->> 'id')::uuid; end if;
  end if;

  if v_tenant is not null and public.core_outbox_enabled() then
    -- attempts = 0 means no worker has claimed it yet: safe to extend.
    select id into v_id from public.core_outbox
     where tenant_id = v_tenant and event_type = 'menu.updated'
       and subject_type = 'menu' and subject_id = v_tenant
       and status = 'pending' and attempts = 0
     order by sequence desc
     limit 1
     for update skip locked;
    if v_id is not null then
      if v_item is not null then
        update public.core_outbox
           set row_snapshot = jsonb_build_object('changed_item_ids',
             (select coalesce(jsonb_agg(distinct x), '[]'::jsonb)
                from jsonb_array_elements_text(
                  coalesce(row_snapshot -> 'changed_item_ids', '[]'::jsonb)
                  || jsonb_build_array(v_item)) x))
         where id = v_id;
      end if;
    else
      perform public.core_emit(v_tenant, null, 'menu.updated', 'menu', v_tenant, null, null,
        jsonb_build_object('changed_item_ids',
          case when v_item is null then '[]'::jsonb else jsonb_build_array(v_item) end));
    end if;
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create or replace function public.core_trg_menu_overrides()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old_avail boolean;
  v_new_avail boolean;
  v_old_price integer;
  v_new_price integer;
  v_row public.location_menu_overrides;
  v_snap jsonb;
begin
  if tg_op = 'DELETE' then
    -- Clearing the override of a target that no longer exists (menu import /
    -- item delete removed it first) must not announce "available" for a ghost.
    if not exists (
      select 1 from (
        select id from public.menu_items where id = old.target_id and old.target_type = 'item'
        union all
        select id from public.item_sizes where id = old.target_id and old.target_type = 'size'
        union all
        select id from public.modifiers where id = old.target_id and old.target_type = 'modifier'
      ) t
    ) then
      return old;
    end if;
    v_row := old;
    v_old_avail := old.available; v_new_avail := null;
    v_old_price := old.price_cents; v_new_price := null;
  elsif tg_op = 'INSERT' then
    v_row := new;
    v_old_avail := null; v_new_avail := new.available;
    v_old_price := null; v_new_price := new.price_cents;
  else
    v_row := new;
    v_old_avail := old.available; v_new_avail := new.available;
    v_old_price := old.price_cents; v_new_price := new.price_cents;
  end if;

  v_snap := jsonb_build_object(
    'target_type', v_row.target_type,
    'target_id', v_row.target_id,
    'location_id', v_row.location_id);

  if (coalesce(v_old_avail, true)) is distinct from (coalesce(v_new_avail, true)) then
    perform public.core_emit(v_row.tenant_id, v_row.location_id,
      case when coalesce(v_new_avail, true) then 'menu.item.available'
           else 'menu.item.unavailable' end,
      'menu_item', v_row.target_id, null,
      jsonb_build_object('available', jsonb_build_array(coalesce(v_old_avail, true), coalesce(v_new_avail, true))),
      v_snap);
  end if;

  if v_old_price is distinct from v_new_price then
    perform public.core_emit(v_row.tenant_id, v_row.location_id, 'menu.updated',
      'menu', v_row.location_id, null, null,
      jsonb_build_object('changed_item_ids',
        case when v_row.target_type = 'item'
             then jsonb_build_array(v_row.target_id) else '[]'::jsonb end));
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;


-- Supersedes the earlier (uuid, boolean, jsonb) draft signature.
drop function if exists public.import_menu(uuid, boolean, jsonb);

create or replace function public.import_menu(
  p_tenant_id uuid,
  p_changes jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  ins jsonb := coalesce(p_changes -> 'insert', '{}'::jsonb);
  upd jsonb := coalesce(p_changes -> 'update', '{}'::jsonb);
  del jsonb := coalesce(p_changes -> 'delete', '{}'::jsonb);
  v_cats jsonb := coalesce(ins -> 'categories', '[]'::jsonb);
  v_items jsonb := coalesce(ins -> 'items', '[]'::jsonb);
  v_sizes jsonb := coalesce(ins -> 'sizes', '[]'::jsonb);
  v_groups jsonb := coalesce(ins -> 'modifierGroups', '[]'::jsonb);
  v_mods jsonb := coalesce(ins -> 'modifiers', '[]'::jsonb);
  v_links jsonb := coalesce(ins -> 'itemModifierGroups', '[]'::jsonb);
  d_cats uuid[];
  d_items uuid[];
  d_sizes uuid[];
  d_groups uuid[];
  d_mods uuid[];
  n integer;
begin
  if p_tenant_id is null or not exists (select 1 from public.tenants where id = p_tenant_id) then
    raise exception 'import_menu: unknown tenant';
  end if;
  -- One import per tenant at a time.
  perform pg_advisory_xact_lock(hashtextextended('import_menu:' || p_tenant_id::text, 0));
  -- Transaction-local: silences the per-row menu triggers (see above).
  perform set_config('app.import_menu', p_tenant_id::text, true);

  -- ---------------------------------------------------------------- deletes
  select coalesce(array_agg(distinct x::uuid), '{}') into d_cats
    from jsonb_array_elements_text(coalesce(del -> 'categories', '[]'::jsonb)) x;
  select coalesce(array_agg(distinct x::uuid), '{}') into d_groups
    from jsonb_array_elements_text(coalesce(del -> 'modifierGroups', '[]'::jsonb)) x;
  select coalesce(array_agg(distinct x::uuid), '{}') into d_items
    from jsonb_array_elements_text(coalesce(del -> 'items', '[]'::jsonb)) x;
  select coalesce(array_agg(distinct x::uuid), '{}') into d_sizes
    from jsonb_array_elements_text(coalesce(del -> 'sizes', '[]'::jsonb)) x;
  select coalesce(array_agg(distinct x::uuid), '{}') into d_mods
    from jsonb_array_elements_text(coalesce(del -> 'modifiers', '[]'::jsonb)) x;

  if (select count(*) from public.menu_categories where id = any(d_cats) and tenant_id = p_tenant_id) <> cardinality(d_cats)
     or (select count(*) from public.modifier_groups where id = any(d_groups) and tenant_id = p_tenant_id) <> cardinality(d_groups)
     or (select count(*) from public.menu_items where id = any(d_items) and tenant_id = p_tenant_id) <> cardinality(d_items)
     or (select count(*) from public.item_sizes s join public.menu_items i on i.id = s.item_id
          where s.id = any(d_sizes) and i.tenant_id = p_tenant_id) <> cardinality(d_sizes)
     or (select count(*) from public.modifiers m join public.modifier_groups g on g.id = m.group_id
          where m.id = any(d_mods) and g.tenant_id = p_tenant_id) <> cardinality(d_mods) then
    raise exception 'import_menu: row not found';
  end if;

  -- Everything that goes with a deleted parent.
  select coalesce(array_agg(distinct id), '{}') into d_items from (
    select unnest(d_items) as id
    union select id from public.menu_items where category_id = any(d_cats) and tenant_id = p_tenant_id
  ) t;
  select coalesce(array_agg(distinct id), '{}') into d_sizes from (
    select unnest(d_sizes) as id
    union select id from public.item_sizes where item_id = any(d_items)
  ) t;
  select coalesce(array_agg(distinct id), '{}') into d_mods from (
    select unnest(d_mods) as id
    union select id from public.modifiers where group_id = any(d_groups)
  ) t;

  delete from public.item_inventory_links
   where tenant_id = p_tenant_id
     and ((source_type = 'item' and source_id = any(d_items))
       or (source_type = 'modifier' and source_id = any(d_mods)));
  delete from public.menu_allergen_rows
   where tenant_id = p_tenant_id
     and ((target_type = 'item' and target_id = any(d_items))
       or (target_type = 'size' and target_id = any(d_sizes))
       or (target_type = 'modifier' and target_id = any(d_mods)));
  delete from public.item_modifier_groups l
   using jsonb_to_recordset(coalesce(del -> 'itemModifierGroups', '[]'::jsonb)) as r(item_id uuid, group_id uuid)
   where l.item_id = r.item_id and l.group_id = r.group_id
     and exists (select 1 from public.menu_items i where i.id = l.item_id and i.tenant_id = p_tenant_id);
  delete from public.item_sizes where id = any(d_sizes);
  delete from public.modifiers where id = any(d_mods);
  delete from public.menu_items where id = any(d_items) and tenant_id = p_tenant_id;
  delete from public.menu_categories where id = any(d_cats) and tenant_id = p_tenant_id;
  delete from public.modifier_groups where id = any(d_groups) and tenant_id = p_tenant_id;
  -- After the targets are gone, so core_trg_menu_overrides emits nothing for them.
  delete from public.location_menu_overrides
   where tenant_id = p_tenant_id
     and target_id = any(d_items || d_sizes || d_mods);

  -- ---------------------------------------------------------------- updates
  update public.menu_categories c set name = r.name, sort_order = r.sort_order
    from jsonb_to_recordset(coalesce(upd -> 'categories', '[]'::jsonb)) as r(id uuid, name text, sort_order integer)
   where c.id = r.id and c.tenant_id = p_tenant_id;
  get diagnostics n = row_count;
  if n <> jsonb_array_length(coalesce(upd -> 'categories', '[]'::jsonb)) then raise exception 'import_menu: row not found'; end if;

  update public.modifier_groups g
     set name = r.name, min_select = r.min_select, max_select = r.max_select, supports_half = r.supports_half
    from jsonb_to_recordset(coalesce(upd -> 'modifierGroups', '[]'::jsonb))
         as r(id uuid, name text, min_select integer, max_select integer, supports_half boolean)
   where g.id = r.id and g.tenant_id = p_tenant_id;
  get diagnostics n = row_count;
  if n <> jsonb_array_length(coalesce(upd -> 'modifierGroups', '[]'::jsonb)) then raise exception 'import_menu: row not found'; end if;

  update public.menu_items i
     set category_id = r.category_id, name = r.name, description = r.description,
         is_half_and_half_capable = r.is_half_and_half_capable, station = r.station
    from jsonb_to_recordset(coalesce(upd -> 'items', '[]'::jsonb))
         as r(id uuid, category_id uuid, name text, description text, is_half_and_half_capable boolean, station public.station)
   where i.id = r.id and i.tenant_id = p_tenant_id
     and exists (select 1 from public.menu_categories c where c.id = r.category_id and c.tenant_id = p_tenant_id);
  get diagnostics n = row_count;
  if n <> jsonb_array_length(coalesce(upd -> 'items', '[]'::jsonb)) then raise exception 'import_menu: row not found'; end if;

  update public.item_sizes s set name = r.name, price_cents = r.price_cents, sort_order = r.sort_order
    from jsonb_to_recordset(coalesce(upd -> 'sizes', '[]'::jsonb))
         as r(id uuid, name text, price_cents integer, sort_order integer)
   where s.id = r.id
     and exists (select 1 from public.menu_items i where i.id = s.item_id and i.tenant_id = p_tenant_id);
  get diagnostics n = row_count;
  if n <> jsonb_array_length(coalesce(upd -> 'sizes', '[]'::jsonb)) then raise exception 'import_menu: row not found'; end if;

  update public.modifiers m set name = r.name, price_cents = r.price_cents, sort_order = r.sort_order
    from jsonb_to_recordset(coalesce(upd -> 'modifiers', '[]'::jsonb))
         as r(id uuid, name text, price_cents integer, sort_order integer)
   where m.id = r.id
     and exists (select 1 from public.modifier_groups g where g.id = m.group_id and g.tenant_id = p_tenant_id);
  get diagnostics n = row_count;
  if n <> jsonb_array_length(coalesce(upd -> 'modifiers', '[]'::jsonb)) then raise exception 'import_menu: row not found'; end if;

  update public.item_modifier_groups l set sort_order = r.sort_order
    from jsonb_to_recordset(coalesce(upd -> 'itemModifierGroups', '[]'::jsonb))
         as r(item_id uuid, group_id uuid, sort_order integer)
   where l.item_id = r.item_id and l.group_id = r.group_id
     and exists (select 1 from public.menu_items i where i.id = l.item_id and i.tenant_id = p_tenant_id);
  get diagnostics n = row_count;
  if n <> jsonb_array_length(coalesce(upd -> 'itemModifierGroups', '[]'::jsonb)) then raise exception 'import_menu: row not found'; end if;

  -- ---------------------------------------------------------------- inserts
  if exists (select 1 from jsonb_populate_recordset(null::public.menu_categories, v_cats) r
              where r.tenant_id is distinct from p_tenant_id)
     or exists (select 1 from jsonb_populate_recordset(null::public.menu_items, v_items) r
              where r.tenant_id is distinct from p_tenant_id)
     or exists (select 1 from jsonb_populate_recordset(null::public.modifier_groups, v_groups) r
              where r.tenant_id is distinct from p_tenant_id) then
    raise exception 'import_menu: row belongs to another tenant';
  end if;

  -- The preview was built from a snapshot: if any name now exists, the menu
  -- changed (or a duplicate apply raced us). Refuse rather than duplicate.
  if exists (select 1 from jsonb_populate_recordset(null::public.menu_categories, v_cats) r
               join public.menu_categories c on c.tenant_id = p_tenant_id and lower(btrim(c.name)) = lower(btrim(r.name)))
     or exists (select 1 from jsonb_populate_recordset(null::public.modifier_groups, v_groups) r
               join public.modifier_groups g on g.tenant_id = p_tenant_id and lower(btrim(g.name)) = lower(btrim(r.name)))
     or exists (select 1 from jsonb_populate_recordset(null::public.menu_items, v_items) r
               join public.menu_items i on i.category_id = r.category_id and lower(btrim(i.name)) = lower(btrim(r.name)))
     or exists (select 1 from jsonb_populate_recordset(null::public.item_sizes, v_sizes) r
               join public.item_sizes s on s.item_id = r.item_id and lower(btrim(s.name)) = lower(btrim(r.name)))
     or exists (select 1 from jsonb_populate_recordset(null::public.modifiers, v_mods) r
               join public.modifiers m on m.group_id = r.group_id and lower(btrim(m.name)) = lower(btrim(r.name)))
     or exists (select 1 from jsonb_populate_recordset(null::public.item_modifier_groups, v_links) r
               join public.item_modifier_groups l on l.item_id = r.item_id and l.group_id = r.group_id) then
    raise exception 'import_menu: menu changed while importing, preview again';
  end if;

  insert into public.menu_categories
    select * from jsonb_populate_recordset(null::public.menu_categories, v_cats);
  insert into public.modifier_groups
    select * from jsonb_populate_recordset(null::public.modifier_groups, v_groups);
  insert into public.menu_items
    select * from jsonb_populate_recordset(null::public.menu_items, v_items);
  insert into public.item_sizes
    select * from jsonb_populate_recordset(null::public.item_sizes, v_sizes);
  insert into public.modifiers
    select * from jsonb_populate_recordset(null::public.modifiers, v_mods);
  insert into public.item_modifier_groups
    select * from jsonb_populate_recordset(null::public.item_modifier_groups, v_links);

  -- Foreign keys prove the parents exist; this proves they are THIS tenant's.
  if exists (select 1 from public.menu_items i
               join public.menu_categories c on c.id = i.category_id
              where i.tenant_id = p_tenant_id and c.tenant_id <> p_tenant_id)
     or exists (select 1 from public.item_sizes s
                  join public.menu_items i on i.id = s.item_id
                 where i.tenant_id <> p_tenant_id
                   and s.id in (select (x ->> 'id')::uuid from jsonb_array_elements(v_sizes) x))
     or exists (select 1 from public.modifiers m
                  join public.modifier_groups g on g.id = m.group_id
                 where g.tenant_id <> p_tenant_id
                   and m.id in (select (x ->> 'id')::uuid from jsonb_array_elements(v_mods) x))
     or exists (select 1 from public.item_modifier_groups l
                  join public.menu_items i on i.id = l.item_id
                  join public.modifier_groups g on g.id = l.group_id
                 where (i.tenant_id <> p_tenant_id or g.tenant_id <> p_tenant_id)
                   and (l.item_id, l.group_id) in (
                     select (x ->> 'item_id')::uuid, (x ->> 'group_id')::uuid
                       from jsonb_array_elements(v_links) x)) then
    raise exception 'import_menu: row references another tenant';
  end if;

  perform set_config('app.import_menu', '', true);
  if public.core_outbox_enabled() then
    perform public.core_emit(p_tenant_id, null, 'menu.updated', 'menu', p_tenant_id, null, null,
      jsonb_build_object('changed_item_ids', '[]'::jsonb));
  end if;

  return jsonb_build_object(
    'inserted', jsonb_build_object(
      'categories', jsonb_array_length(v_cats),
      'items', jsonb_array_length(v_items),
      'sizes', jsonb_array_length(v_sizes),
      'modifierGroups', jsonb_array_length(v_groups),
      'modifiers', jsonb_array_length(v_mods)),
    'deleted', jsonb_build_object(
      'items', cardinality(d_items),
      'sizes', cardinality(d_sizes),
      'modifiers', cardinality(d_mods))
  );
end;
$$;

revoke all on function public.import_menu(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.import_menu(uuid, jsonb) to service_role;

commit;

notify pgrst, 'reload schema';
