-- ============================================================================
-- Migration: domain_core
-- Live-wiring phase — the FULL operational schema behind the PosDriver.
--
-- This migration introduces every domain table implied by the in-memory mock
-- driver (`src/lib/db/`): menu, orders, payments, customers, deliveries,
-- inventory, staff/shifts, reports/close-out, store/payment settings, and the
-- platform/SaaS layer (subscriptions, onboarding, audit log). RLS for these
-- tables lives in the next migration (`..._domain_rls.sql`) so the table DDL and
-- the security policies are reviewable independently — mirroring the split used
-- by the tenancy core.
--
-- Conventions (match the mock driver shapes exactly):
--   * Ids are uuid (the app already generates uuids for seeded rows; mock-only
--     prefixed ids like "ov-…" are mapped to uuids by the Supabase driver).
--   * Every tenant-scoped row carries tenant_id; location-scoped rows also carry
--     location_id. FKs cascade from tenant/location so deleting a tenant is clean.
--   * Money is ALWAYS integer minor units (cents) — never floats/numeric.
--   * Enums mirror the TypeScript string unions one-for-one.
--   * JSON blobs (totals, fulfillment, report snapshots, raw rail data) are
--     jsonb so the driver round-trips the exact mock object shapes.
--
-- DEFERRED: applied once a Supabase project is provisioned. See supabase/README.md.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Enums (mirror the TS string unions)
-- ----------------------------------------------------------------------------
create type public.station as enum ('oven', 'cold', 'fryer', 'expo', 'none');

create type public.order_status as enum (
  'draft', 'placed', 'paid', 'in_kitchen', 'ready', 'recall',
  'out_for_delivery', 'completed', 'voided', 'refunded'
);

create type public.order_channel as enum (
  'in_store', 'online_pickup', 'online_delivery'
);

create type public.override_target_type as enum ('item', 'size', 'modifier');

create type public.inventory_unit as enum ('each', 'g', 'kg', 'oz', 'lb', 'ml', 'l');

create type public.movement_reason as enum ('depletion', 'restock', 'adjustment', 'waste');

create type public.inventory_source_type as enum ('item', 'modifier');

create type public.shift_status as enum ('open', 'closed');

create type public.cash_event_type as enum ('sale', 'payout', 'paid_in', 'drop');

create type public.payment_status as enum (
  'requires_action', 'pending', 'authorized', 'captured',
  'failed', 'canceled', 'refunded'
);

create type public.payment_rail as enum (
  'stripe_terminal', 'stripe_online', 'crypto_onchain_usdc',
  'crypto_coinbase', 'cash'
);

create type public.connect_status as enum ('not_started', 'pending', 'connected', 'rejected');

create type public.delivery_record_status as enum (
  'quoted', 'pending_assignment', 'dispatched', 'assigned',
  'picked_up', 'delivering', 'delivered', 'canceled', 'failed'
);

create type public.plan_tier as enum ('starter', 'pro', 'multi');

create type public.subscription_status as enum ('trialing', 'active', 'past_due', 'canceled');

create type public.onboarding_step as enum (
  'business', 'location', 'connect', 'menu', 'plan', 'go_live'
);

create type public.audit_action as enum (
  'impersonate_start', 'impersonate_end', 'tenant_suspend',
  'tenant_reactivate', 'subscription_override'
);

-- ============================================================================
-- MENU
-- ============================================================================

-- ---- menu_categories -------------------------------------------------------
create table public.menu_categories (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  name text not null,
  sort_order integer not null default 0
);
create index menu_categories_tenant_id_idx on public.menu_categories (tenant_id);

-- ---- menu_items ------------------------------------------------------------
create table public.menu_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  category_id uuid not null references public.menu_categories (id) on delete cascade,
  name text not null,
  description text,
  is_half_and_half_capable boolean not null default false,
  station public.station not null default 'oven'
);
create index menu_items_tenant_id_idx on public.menu_items (tenant_id);
create index menu_items_category_id_idx on public.menu_items (category_id);

-- ---- item_sizes ------------------------------------------------------------
create table public.item_sizes (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.menu_items (id) on delete cascade,
  name text not null,
  price_cents integer not null,
  sort_order integer not null default 0
);
create index item_sizes_item_id_idx on public.item_sizes (item_id);

-- ---- modifier_groups -------------------------------------------------------
create table public.modifier_groups (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  name text not null,
  min_select integer not null default 0,
  max_select integer not null default 1,
  supports_half boolean not null default false
);
create index modifier_groups_tenant_id_idx on public.modifier_groups (tenant_id);

-- ---- modifiers -------------------------------------------------------------
create table public.modifiers (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.modifier_groups (id) on delete cascade,
  name text not null,
  price_cents integer not null default 0,
  sort_order integer not null default 0
);
create index modifiers_group_id_idx on public.modifiers (group_id);

-- ---- item_modifier_groups (item <-> group join) ----------------------------
create table public.item_modifier_groups (
  item_id uuid not null references public.menu_items (id) on delete cascade,
  group_id uuid not null references public.modifier_groups (id) on delete cascade,
  sort_order integer not null default 0,
  primary key (item_id, group_id)
);
create index item_modifier_groups_group_id_idx on public.item_modifier_groups (group_id);

-- ---- location_menu_overrides (per-location price/availability / "86") ------
create table public.location_menu_overrides (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  location_id uuid not null references public.locations (id) on delete cascade,
  target_type public.override_target_type not null,
  target_id uuid not null,
  price_cents integer,
  available boolean,
  updated_at timestamptz not null default now(),
  -- one override row per location+target.
  unique (location_id, target_type, target_id)
);
create index location_menu_overrides_tenant_location_idx
  on public.location_menu_overrides (tenant_id, location_id);

-- ============================================================================
-- STORE / PAYMENT SETTINGS (per tenant+location)
-- ============================================================================

-- store_settings — tax/currency/tip presets + KDS thresholds + fulfillment.
-- KDS thresholds + fulfillment are optional structured blobs kept as jsonb so
-- the driver round-trips the exact StoreSettings object the UI expects.
create table public.store_settings (
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  location_id uuid not null references public.locations (id) on delete cascade,
  currency text not null default 'USD',
  tax_rate_bps integer not null default 0,
  tip_presets_bps integer[] not null default '{}',
  kds_thresholds jsonb,
  fulfillment jsonb,
  primary key (tenant_id, location_id)
);

-- payment_settings — per-order platform-fee + tip config.
create table public.payment_settings (
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  location_id uuid not null references public.locations (id) on delete cascade,
  currency text not null default 'USD',
  platform_fee_bps integer not null default 250,
  platform_fee_flat_cents integer not null default 10,
  tip_presets_bps integer[] not null default '{}',
  primary key (tenant_id, location_id)
);

-- ============================================================================
-- ORDERS
-- ============================================================================

-- orders — header row. Line items live in order_items (+ order_item_modifiers)
-- as relational children; the computed totals + online fulfillment blob are
-- kept as jsonb (the driver re-derives totals on write, matching the mock).
create table public.orders (
  id uuid primary key,
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  location_id uuid not null references public.locations (id) on delete cascade,
  status public.order_status not null default 'placed',
  channel public.order_channel not null default 'in_store',
  currency text not null default 'USD',
  discount_cents integer not null default 0,
  totals jsonb not null,
  notes text,
  order_number text not null,
  -- customer_id FK added after the customers table is created (below).
  customer_id uuid,
  fulfillment jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index orders_tenant_location_idx on public.orders (tenant_id, location_id);
create index orders_status_idx on public.orders (tenant_id, location_id, status);
create index orders_created_at_idx on public.orders (tenant_id, location_id, created_at desc);
create index orders_customer_id_idx on public.orders (customer_id);

-- order_items — one row per cart/order line. Carries a denormalized snapshot of
-- the item (name/size/price) so historical orders are immutable to later menu
-- edits. `id` is the client-generated line id.
create table public.order_items (
  id uuid primary key,
  order_id uuid not null references public.orders (id) on delete cascade,
  item_id uuid not null,
  item_name text not null,
  station public.station,
  size_id uuid,
  size_name text,
  base_price_cents integer not null default 0,
  quantity integer not null default 1,
  notes text,
  voided boolean not null default false,
  unit_price_cents integer not null default 0,
  line_total_cents integer not null default 0,
  sort_order integer not null default 0
);
create index order_items_order_id_idx on public.order_items (order_id);

-- order_item_modifiers — selected modifiers on a line (incl. half placement),
-- with a denormalized price snapshot.
create table public.order_item_modifiers (
  id uuid primary key default gen_random_uuid(),
  order_item_id uuid not null references public.order_items (id) on delete cascade,
  group_id uuid not null,
  group_name text not null,
  modifier_id uuid not null,
  modifier_name text not null,
  price_cents integer not null default 0,
  placement text not null default 'whole', -- left | right | whole
  sort_order integer not null default 0
);
create index order_item_modifiers_order_item_id_idx
  on public.order_item_modifiers (order_item_id);

-- ============================================================================
-- PAYMENTS + STRIPE CONNECT
-- ============================================================================

-- payments — one tender per row (split payment => many rows per order). The
-- client UUID `id` is the idempotency key end-to-end.
create table public.payments (
  id uuid primary key,
  order_id uuid not null references public.orders (id) on delete cascade,
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  location_id uuid not null references public.locations (id) on delete cascade,
  rail public.payment_rail not null,
  status public.payment_status not null,
  amount_cents integer not null default 0,
  tip_cents integer not null default 0,
  application_fee_cents integer not null default 0,
  currency text not null default 'USD',
  charge_id text,
  connect_account_id text,
  crypto_tx_hash text,
  crypto_chain text,
  cash_tendered_cents integer,
  cash_change_cents integer,
  refunded_cents integer not null default 0,
  simulated boolean not null default true,
  raw jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index payments_order_id_idx on public.payments (order_id);
create index payments_tenant_location_idx on public.payments (tenant_id, location_id);
create index payments_charge_id_idx on public.payments (charge_id);

-- connect_accounts — per-tenant Stripe Connect onboarding status (one per tenant).
create table public.connect_accounts (
  tenant_id uuid primary key references public.tenants (id) on delete cascade,
  account_id text not null,
  status public.connect_status not null default 'not_started',
  charges_enabled boolean not null default false,
  payouts_enabled boolean not null default false,
  details_submitted boolean not null default false,
  simulated boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ============================================================================
-- CUSTOMERS + MAGIC LINKS + DELIVERIES (online ordering)
-- ============================================================================

-- customers — per-tenant online-ordering customers (same email at two tenants
-- = two rows). Email uniqueness is per tenant.
create table public.customers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  email text not null,
  name text,
  phone text,
  verified boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, email)
);
create index customers_tenant_id_idx on public.customers (tenant_id);

-- Now that customers exists, wire the deferred orders.customer_id FK.
alter table public.orders
  add constraint orders_customer_id_fkey
  foreign key (customer_id) references public.customers (id) on delete set null;

-- magic_link_tokens — stubbed sign-in tokens (never emailed).
create table public.magic_link_tokens (
  token text primary key,
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  email text not null,
  customer_id uuid not null references public.customers (id) on delete cascade,
  expires_at timestamptz not null,
  consumed boolean not null default false,
  created_at timestamptz not null default now()
);
create index magic_link_tokens_customer_id_idx on public.magic_link_tokens (customer_id);

-- deliveries — one per delivery order. dropoff address kept as jsonb.
create table public.deliveries (
  id uuid primary key,
  order_id uuid not null references public.orders (id) on delete cascade,
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  location_id uuid not null references public.locations (id) on delete cascade,
  provider text not null,
  status public.delivery_record_status not null default 'quoted',
  zone_id text,
  fee_cents integer not null default 0,
  currency text not null default 'USD',
  eta_minutes integer,
  provider_delivery_id text,
  tracking_ref text,
  dropoff jsonb not null,
  driver_name text,
  driver_phone text,
  simulated boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index deliveries_order_id_idx on public.deliveries (order_id);
create index deliveries_tenant_location_idx on public.deliveries (tenant_id, location_id);

-- ============================================================================
-- INVENTORY
-- ============================================================================

-- inventory_items — per-location stock.
create table public.inventory_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  location_id uuid not null references public.locations (id) on delete cascade,
  name text not null,
  unit public.inventory_unit not null default 'each',
  on_hand integer not null default 0,
  low_threshold integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index inventory_items_tenant_location_idx
  on public.inventory_items (tenant_id, location_id);

-- inventory_movements — append-only ledger.
create table public.inventory_movements (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  location_id uuid not null references public.locations (id) on delete cascade,
  inventory_item_id uuid not null references public.inventory_items (id) on delete cascade,
  reason public.movement_reason not null,
  delta integer not null,
  resulting_on_hand integer not null,
  order_id uuid references public.orders (id) on delete set null,
  note text,
  created_at timestamptz not null default now()
);
create index inventory_movements_tenant_location_idx
  on public.inventory_movements (tenant_id, location_id, created_at desc);
create index inventory_movements_item_idx
  on public.inventory_movements (inventory_item_id);

-- item_inventory_links — recipe links (tenant-level): a menu item/modifier
-- consumes N of an inventory item per unit sold.
create table public.item_inventory_links (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  source_type public.inventory_source_type not null,
  source_id uuid not null,
  inventory_item_id uuid not null references public.inventory_items (id) on delete cascade,
  qty_per_unit integer not null default 0
);
create index item_inventory_links_tenant_id_idx on public.item_inventory_links (tenant_id);
create index item_inventory_links_source_idx
  on public.item_inventory_links (tenant_id, source_type, source_id);

-- ============================================================================
-- STAFF + SHIFTS (cash drawer)
-- ============================================================================

create table public.staff (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  name text not null,
  role public.membership_role not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create index staff_tenant_id_idx on public.staff (tenant_id);

create table public.shifts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  location_id uuid not null references public.locations (id) on delete cascade,
  staff_id uuid not null references public.staff (id) on delete cascade,
  status public.shift_status not null default 'open',
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  opening_float_cents integer not null default 0,
  counted_cents integer,
  close_note text,
  created_at timestamptz not null default now()
);
create index shifts_tenant_location_idx on public.shifts (tenant_id, location_id);
create index shifts_open_idx on public.shifts (tenant_id, location_id, staff_id, status);

create table public.shift_cash_events (
  id uuid primary key default gen_random_uuid(),
  shift_id uuid not null references public.shifts (id) on delete cascade,
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  location_id uuid not null references public.locations (id) on delete cascade,
  type public.cash_event_type not null,
  amount_cents integer not null,
  order_id uuid references public.orders (id) on delete set null,
  note text,
  created_at timestamptz not null default now()
);
create index shift_cash_events_shift_id_idx on public.shift_cash_events (shift_id);

-- business_day_closes — idempotent Z-report close. report+drawer kept as jsonb
-- (the frozen snapshot at first close). One per (location, business_date).
create table public.business_day_closes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  location_id uuid not null references public.locations (id) on delete cascade,
  business_date date not null,
  closed_at timestamptz not null default now(),
  report jsonb not null,
  drawer jsonb not null,
  unique (location_id, business_date)
);
create index business_day_closes_tenant_location_idx
  on public.business_day_closes (tenant_id, location_id);

-- ============================================================================
-- PLATFORM / SaaS LAYER (subscriptions, onboarding, audit log)
-- ============================================================================

-- subscriptions — one per tenant (Stripe Billing — OUR revenue).
create table public.subscriptions (
  id text primary key,
  tenant_id uuid not null unique references public.tenants (id) on delete cascade,
  tier public.plan_tier not null,
  status public.subscription_status not null,
  current_period_end timestamptz not null,
  trial_end timestamptz,
  cancel_at_period_end boolean not null default false,
  simulated boolean not null default true,
  stripe_customer_id text,
  stripe_subscription_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index subscriptions_tenant_id_idx on public.subscriptions (tenant_id);

-- tenant_onboarding — wizard progress (one per tenant).
create table public.tenant_onboarding (
  tenant_id uuid primary key references public.tenants (id) on delete cascade,
  current_step public.onboarding_step not null default 'business',
  completed_steps public.onboarding_step[] not null default '{}',
  live boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- audit_log — append-only platform-operator actions (incl. impersonation).
-- Outside tenant scope (a platform-admin surface); tenant_id is the optional
-- target, not an ownership key.
create table public.audit_log (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid not null,
  actor_label text not null,
  action public.audit_action not null,
  tenant_id uuid references public.tenants (id) on delete set null,
  detail text,
  created_at timestamptz not null default now()
);
create index audit_log_tenant_id_idx on public.audit_log (tenant_id);
create index audit_log_created_at_idx on public.audit_log (created_at desc);
