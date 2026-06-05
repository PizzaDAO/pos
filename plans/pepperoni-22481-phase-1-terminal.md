# pepperoni-22481 — Phase 1: Terminal Order Taking + Menu

**Priority:** P1 (first user-facing surface)
**Parent plan:** `../PLAN.md`
**Builds on:** Phase 0 (`margherita-60504`) scaffold + DB abstraction + interface contracts.

## Goal
Make `/terminal` a working, tablet-first, offline-first POS for taking pizza
orders against the sample menu — with a pizza builder (incl. half-and-half),
cart + totals, order placement, and an IndexedDB offline queue with idempotent
sync. **Supabase remains deferred:** everything runs against a new in-memory
mock DB driver behind the existing `src/lib/db` abstraction. Builds and runs
with **no env vars**.

## What was built

### Mock DB driver (Supabase still deferred)
- `src/lib/db/menu-types.ts` — DB-agnostic domain types for menu
  (categories/items/sizes/modifier groups/modifiers) and orders
  (`Order`, `OrderItem`, `OrderItemModifier` with `placement: left|right|whole`,
  `OrderTotals`, `CreateOrderInput`). All money is integer cents.
- `src/lib/db/driver.ts` — `PosDriver` interface: `getMenu`, `getStoreSettings`,
  `createOrder` (idempotent upsert-by-UUID), `getOrder`, `listOrders`.
- `src/lib/db/seed-data.ts` — in-memory mirror of `supabase/seed.sql`: Tony's
  Pizza, 2 locations, Margherita/Pepperoni + soda, sizes S/M/L, Crust/Sauce
  (whole-pie) + Toppings (half-and-half) modifier groups. Same UUIDs as the SQL
  seed. Exports `DEMO_CONTEXT` (hardcoded demo tenant + downtown location).
- `src/lib/db/mock.ts` — `mockDriver`: assembles the menu graph from seed data;
  keeps placed orders in a process-lifetime `Map` keyed by UUID. `createOrder`
  returns the existing order unchanged if the UUID already exists (idempotent).
- `src/lib/db/client.ts` — adds `getPosDriver()` selecting the mock driver
  today; a Supabase driver drops in here later with **no call-site changes**.
- `src/lib/db/index.ts` — re-exports the new modules + demo constants.

### Pricing (single source of truth)
- `src/lib/pricing.ts` — pure helpers: `computeUnitPriceCents`,
  `withLinePricing`, `computeSubtotalCents`, `computeOrderTotals`
  (subtotal → discount → taxable → tax (basis points, round-half-up) → total),
  `formatMoney`.
- `src/lib/build-line.ts` — turns builder selections into a priced `OrderItem`.
  Half placements (`left`/`right`) are charged at `ceil(price/2)`; `whole` is
  full price, so left+right of the same topping equals a whole topping.

### Terminal UI (`src/app/(terminal)/`)
- `terminal/page.tsx` → `components/terminal-client.tsx` orchestrates everything.
- `components/menu-browse.tsx` — category tabs + touch item grid.
- `components/pizza-builder.tsx` — size, crust, sauce, toppings with
  L/Whole/R toggles, quantity, special instructions, **live line-price preview**.
- `components/cart-panel.tsx` — lines with modifier/half summary, qty +/-, edit,
  **void line**, remove, **order-level discount**, totals breakdown, place order.
- `components/status-bar.tsx` — location + online/offline + pending-sync badge.
- `components/order-confirmation.tsx` — order number, total, synced/queued state.
- `src/lib/store/cart.ts` — Zustand cart store (lines, discount, notes; derived
  pricing recomputed on every mutation).
- `src/lib/store/use-menu.ts` — TanStack Query hook over `/api/menu`.

### Order placement
- `src/app/api/orders/route.ts` — `POST` (idempotent upsert via driver) + `GET`
  (recent orders). `src/app/api/menu/route.ts` — menu + settings (SW-cacheable).
- Place flow: generate client UUID (idempotency key) + a client order number →
  enqueue in IndexedDB → flush → clear cart → confirmation. Status `placed`.

### Offline-first / PWA
- `src/lib/offline/queue.ts` — Dexie/IndexedDB queue keyed by order UUID.
- `src/lib/offline/sync.ts` — `flushQueue()` POSTs pending entries to
  `/api/orders`; safe to run repeatedly (idempotent upsert-by-UUID).
- `src/lib/offline/use-offline-sync.ts` — online/offline tracking, pending count,
  flush on reconnect + interval, `placeOrderOffline` entry point.
- `src/app/sw.ts` + `next.config.ts` (Serwist) — precache app shell;
  StaleWhileRevalidate for `/api/menu` so the terminal loads offline.
- `src/app/manifest.ts` + `public/icons/*` — installable PWA manifest + icons.
- `src/app/(terminal)/layout.tsx` + `register-sw.tsx` — SW registration +
  tablet viewport (no pinch-zoom). SW generated only in production builds.

## Verification
- `npm install && npm run typecheck && npm run lint && npm run build` — all pass,
  **no env vars set**.
- `npm run start` + curl: `/terminal` renders; `/api/menu` returns the seeded
  menu (mock driver, tax 8.25%); posting a half-and-half order returns an order
  number; **posting the same UUID twice yields one order (no duplicate)**.

## Out of scope (later phases)
Real payments/tips (Phase 2 — tip is a 0 placeholder here), KDS (3), customer
shop (4), back-office CRUD (5), auth, live Supabase (last phase).
