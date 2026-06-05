-- ============================================================================
-- Migration: least_privilege_grants
-- Corrective security migration — tighten anon/authenticated table grants and
-- scope the public storefront read policies to least privilege.
--
-- WHY (live-DB findings against the provisioned project, anon/public key):
--   1. The `anon` role held effectively ALL privileges on EVERY public table
--      (orders, payments, customers, memberships, audit_log, staff, …). RLS
--      still gated the rows, but a blanket table grant to the public role is a
--      serious footgun — one missing/permissive policy would expose PII or
--      allow writes. anon must hold SELECT on the storefront-public surface
--      ONLY, and nothing else.
--   2. `tenants_public_select` (roles=anon, qual=true) and
--      `locations_public_select` (roles=anon, qual=true) let the public read the
--      ENTIRE tenant + location registry of ALL tenants. The storefront only
--      needs to resolve ONE location by slug (which carries tenant_id) and that
--      location's menu — it never needs to enumerate the tenant registry.
--   3. `authenticated` likewise held over-broad grants (TRUNCATE/TRIGGER/
--      REFERENCES); trim to least-privilege DML (SELECT/INSERT/UPDATE/DELETE).
--
-- THE APP IS UNAFFECTED. The live data path is server-side via the SERVICE-ROLE
-- key (RLS-bypassing, with explicit tenant_id/location_id filters in
-- src/lib/db/supabase.ts). The storefront resolves the location, menu, and
-- settings SERVER-SIDE through getPosDriver() → service_role; it never uses the
-- anon role for reads or writes. The narrow anon SELECT grants below exist only
-- so the storefront menu surface COULD be read client-side with the anon key in
-- a future iteration without re-granting — they are not on the current app path.
--
-- Idempotent where reasonable: REVOKE/GRANT are naturally idempotent; policy
-- drops use IF EXISTS; the rescoped location policy is dropped-then-created.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) HARD RESET anon to zero, then GRANT only the storefront-public read surface.
--
-- `REVOKE ALL ... FROM anon` strips every table/sequence/function privilege the
-- over-broad domain migration handed out. We then re-grant SELECT to anon on the
-- exact set the public storefront needs to render a location's menu:
--   menu definition tables + per-location overrides + store_settings + the
--   single `locations` row (resolved by slug; carries tenant_id).
-- anon gets NO access to tenants, orders, payments, customers, memberships,
-- staff, subscriptions, audit_log, or any other operational/PII table.
-- ----------------------------------------------------------------------------
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
revoke all on all functions in schema public from anon;

-- usage on the schema is required to reference any object at all (kept).
grant usage on schema public to anon;

-- Storefront-public READ surface (SELECT only). No writes, ever, for anon.
grant select on
  public.menu_categories,
  public.menu_items,
  public.item_sizes,
  public.modifier_groups,
  public.modifiers,
  public.item_modifier_groups,
  public.location_menu_overrides,
  public.store_settings,
  public.locations
to anon;

-- ----------------------------------------------------------------------------
-- 2) Trim `authenticated` to least-privilege DML.
--
-- `REVOKE ALL` clears TRUNCATE/TRIGGER/REFERENCES (and any stray grants); we
-- then re-grant ONLY SELECT/INSERT/UPDATE/DELETE on the tenant-operational
-- tables. Rows stay fully gated by the RLS policies from the tenancy + domain
-- migrations — these grants only decide whether the role may touch the table at
-- all. usage on sequences is granted so INSERTs that rely on a default-nextval
-- column succeed (defensive; current schema uses uuid/gen_random_uuid PKs).
-- ----------------------------------------------------------------------------
revoke all on all tables in schema public from authenticated;
revoke all on all sequences in schema public from authenticated;

grant usage on schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;

-- Tenancy core tables.
grant select, insert, update, delete on
  public.tenants,
  public.locations,
  public.users,
  public.memberships,
  public.platform_admins
to authenticated;

-- Domain / operational tables.
grant select, insert, update, delete on
  public.menu_categories,
  public.menu_items,
  public.item_sizes,
  public.modifier_groups,
  public.modifiers,
  public.item_modifier_groups,
  public.location_menu_overrides,
  public.store_settings,
  public.payment_settings,
  public.orders,
  public.order_items,
  public.order_item_modifiers,
  public.payments,
  public.connect_accounts,
  public.customers,
  public.magic_link_tokens,
  public.deliveries,
  public.inventory_items,
  public.inventory_movements,
  public.item_inventory_links,
  public.staff,
  public.shifts,
  public.shift_cash_events,
  public.business_day_closes,
  public.subscriptions,
  public.tenant_onboarding,
  public.audit_log
to authenticated;

-- ----------------------------------------------------------------------------
-- 3) Drop the blanket tenant-registry read for anon.
--
-- `tenants_public_select` (anon, using true) let the public enumerate EVERY
-- tenant. The storefront does not need it: tenant resolution happens via the
-- public `locations` row (which carries tenant_id) read by the server, and any
-- genuinely-public tenant display field is surfaced through the location /
-- store_settings read path, not a blanket tenants read. Drop it entirely; the
-- member/admin `tenants_select` policy from the tenancy core remains intact, so
-- authenticated members and platform admins still read their own tenant.
-- ----------------------------------------------------------------------------
drop policy if exists tenants_public_select on public.tenants;

-- ----------------------------------------------------------------------------
-- 4) Rescope the public `locations` read for anon.
--
-- The original `locations_public_select` (anon, using true) exposed the FULL
-- location registry of ALL tenants. Replace it with a policy that still lets an
-- anonymous storefront visitor resolve a location by slug, but ONLY for
-- locations belonging to an ACTIVE tenant (a suspended/onboarding business
-- should not have a live public storefront). `locations` has no status column
-- of its own, so we gate on the parent tenant's status.
--
-- IMPORTANT: anon has NO grant on `public.tenants` (revoked above), so the
-- policy must NOT reference `tenants` directly — RLS policy expressions run with
-- the querying role's privileges, and a bare `select ... from tenants` as anon
-- would raise "permission denied". We therefore read the tenant status through a
-- SECURITY DEFINER helper (`is_active_tenant`), exactly as the tenancy/domain
-- policies read memberships via is_tenant_member()/has_tenant_role(). The helper
-- owner (the migration role) holds the read; anon only calls the function.
--
-- The tenancy-core `locations_select` (members + platform admins) is untouched;
-- PostgreSQL OR's permissive policies, so members/admins are unaffected.
-- ----------------------------------------------------------------------------
create or replace function public.is_active_tenant(target_tenant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.tenants t
    where t.id = target_tenant_id
      and t.status = 'active'
  );
$$;

-- anon must be able to CALL the helper (its body runs as the definer, so it
-- still cannot read tenants directly). authenticated/service_role inherit via
-- PUBLIC, but we grant explicitly for clarity.
grant execute on function public.is_active_tenant(uuid) to anon, authenticated;

drop policy if exists locations_public_select on public.locations;

create policy locations_public_select on public.locations
  for select
  to anon
  using (public.is_active_tenant(locations.tenant_id));

-- ----------------------------------------------------------------------------
-- NOTE on the menu / store_settings public SELECT policies.
--
-- The menu definition tables, location_menu_overrides, and store_settings keep
-- their `using (true)` SELECT policies from the domain RLS migration: these hold
-- no PII, a tenant's own menu is already public on its storefront, and they are
-- read-only for anon (writes remain owner/manager via the *_write policies).
-- We deliberately do NOT broaden anon beyond this surface. tenants/orders/
-- payments/customers/staff/memberships/subscriptions/audit_log have NO anon
-- grant and NO anon policy, so anon reads of them are denied at the grant layer
-- (permission denied) regardless of any future policy change — defense in depth.
-- ----------------------------------------------------------------------------
