# napoletana-99713 — Supabase persistence layer (schema + RLS + driver)

The final live-wiring step: build the **real Supabase driver + complete database
schema** so the feature-complete app can flip from the in-memory mock to live
persistence by setting env vars — without requiring those env vars to build (the
mock stays the zero-env default).

## Goal & invariants

- `getPosDriver()` selects the Supabase driver **iff** `NEXT_PUBLIC_SUPABASE_URL`
  + a key are present; otherwise the mock. Selection is **lazy** (read at call
  time, never at module load) so the build + the full Vitest suite + the preview
  pass with **zero env vars**.
- No UI/behaviour changes; no payment/delivery rail logic touched. Every existing
  call site is unchanged (both drivers implement the same `PosDriver`).
- Public repo: only blank `.env.example`. Money is integer minor units everywhere.

## Schema (migrations)

Two new timestamped migrations, after the tenancy core (`20260601*`):

- **`20260605000000_domain_core.sql`** — every domain table the mock implies,
  with enums mirroring the TS unions, FKs cascading from tenant/location, money
  as `integer` cents, jsonb for structured blobs (`totals`, `fulfillment`,
  report/drawer snapshots, rail `raw`, KDS thresholds), and indexes on
  `tenant_id`/`location_id` + common query paths. Tables:
  - Menu: `menu_categories`, `menu_items`, `item_sizes`, `modifier_groups`,
    `modifiers`, `item_modifier_groups`, `location_menu_overrides`.
  - Settings: `store_settings`, `payment_settings` (PK `(tenant_id, location_id)`).
  - Orders: `orders` (header + jsonb totals/fulfillment), `order_items`
    (denormalized line snapshot), `order_item_modifiers`.
  - Payments: `payments` (tender per row; client UUID PK = idempotency key),
    `connect_accounts`.
  - Online: `customers` (unique `(tenant_id, email)`), `magic_link_tokens`,
    `deliveries` (jsonb dropoff).
  - Inventory: `inventory_items`, `inventory_movements` (ledger),
    `item_inventory_links`.
  - Staff/cash: `staff`, `shifts`, `shift_cash_events`, `business_day_closes`
    (idempotent Z-report, unique `(location_id, business_date)`).
  - SaaS: `subscriptions` (one per tenant), `tenant_onboarding`, `audit_log`.
  Ids are uuid (text PK only for `subscriptions.id`, matching the `sub_*` ids).
  `orders.customer_id` FK is added after `customers` exists (forward-ref).

- **`20260605000100_domain_rls.sql`** — RLS **enabled + FORCED** on every table,
  keyed to `memberships` via the existing `is_tenant_member()` /
  `has_tenant_role()` / `is_platform_admin()` helpers, plus two new helpers:
  `is_self_customer(uuid)` and `can_read_order(uuid)` (lets a customer read the
  full graph of their own order).

## RLS / grants model for the new tables

- **Public storefront read** (least-privilege, deliberate): menu definition
  tables + `location_menu_overrides` + `store_settings` grant `SELECT` to `anon`
  with `using (true)` SELECT policies (the storefront renders for unauthenticated
  visitors; these hold no PII and a tenant's menu is already public on its
  storefront). `tenants`/`locations` get **additive** `anon`-only SELECT policies
  (PostgreSQL OR's permissive policies) for slug resolution — the member/admin
  policies from the tenancy core are untouched. All **writes** stay owner/manager.
- **Customer-owns-their-data**: `orders`/`payments`/`deliveries` add a read path
  for the order's own customer (`is_self_customer` / `can_read_order`); child
  tables (`order_items`, `order_item_modifiers`) are readable to whoever can read
  the parent order. A customer may also INSERT their own online order. All other
  order/payment/delivery writes are tenant-member only.
- **Everything else** (payment_settings, connect, inventory, staff, shifts,
  reports/close, subscriptions, onboarding) is tenant-member read / owner-manager
  write; `audit_log` is **platform-admin only**.
- **Explicit grants** (mirrors the tenancy migration): `authenticated` gets full
  DML on every domain table (rows gated by policies); `anon` gets `SELECT` only
  on the storefront-public surface.
- **Isolation test extended** (`supabase/tests/rls_isolation.sql`): adds menu +
  order + payment fixtures for both tenants and asserts member-A-sees-only-A
  orders/payments, blocked cross-tenant order write leaves no row, `anon` reads
  both menus but no orders/payments and cannot write the menu. Runs green in the
  optional non-blocking `rls-isolation` CI job (vanilla Postgres + auth shim).

## Driver design (`src/lib/db/supabase.ts`)

- `createSupabaseDriver(config)` builds one `@supabase/supabase-js` client lazily
  from env (`readSupabaseConfig()` prefers the **service-role** key server-side,
  else anon). Every tenant-scoped query carries an explicit `tenant_id`/
  `location_id` filter, so service-role use never crosses tenants even though it
  bypasses RLS (per supabase/README.md).
- Implements **every** `PosDriver` method (1:1 with the mock semantics):
  idempotent upsert-by-UUID for orders/payments/deliveries/customers; menu
  assembly folds per-location overrides + 86 exactly like `mock.assembleMenu`;
  inventory depletion walks links → resolves the location row by name → writes a
  signed movement + new level; reports reuse `buildSalesReport`/`isoDate` with
  DB-resolved category/location label maps; `closeBusinessDay` is idempotent.
- Row↔domain mappers normalise nullable columns to `null` and round-trip jsonb
  blobs verbatim, so both drivers return byte-identical objects to call sites.

## Apply + go-live

- `supabase/apply.sh` (+ `npm run db:apply`) applies all migrations in order
  (timestamp-sorted) then the seed against a `DATABASE_URL`; auto-detects
  `auth.uid()` (shim on vanilla Postgres, skip on real Supabase); `SKIP_SEED=1`
  for production.
- `supabase/seed.sql` expanded to the full demo (Tony's Pizza, 2 locations, full
  menu, owner+membership+platform admin, per-location store/payment settings with
  fulfillment/zones, inventory + recipe links + staff, onboarding + Pro
  subscription) — matches what the mock shows.
- Remaining go-live steps need live credentials only: provision project → set
  envs → `npm run db:apply` → wire Supabase Auth (`auth.uid() == users.id`) →
  run `run-rls-isolation.sh` green. Documented in `supabase/README.md` +
  `docs/PRODUCTION_READINESS.md`.

## Verification

- Local: `npm run build`, `typecheck`, `lint`, `test:run` all green with **no env**.
- DB: migrations + seed + extended isolation test applied to a throwaway
  Postgres via `supabase/tests/run-rls-isolation.sh` → "RLS isolation test PASSED".
- CI: required `build` + `test` green; optional `rls-isolation` job now covers
  orders/menu/payments.
