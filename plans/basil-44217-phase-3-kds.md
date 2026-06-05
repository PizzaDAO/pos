# basil-44217 — Phase 3: Kitchen Display System (KDS) + Tickets

**Priority:** P1 (kitchen operations surface)
**Parent plan:** `../PLAN.md`
**Builds on:** Phase 0 (foundations) + Phase 1 (terminal/cart/offline/mock DB) +
Phase 2 (payments behind env guards).

## Goal
Turn the `/kitchen` placeholder into a working Kitchen Display System: a live
ticket board fed by a **realtime abstraction** (polling now, Supabase Realtime
later), with bump/recall status flow, station routing, age coloring, and an
optional printed kitchen ticket. Like every prior phase it builds, type-checks,
lints, and runs the full flow with **zero env vars** (incl. the Vercel preview).
Supabase stays deferred — all state flows through the mock `PosDriver`.

## The core design rule: realtime without a live backend
Supabase Realtime is deferred, so components depend ONLY on a small realtime
provider seam (`src/lib/realtime/`) — never on a transport. We ship a **polling**
implementation today and document the **Supabase Realtime** swap:

- `realtime/provider.ts` — `RealtimeProvider.subscribe(topic, fetcher, listener,
  opts)` contract + snapshot types. The `fetcher` produces the current payload
  on demand; the listener fires once immediately, then on every change.
- `realtime/polling.ts` — `createPollingProvider()`: calls the fetcher on an
  interval (default 4s), de-dupes in-flight ticks, swallows transient errors.
  This is what drives the board today (re-fetches `/api/kitchen/orders`).
- `realtime/supabase.ts` — documented (stubbed) `createSupabaseRealtimeProvider`:
  initial load via the SAME fetcher, then `postgres_changes` on `orders` pushes a
  fresh snapshot. Identical `subscribe()` contract → no component changes.
- `realtime/index.ts` — `getRealtimeProvider()` selection seam (mirrors
  `getPosDriver()`); always returns the poller until a Supabase project + dep are
  wired. Reads no env at module load.

## What was built

### Domain types (extend, don't re-scaffold)
- `db/menu-types.ts` — added `Station` (`oven|cold|fryer|expo|none`) on
  `MenuItem`; `OrderItem.station` (optional on the wire for older/queued orders);
  `OrderStatus` gains `recall`; `KDS_ACTIVE_STATUSES` constant; `KdsThresholds`
  (`warn_seconds`/`urgent_seconds`) on `StoreSettings`.
- `db/seed-data.ts` — every item gets a `station`; added a **Sides** category
  with a Caesar Salad (`cold`) + Garlic Knots (`fryer`) so routing is
  demonstrable; store settings carry `kds_thresholds` (300s warn / 600s urgent).
- `build-line.ts` — pizza builder now stamps `station` onto each placed line, so
  orders from the terminal route correctly on the board.

### KDS logic (pure, server-shared)
- `kds/status.ts` — `nextBumpStatus` / `recallStatus` pure transitions:
  `placed|paid → in_kitchen → ready → completed`; recall pulls a `ready`/
  `completed` ticket back to `recall`. `statusLabel` for badges.
- `kds/board.ts` — `buildTickets` (elapsed time + age level + stations computed
  server-side so all screens color identically), `ageLevelFor`, `orderStations`,
  `lineMatchesStation`, `ticketsForStation`, `DEFAULT_KDS_THRESHOLDS`.
- `kds/types.ts` / `kds/format.ts` — ticket/board response shapes, elapsed +
  channel formatting, and `groupModifiersByPlacement` for half-and-half.
- `kds/use-kitchen-board.ts` — client hook that subscribes via
  `getRealtimeProvider()` and exposes `bump`/`recall`/`refresh`.

### API
- `api/kitchen/orders/route.ts` —
  - `GET` returns `{ tickets, driver, serverTime, thresholds }` (no-store).
  - `POST { id, action: "bump"|"recall" }` advances/re-opens status via
    `updateOrderStatus`. **Idempotent**: a no-op transition returns the order
    unchanged with `changed:false`, so double-taps/retries never corrupt state.

### UI (`(kitchen)/kitchen/`)
- `components/kitchen-board.tsx` — board client: station filter bar (narrows both
  visible tickets AND lines per ticket), responsive ticket grid, live indicator.
- `components/ticket-card.tsx` — age-colored card (green/yellow/red) with a
  **live-ticking** elapsed clock that re-colors between polls; bump/recall/print.
- `components/ticket-items.tsx` — line items with sizes, whole-pie modifiers, and
  **half-and-half** LEFT/RIGHT split rendering; station-aware filtering.
- `components/station-filter.tsx` — per-station selector with counts.
- `ticket/[id]/page.tsx` + `print-view.tsx` — print-friendly ticket route that
  auto-opens the browser print dialog; `globals.css` adds `@media print` rules.

### Printer seam (stub)
- `printing/provider.ts` — `TicketPrinter` interface + `browserPrinter` (the
  print route) and a documented `getTicketPrinter()` selection seam. A network
  printer (ESC/POS / CloudPRNT via `KITCHEN_PRINTER_URL`) drops in behind the
  same interface — documented, **not wired** (no device/env in preview).

### Mock seed for serverless (mock-only caveat)
- `db/kds-seed.ts` + `mock.ts` — Vercel lambdas are stateless, so the in-memory
  `orders` Map is empty on a cold start and the board would render blank. The
  mock driver **lazily seeds ~4 open kitchen orders** (varied ages → green/
  yellow/red, varied stations, statuses incl. one half-and-half pizza) on the
  first order read in a warm instance. Orders placed in the same warm instance
  appear alongside the seed. **This is mock-only and disappears once Supabase
  persists real orders.** Ages are relative to read-time so colors stay realistic.

## How bump/recall + station routing work
Bump advances an order one step along `placed/paid → in_kitchen → ready →
completed` (pure `nextBumpStatus`); recall returns a `ready`/`completed` ticket
to the distinct `recall` active state (`recallStatus`). Both POST to
`/api/kitchen/orders`, which calls the DB abstraction idempotently. Routing keys
off `menu_items.station` (carried onto `OrderItem.station`); the station filter
shows only tickets/lines for the chosen station, with `none` items (drinks)
hidden from station views.

## Serverless / mock caveat
The KDS demo orders + any placed orders live in a per-instance in-memory Map, so
they don't persist across serverless cold starts and aren't shared between
lambdas. The lazy seed keeps the board populated in every instance; status
changes are visible within the warm instance that served them. Real persistence
+ cross-screen realtime arrive when Supabase is wired (the polling provider swaps
for Supabase Realtime behind the existing `getRealtimeProvider()` seam).

## Scope guardrails honored
No customer shop (Phase 4), no back-office reports (Phase 5), no SaaS/billing
(Phase 6), no live services, no auth. Payment rails untouched. Tenancy uses the
existing demo tenant/location context (no switcher).

## Verification (local, zero env)
`npm install && npm run build && npm run typecheck && npm run lint` all pass.
Manual (`npm start`): `/kitchen` renders 4 seeded tickets; bump advances
`in_kitchen → ready → completed` (then no-op idempotent); recall returns it to
`recall`; station counts oven 4 / cold 1 / fryer 1; half-and-half renders
left=mushrooms / right=sausage; `/kitchen/ticket/<id>` prints; age colors track
the 300s/600s thresholds.
