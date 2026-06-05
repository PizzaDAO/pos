# romana-66471 — Phase 5: Back office (tenant admin)

Tenant back office for the multi-tenant SaaS pizzeria POS, built under
`(admin)/admin` over the existing demo tenant (**Tony's Pizza**, 2 locations:
Downtown + Uptown). Everything flows through `getPosDriver()` / the DB
abstraction (mock driver today) so the Supabase driver drops in later unchanged.
Money is integer minor units (cents) throughout. **Builds, typechecks, lints,
and runs with ZERO env vars.**

## What was built

### 1. Menu management (CRUD + per-location overrides + 86)
- Full CRUD on the **tenant** menu: categories, items (half-and-half flag +
  KDS station), sizes/base prices, modifier groups (incl. `supports_half`), and
  modifiers — via `POST /api/admin/menu` (`{entity, action, payload}`).
- **Per-location overrides** (`location_menu_overrides` concept): price override
  (size / modifier) and availability toggle ("**86**") for items, sizes, and
  modifiers, via `/api/admin/overrides` (upsert / DELETE-to-clear).
- The mock driver folds overrides into `getMenu(...)`, so **terminal + shop
  reads reflect edits and 86s with no call-site change**. An 86'd item drops out
  of the menu graph for that location; an overridden size/modifier price
  replaces the base price for that location only.

### 2. Inventory (per location) — depletion + low-stock
- `inventory_items` (per location, with `low_threshold`), `inventory_movements`
  (audit ledger), and tenant-level `item_inventory_links` (recipe: a menu item /
  modifier consumes N of an inventory item per unit sold).
- **Sale-driven depletion** is wired into `createOrder` (the single funnel both
  the terminal and `/shop` land in): placing/paying an order walks its lines +
  modifiers, resolves each linked component's **per-location** stock row (by
  name), decrements it, and writes a `depletion` movement.
- Manual **restock / count adjustment / waste** movements + a "new item" form
  via `POST /api/admin/inventory`.
- **Low-stock alerts**: `listInventory` returns a derived `low` flag; the UI
  shows a banner + per-row badge. Seed deliberately puts Downtown **pepperoni**
  near threshold (600g, low at 500g) so ~2 pepperoni-pizza sales trip the alert.

### 3. Reports — per-location + tenant rollup
- `getSalesReport(tenantId, locationId | null, range)` — `locationId === null`
  produces the **tenant rollup** across all locations; a concrete id scopes to
  one. Pure derivation lives in `src/lib/reports.ts` (DB-agnostic).
- Slices: **by day / item / category / channel / location**, plus the
  **payment mix** (cash / card / crypto, by rail) with **tips**, **platform
  fees** (Connect `application_fee`), and **voids / refunds** tallies.
- Tips are sourced from order-level tips (online, folded into totals) **plus**
  payment-tender tips for in-store orders that have no order-level tip (avoids
  double-counting). Date-range filtering (`from` / `to`, inclusive yyyy-mm-dd).
- UI: KPI cards + **lightweight inline CSS bar charts** (no chart-lib dependency
  added — kept deps minimal per the brief).

### 4. Staff & shifts — clock in/out + drawer reconciliation
- `staff` (roles reuse the tenancy `MembershipRole`: owner/manager/cashier/
  kitchen), `shifts` (opening float + status), `shift_cash_events`
  (sale/payout/paid_in/drop).
- **Clock in/out** (idempotent open), record cash tenders/payouts during a
  shift, and **drawer reconciliation** at clock-out:
  `expected = float + cash sales + paid-in − payouts`, `over/short = counted −
  expected`. No real auth — a demo staff switcher per the scope guard.

### 5. End-of-day (Z-report) — idempotent close
- `business_day_closes` keyed `(location, business_date)`: **idempotent** close
  (re-closing returns the frozen snapshot). `/api/admin/eod` GET returns a live
  preview before close / the frozen report after.
- Z-report shows gross/net, tax, tips, fees, payment mix, voids/refunds, orders
  by channel, and a drawer summary; **printable** via browser print CSS
  (`print:hidden` chrome, clean receipt layout).

## Surface / routing
- `(admin)/admin/page.tsx` → `AdminShell` (tabbed: Menu, Inventory, Reports,
  Staff & shifts, End of day, plus the existing Phase 2 **Payments/Connect** and
  Phase 4 **Delivery dispatch** panels). Location selector in the header; the
  Reports tab adds a tenant-rollup scope.

## Files
**New libs/types**
- `src/lib/db/backoffice-types.ts` — menu CRUD inputs, overrides, inventory,
  staff/shifts, reconciliation, reports, EOD types.
- `src/lib/reports.ts` — pure `buildSalesReport` + label/family helpers.

**DB layer (extended)**
- `src/lib/db/driver.ts` — added menu-CRUD, override, inventory, report, EOD,
  and staff/shift methods to `PosDriver`.
- `src/lib/db/mock.ts` — mutable menu state cloned from seed; override-aware
  `getMenu`; inventory + depletion hook in `createOrder`; staff/shifts; reports;
  idempotent EOD.
- `src/lib/db/seed-data.ts` — inventory items (per location), recipe links, and
  demo staff.
- `src/lib/db/index.ts` — re-export back-office types.

**API routes (new)**
- `src/app/api/admin/menu/route.ts`, `.../overrides/route.ts`,
  `.../inventory/route.ts`, `.../reports/route.ts`, `.../staff/route.ts`,
  `.../eod/route.ts`.

**Admin UI (new)**
- `src/app/(admin)/admin/page.tsx` (rewired), and
  `src/app/(admin)/admin/components/{admin-shell,menu-manager,inventory-manager,
  reports-view,staff-shifts,end-of-day}.tsx`.

## Verification (local, no env vars)
- `npm run build`, `npm run typecheck` (`tsc --noEmit`), `npm run lint` — all
  green.
- Scripted e2e against `npm start`: created a category/item/size and saw it in
  `/api/menu`; set a per-location size price override (→750) and an item 86 (item
  hidden at that location); placed pepperoni orders → pepperoni 600→440 (low
  alert tripped) + dough decremented + depletion movements logged; paid (cash +
  tip) → order `paid`, report shows gross + tips + cash payment mix; tenant
  rollup returns `location_id: null` with by-location buckets; clocked a cashier
  in, recorded a cash sale, clocked out with an over/short of −$0.78; closed the
  business day (Z-report) and confirmed idempotent re-close.

## Scope notes
- No self-serve signup / Stripe Billing / super-admin (Phase 6); no live
  services / real Supabase / real auth. Payment + delivery logic is **read** for
  reports, never forked.
