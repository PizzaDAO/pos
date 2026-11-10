-- ============================================================================
-- Migration: menu_versions
--
-- Load-test fix (loadtest/REPORT.md, ranks 1 and 4): the Supabase driver caches
-- an assembled menu per (tenant, location) for a short time, and needs a cheap,
-- reliable "has this tenant's menu changed?" check to invalidate it.
--
--   public.menu_versions (tenant_id, version): bumped by STATEMENT-level
--   triggers on every table getMenu reads (menu_categories, menu_items,
--   item_sizes, modifier_groups, modifiers, item_modifier_groups,
--   location_menu_overrides), so every write path (driver, import_menu, 86,
--   overrides, SQL by hand) invalidates. One upsert per statement per tenant,
--   not per row, so a 2000-row import bumps once per statement.
--   No foreign key to tenants: a tenant delete cascades into the menu tables,
--   whose triggers must not fail on the vanishing tenant (an orphan version row
--   is harmless).
--
-- DEPLOY ORDER: code first, then this migration (without the table the driver
-- simply does not cache menus).
--
-- Additive and live-safe. Server-only table (RLS on + forced, no client
-- grants). Re-runnable.
-- ============================================================================

begin;
set local lock_timeout = '3s';

create table if not exists public.menu_versions (
  tenant_id uuid primary key,
  version bigint not null default 1,
  updated_at timestamptz not null default now()
);

alter table public.menu_versions enable row level security;
alter table public.menu_versions force row level security;
revoke all on public.menu_versions from public, anon, authenticated;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke insert, update, delete, truncate, trigger, references
      on public.menu_versions from service_role;
    grant select on public.menu_versions to service_role;
  end if;
end
$$;

-- tg_argv[0] says how a row reaches its tenant: 'tenant' (own tenant_id),
-- 'item' (item_id -> menu_items), 'group' (group_id -> modifier_groups).
create or replace function public.menu_bump_version()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows text := case when tg_op = 'DELETE' then 'old_rows' else 'new_rows' end;
  v_src text;
begin
  v_src := case tg_argv[0]
    when 'tenant' then format('select r.tenant_id from %I r', v_rows)
    when 'item' then format(
      'select m.tenant_id from %I r join public.menu_items m on m.id = r.item_id', v_rows)
    when 'group' then format(
      'select g.tenant_id from %I r join public.modifier_groups g on g.id = r.group_id', v_rows)
  end;
  execute format(
    'insert into public.menu_versions as v (tenant_id)
       select distinct s.tenant_id from (%s) s where s.tenant_id is not null
     on conflict (tenant_id) do update
       set version = v.version + 1, updated_at = now()', v_src);
  return null;
end;
$$;

revoke all on function public.menu_bump_version() from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.menu_bump_version() from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.menu_bump_version() from authenticated;
  end if;
end
$$;

do $$
declare
  t record;
begin
  for t in
    select * from (values
      ('menu_categories', 'tenant'),
      ('menu_items', 'tenant'),
      ('modifier_groups', 'tenant'),
      ('location_menu_overrides', 'tenant'),
      ('item_sizes', 'item'),
      ('item_modifier_groups', 'item'),
      ('modifiers', 'group')
    ) as v(tbl, via)
  loop
    execute format('drop trigger if exists %I on public.%I', t.tbl || '_menu_version_ins', t.tbl);
    execute format('drop trigger if exists %I on public.%I', t.tbl || '_menu_version_upd', t.tbl);
    execute format('drop trigger if exists %I on public.%I', t.tbl || '_menu_version_del', t.tbl);
    execute format(
      'create trigger %I after insert on public.%I referencing new table as new_rows
         for each statement execute function public.menu_bump_version(%L)',
      t.tbl || '_menu_version_ins', t.tbl, t.via);
    execute format(
      'create trigger %I after update on public.%I referencing new table as new_rows
         for each statement execute function public.menu_bump_version(%L)',
      t.tbl || '_menu_version_upd', t.tbl, t.via);
    execute format(
      'create trigger %I after delete on public.%I referencing old table as old_rows
         for each statement execute function public.menu_bump_version(%L)',
      t.tbl || '_menu_version_del', t.tbl, t.via);
  end loop;
end
$$;

commit;

notify pgrst, 'reload schema';
