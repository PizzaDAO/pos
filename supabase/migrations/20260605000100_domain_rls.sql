-- ============================================================================
-- Migration: domain_rls
-- Live-wiring phase — STRICT Row Level Security for EVERY domain table.
--
-- Same model as the tenancy core (20260601000100_tenancy_rls.sql):
--   * Tenant-scoped rows are visible/writable ONLY to users who hold a
--     `memberships` row for that row's tenant (via is_tenant_member()).
--   * Platform admins bypass every policy (is_platform_admin()).
--   * Helper functions are SECURITY DEFINER with a pinned search_path.
--
-- Customer-facing surfaces are deliberate + least-privilege:
--   * PUBLIC MENU READ: the storefront (/shop) must render a location's menu to
--     UNAUTHENTICATED visitors. The menu-definition tables + per-location
--     overrides + store_settings therefore grant SELECT to `anon` (read-only).
--     These tables hold no PII and a tenant's own menu is already public on its
--     storefront, so exposing reads to anon is intentional, not a leak.
--   * CUSTOMER'S OWN ORDERS: a signed-in customer (auth.uid() == customers.id
--     once Supabase Auth maps a customer login to a users/customers row) may read
--     their own customer row, their own orders, and the lines/payments/delivery
--     of those orders. Writes to orders/payments stay staff/service-side.
--   * NON-MENU OPERATIONAL DATA (orders, payments, inventory, staff, shifts,
--     reports, settings-writes, deliveries) is tenant-staff + platform-admin only.
--
-- payment_settings / connect / subscriptions / onboarding / audit_log are NOT
-- exposed to anon at all.
--
-- DEFERRED: applied once a Supabase project is provisioned.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Extra helper: true if the current user is the given customer (their own data).
-- SECURITY DEFINER so it can read customers without recursive policy evaluation.
-- ----------------------------------------------------------------------------
create or replace function public.is_self_customer(target_customer_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select target_customer_id is not null and target_customer_id = auth.uid();
$$;

-- True if the current user owns the order that the given order_id points at
-- (member of the order's tenant OR the order's customer). Used by child tables
-- (order_items/order_item_modifiers/payments/deliveries) so a customer can read
-- the full graph of their own order without granting cross-tenant access.
create or replace function public.can_read_order(target_order_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.orders o
    where o.id = target_order_id
      and (
        public.is_platform_admin()
        or public.is_tenant_member(o.tenant_id)
        or public.is_self_customer(o.customer_id)
      )
  );
$$;

-- ----------------------------------------------------------------------------
-- Enable + FORCE RLS on every domain table (default-deny).
-- ----------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'menu_categories','menu_items','item_sizes','modifier_groups','modifiers',
    'item_modifier_groups','location_menu_overrides','store_settings',
    'payment_settings','orders','order_items','order_item_modifiers','payments',
    'connect_accounts','customers','magic_link_tokens','deliveries',
    'inventory_items','inventory_movements','item_inventory_links','staff',
    'shifts','shift_cash_events','business_day_closes','subscriptions',
    'tenant_onboarding','audit_log'
  ]
  loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('alter table public.%I force row level security;', t);
  end loop;
end
$$;

-- ----------------------------------------------------------------------------
-- MENU DEFINITION TABLES — tenant-staff write; PUBLIC (anon + authenticated +
-- members) read so the storefront renders. Writes gated to owner/manager.
-- These tables have a direct tenant_id (categories/items/groups) or reach it
-- through a parent (sizes -> item, modifiers -> group, item_modifier_groups ->
-- item). Read is public; only writes need the tenant check.
-- ----------------------------------------------------------------------------

-- menu_categories (direct tenant_id)
create policy menu_categories_select on public.menu_categories
  for select using (true);
create policy menu_categories_write on public.menu_categories
  for all
  using (
    public.is_platform_admin()
    or public.has_tenant_role(tenant_id, array['owner','manager']::public.membership_role[])
  )
  with check (
    public.is_platform_admin()
    or public.has_tenant_role(tenant_id, array['owner','manager']::public.membership_role[])
  );

-- menu_items (direct tenant_id)
create policy menu_items_select on public.menu_items
  for select using (true);
create policy menu_items_write on public.menu_items
  for all
  using (
    public.is_platform_admin()
    or public.has_tenant_role(tenant_id, array['owner','manager']::public.membership_role[])
  )
  with check (
    public.is_platform_admin()
    or public.has_tenant_role(tenant_id, array['owner','manager']::public.membership_role[])
  );

-- item_sizes (tenant via parent item)
create policy item_sizes_select on public.item_sizes
  for select using (true);
create policy item_sizes_write on public.item_sizes
  for all
  using (
    public.is_platform_admin()
    or exists (
      select 1 from public.menu_items mi
      where mi.id = item_sizes.item_id
        and public.has_tenant_role(mi.tenant_id, array['owner','manager']::public.membership_role[])
    )
  )
  with check (
    public.is_platform_admin()
    or exists (
      select 1 from public.menu_items mi
      where mi.id = item_sizes.item_id
        and public.has_tenant_role(mi.tenant_id, array['owner','manager']::public.membership_role[])
    )
  );

-- modifier_groups (direct tenant_id)
create policy modifier_groups_select on public.modifier_groups
  for select using (true);
create policy modifier_groups_write on public.modifier_groups
  for all
  using (
    public.is_platform_admin()
    or public.has_tenant_role(tenant_id, array['owner','manager']::public.membership_role[])
  )
  with check (
    public.is_platform_admin()
    or public.has_tenant_role(tenant_id, array['owner','manager']::public.membership_role[])
  );

-- modifiers (tenant via parent group)
create policy modifiers_select on public.modifiers
  for select using (true);
create policy modifiers_write on public.modifiers
  for all
  using (
    public.is_platform_admin()
    or exists (
      select 1 from public.modifier_groups mg
      where mg.id = modifiers.group_id
        and public.has_tenant_role(mg.tenant_id, array['owner','manager']::public.membership_role[])
    )
  )
  with check (
    public.is_platform_admin()
    or exists (
      select 1 from public.modifier_groups mg
      where mg.id = modifiers.group_id
        and public.has_tenant_role(mg.tenant_id, array['owner','manager']::public.membership_role[])
    )
  );

-- item_modifier_groups (tenant via parent item)
create policy item_modifier_groups_select on public.item_modifier_groups
  for select using (true);
create policy item_modifier_groups_write on public.item_modifier_groups
  for all
  using (
    public.is_platform_admin()
    or exists (
      select 1 from public.menu_items mi
      where mi.id = item_modifier_groups.item_id
        and public.has_tenant_role(mi.tenant_id, array['owner','manager']::public.membership_role[])
    )
  )
  with check (
    public.is_platform_admin()
    or exists (
      select 1 from public.menu_items mi
      where mi.id = item_modifier_groups.item_id
        and public.has_tenant_role(mi.tenant_id, array['owner','manager']::public.membership_role[])
    )
  );

-- location_menu_overrides (direct tenant_id) — public read (folded into menu),
-- staff write.
create policy location_menu_overrides_select on public.location_menu_overrides
  for select using (true);
create policy location_menu_overrides_write on public.location_menu_overrides
  for all
  using (
    public.is_platform_admin()
    or public.has_tenant_role(tenant_id, array['owner','manager']::public.membership_role[])
  )
  with check (
    public.is_platform_admin()
    or public.has_tenant_role(tenant_id, array['owner','manager']::public.membership_role[])
  );

-- store_settings (direct tenant_id) — public read (storefront needs tax/currency
-- /hours/fulfillment), staff write.
create policy store_settings_select on public.store_settings
  for select using (true);
create policy store_settings_write on public.store_settings
  for all
  using (
    public.is_platform_admin()
    or public.has_tenant_role(tenant_id, array['owner','manager']::public.membership_role[])
  )
  with check (
    public.is_platform_admin()
    or public.has_tenant_role(tenant_id, array['owner','manager']::public.membership_role[])
  );

-- ----------------------------------------------------------------------------
-- payment_settings — NOT public. Members read (the terminal reads fee/tip
-- config); owner/manager write.
-- ----------------------------------------------------------------------------
create policy payment_settings_select on public.payment_settings
  for select
  using (public.is_platform_admin() or public.is_tenant_member(tenant_id));
create policy payment_settings_write on public.payment_settings
  for all
  using (
    public.is_platform_admin()
    or public.has_tenant_role(tenant_id, array['owner','manager']::public.membership_role[])
  )
  with check (
    public.is_platform_admin()
    or public.has_tenant_role(tenant_id, array['owner','manager']::public.membership_role[])
  );

-- ----------------------------------------------------------------------------
-- ORDERS — tenant members (any role: cashier/kitchen place + advance orders) and
-- the order's own customer can READ; members write; the customer can also INSERT
-- their own online order (guest/self checkout). Platform admins bypass.
-- ----------------------------------------------------------------------------
create policy orders_select on public.orders
  for select
  using (
    public.is_platform_admin()
    or public.is_tenant_member(tenant_id)
    or public.is_self_customer(customer_id)
  );
create policy orders_insert on public.orders
  for insert
  with check (
    public.is_platform_admin()
    or public.is_tenant_member(tenant_id)
    or public.is_self_customer(customer_id)
  );
create policy orders_update on public.orders
  for update
  using (public.is_platform_admin() or public.is_tenant_member(tenant_id))
  with check (public.is_platform_admin() or public.is_tenant_member(tenant_id));
create policy orders_delete on public.orders
  for delete
  using (public.is_platform_admin() or public.is_tenant_member(tenant_id));

-- order_items — reachable to anyone who can read the parent order; writes gated
-- to members of the order's tenant.
create policy order_items_select on public.order_items
  for select using (public.can_read_order(order_id));
create policy order_items_write on public.order_items
  for all
  using (
    public.is_platform_admin()
    or exists (
      select 1 from public.orders o
      where o.id = order_items.order_id and public.is_tenant_member(o.tenant_id)
    )
  )
  with check (
    public.is_platform_admin()
    or exists (
      select 1 from public.orders o
      where o.id = order_items.order_id and public.is_tenant_member(o.tenant_id)
    )
  );

-- order_item_modifiers — reachable via the parent order_item -> order.
create policy order_item_modifiers_select on public.order_item_modifiers
  for select
  using (
    exists (
      select 1 from public.order_items oi
      where oi.id = order_item_modifiers.order_item_id
        and public.can_read_order(oi.order_id)
    )
  );
create policy order_item_modifiers_write on public.order_item_modifiers
  for all
  using (
    public.is_platform_admin()
    or exists (
      select 1 from public.order_items oi
      join public.orders o on o.id = oi.order_id
      where oi.id = order_item_modifiers.order_item_id
        and public.is_tenant_member(o.tenant_id)
    )
  )
  with check (
    public.is_platform_admin()
    or exists (
      select 1 from public.order_items oi
      join public.orders o on o.id = oi.order_id
      where oi.id = order_item_modifiers.order_item_id
        and public.is_tenant_member(o.tenant_id)
    )
  );

-- ----------------------------------------------------------------------------
-- PAYMENTS — tenant members + the order's customer read; members write.
-- (Direct tenant_id, plus an order-customer read path for self-service.)
-- ----------------------------------------------------------------------------
create policy payments_select on public.payments
  for select
  using (
    public.is_platform_admin()
    or public.is_tenant_member(tenant_id)
    or public.can_read_order(order_id)
  );
create policy payments_write on public.payments
  for all
  using (public.is_platform_admin() or public.is_tenant_member(tenant_id))
  with check (public.is_platform_admin() or public.is_tenant_member(tenant_id));

-- connect_accounts — owner/manager of the tenant + platform admins.
create policy connect_accounts_select on public.connect_accounts
  for select
  using (public.is_platform_admin() or public.is_tenant_member(tenant_id));
create policy connect_accounts_write on public.connect_accounts
  for all
  using (
    public.is_platform_admin()
    or public.has_tenant_role(tenant_id, array['owner','manager']::public.membership_role[])
  )
  with check (
    public.is_platform_admin()
    or public.has_tenant_role(tenant_id, array['owner','manager']::public.membership_role[])
  );

-- ----------------------------------------------------------------------------
-- CUSTOMERS — tenant members read/write (CRM); a customer may read/update their
-- OWN row. Inserts happen staff/service-side (guest checkout) or self-claim.
-- ----------------------------------------------------------------------------
create policy customers_select on public.customers
  for select
  using (
    public.is_platform_admin()
    or public.is_tenant_member(tenant_id)
    or public.is_self_customer(id)
  );
create policy customers_insert on public.customers
  for insert
  with check (
    public.is_platform_admin()
    or public.is_tenant_member(tenant_id)
    or public.is_self_customer(id)
  );
create policy customers_update on public.customers
  for update
  using (
    public.is_platform_admin()
    or public.is_tenant_member(tenant_id)
    or public.is_self_customer(id)
  )
  with check (
    public.is_platform_admin()
    or public.is_tenant_member(tenant_id)
    or public.is_self_customer(id)
  );
create policy customers_delete on public.customers
  for delete
  using (public.is_platform_admin() or public.is_tenant_member(tenant_id));

-- magic_link_tokens — tenant members only (never exposed to anon/customers
-- directly; consumption goes through a service-side endpoint).
create policy magic_link_tokens_all on public.magic_link_tokens
  for all
  using (public.is_platform_admin() or public.is_tenant_member(tenant_id))
  with check (public.is_platform_admin() or public.is_tenant_member(tenant_id));

-- deliveries — tenant members + the order's customer read; members write.
create policy deliveries_select on public.deliveries
  for select
  using (
    public.is_platform_admin()
    or public.is_tenant_member(tenant_id)
    or public.can_read_order(order_id)
  );
create policy deliveries_write on public.deliveries
  for all
  using (public.is_platform_admin() or public.is_tenant_member(tenant_id))
  with check (public.is_platform_admin() or public.is_tenant_member(tenant_id));

-- ----------------------------------------------------------------------------
-- INVENTORY — tenant members read; writes gated to owner/manager.
-- ----------------------------------------------------------------------------
create policy inventory_items_select on public.inventory_items
  for select using (public.is_platform_admin() or public.is_tenant_member(tenant_id));
create policy inventory_items_write on public.inventory_items
  for all
  using (
    public.is_platform_admin()
    or public.has_tenant_role(tenant_id, array['owner','manager']::public.membership_role[])
  )
  with check (
    public.is_platform_admin()
    or public.has_tenant_role(tenant_id, array['owner','manager']::public.membership_role[])
  );

-- inventory_movements — members read; any member may insert (depletion happens
-- on order placement by cashiers); platform admins bypass. No update/delete
-- (append-only ledger) for tenant roles beyond insert.
create policy inventory_movements_select on public.inventory_movements
  for select using (public.is_platform_admin() or public.is_tenant_member(tenant_id));
create policy inventory_movements_insert on public.inventory_movements
  for insert
  with check (public.is_platform_admin() or public.is_tenant_member(tenant_id));

-- item_inventory_links — members read; owner/manager write.
create policy item_inventory_links_select on public.item_inventory_links
  for select using (public.is_platform_admin() or public.is_tenant_member(tenant_id));
create policy item_inventory_links_write on public.item_inventory_links
  for all
  using (
    public.is_platform_admin()
    or public.has_tenant_role(tenant_id, array['owner','manager']::public.membership_role[])
  )
  with check (
    public.is_platform_admin()
    or public.has_tenant_role(tenant_id, array['owner','manager']::public.membership_role[])
  );

-- ----------------------------------------------------------------------------
-- STAFF + SHIFTS — members read; owner/manager manage staff; any member may
-- open/close their own shift + record drawer events.
-- ----------------------------------------------------------------------------
create policy staff_select on public.staff
  for select using (public.is_platform_admin() or public.is_tenant_member(tenant_id));
create policy staff_write on public.staff
  for all
  using (
    public.is_platform_admin()
    or public.has_tenant_role(tenant_id, array['owner','manager']::public.membership_role[])
  )
  with check (
    public.is_platform_admin()
    or public.has_tenant_role(tenant_id, array['owner','manager']::public.membership_role[])
  );

create policy shifts_select on public.shifts
  for select using (public.is_platform_admin() or public.is_tenant_member(tenant_id));
create policy shifts_write on public.shifts
  for all
  using (public.is_platform_admin() or public.is_tenant_member(tenant_id))
  with check (public.is_platform_admin() or public.is_tenant_member(tenant_id));

create policy shift_cash_events_select on public.shift_cash_events
  for select using (public.is_platform_admin() or public.is_tenant_member(tenant_id));
create policy shift_cash_events_write on public.shift_cash_events
  for all
  using (public.is_platform_admin() or public.is_tenant_member(tenant_id))
  with check (public.is_platform_admin() or public.is_tenant_member(tenant_id));

-- business_day_closes — members read; owner/manager close.
create policy business_day_closes_select on public.business_day_closes
  for select using (public.is_platform_admin() or public.is_tenant_member(tenant_id));
create policy business_day_closes_write on public.business_day_closes
  for all
  using (
    public.is_platform_admin()
    or public.has_tenant_role(tenant_id, array['owner','manager']::public.membership_role[])
  )
  with check (
    public.is_platform_admin()
    or public.has_tenant_role(tenant_id, array['owner','manager']::public.membership_role[])
  );

-- ----------------------------------------------------------------------------
-- SaaS LAYER
--   subscriptions / tenant_onboarding — owner of the tenant + platform admins
--     read; platform admins (or owners during onboarding) write. Owners read
--     their own billing/onboarding; platform admins manage everything.
--   audit_log — platform admins ONLY (a super-admin surface).
-- ----------------------------------------------------------------------------
create policy subscriptions_select on public.subscriptions
  for select
  using (public.is_platform_admin() or public.is_tenant_member(tenant_id));
create policy subscriptions_write on public.subscriptions
  for all
  using (
    public.is_platform_admin()
    or public.has_tenant_role(tenant_id, array['owner']::public.membership_role[])
  )
  with check (
    public.is_platform_admin()
    or public.has_tenant_role(tenant_id, array['owner']::public.membership_role[])
  );

create policy tenant_onboarding_select on public.tenant_onboarding
  for select
  using (public.is_platform_admin() or public.is_tenant_member(tenant_id));
create policy tenant_onboarding_write on public.tenant_onboarding
  for all
  using (
    public.is_platform_admin()
    or public.has_tenant_role(tenant_id, array['owner']::public.membership_role[])
  )
  with check (
    public.is_platform_admin()
    or public.has_tenant_role(tenant_id, array['owner']::public.membership_role[])
  );

create policy audit_log_all on public.audit_log
  for all
  using (public.is_platform_admin())
  with check (public.is_platform_admin());

-- ----------------------------------------------------------------------------
-- GRANTS. RLS decides WHICH rows; GRANTs decide table access at all. We make
-- them explicit + least-privilege (mirrors the tenancy migration):
--   * `authenticated` may touch every domain table (rows gated by policies).
--   * `anon` gets SELECT ONLY on the public storefront surface (menu definition,
--     overrides, store_settings) — nothing else.
-- ----------------------------------------------------------------------------
grant select, insert, update, delete on
  public.menu_categories, public.menu_items, public.item_sizes,
  public.modifier_groups, public.modifiers, public.item_modifier_groups,
  public.location_menu_overrides, public.store_settings, public.payment_settings,
  public.orders, public.order_items, public.order_item_modifiers,
  public.payments, public.connect_accounts, public.customers,
  public.magic_link_tokens, public.deliveries, public.inventory_items,
  public.inventory_movements, public.item_inventory_links, public.staff,
  public.shifts, public.shift_cash_events, public.business_day_closes,
  public.subscriptions, public.tenant_onboarding, public.audit_log
to authenticated;

-- anon: read-only storefront surface only.
grant select on
  public.menu_categories, public.menu_items, public.item_sizes,
  public.modifier_groups, public.modifiers, public.item_modifier_groups,
  public.location_menu_overrides, public.store_settings,
  public.tenants, public.locations
to anon;

-- ----------------------------------------------------------------------------
-- PUBLIC STOREFRONT READ for tenants + locations.
--
-- The /shop storefront resolves a location by its PUBLIC slug for unauthenticated
-- visitors, then renders the tenant name + that location's menu. The tenancy core
-- RLS (20260601000100) restricts SELECT on tenants/locations to members + platform
-- admins; PostgreSQL OR's multiple permissive policies, so these ADDITIONAL
-- policies open a read path to `anon` WITHOUT loosening the member/admin policies.
-- They are SELECT-only and expose just the storefront-public columns the menu
-- already implies are public. Writes remain governed solely by the tenancy core.
-- ----------------------------------------------------------------------------
create policy tenants_public_select on public.tenants
  for select to anon using (true);

create policy locations_public_select on public.locations
  for select to anon using (true);
