# Friday-rush load test report (2026-11-09)

Server: `next build && next start -p 3405` (Next 15.5, Node 24, macOS laptop), rate limiter off,
**mock in-memory driver** (the zero-env default), 800 orders pre-seeded, local only. Harness:
`loadtest/run.mjs` (see README). Raw numbers: `loadtest/results/mock-friday.json` (git-ignored; rerun to regenerate).

## Honest scope

- **Measured:** the Next.js app on the mock driver. **Not measured:** Postgres/PostgREST. No local Postgres
  or Supabase was reachable (port 5432 closed) and none was installed. Everything below about the
  Supabase driver comes from reading `src/lib/db/supabase.ts` and the routes, and is an estimate of
  round trips, not a timing.
- A real round trip to hosted Supabase is typically 5-30 ms, so the round-trip counts below are what
  matter. Run the harness against a disposable Supabase project to get real numbers.

## Results on the mock driver

Factor 1 = 3 locations x 120 orders/hour. Factor 3 = the requested 3x peak (1,080 orders/hour).

| Factor | Orders/hour | Req/s | Errors | Flows failed |
|---|---|---|---|---|
| 1x | 360 | 3 | 0% | 0 |
| 3x (target) | 1,080 | 4 | 0% | 0 |
| 10x | 3,600 | 8 | 0% | 0 |
| 30x | 10,800 | 15 | 0% | 0 |
| 100x | 36,000 | 53 | 0% | 0 |
| 300x | 108,000 | 139 | 0% | 0 |
| 1000x | 360,000 | 457 | 0% | 0 (2,966 order flows) |

**Breaking point on the mock: not reached.** Even at 1000x (about 100 orders/second) every endpoint
stayed under 150 ms max with zero errors; generator lag appeared only at 300x+ (p95 22 ms, 61 ms),
so the box was near its limit as a generator, not the server. 3x peak is 0.3 orders/second, trivial for
one Node process. The app code is not the bottleneck; the data layer will be.

Latency (ms) at the 3x target stage and at 1000x (p50 / p95 / p99):

| Endpoint | 3x | 1000x |
|---|---|---|
| POST /api/orders (till create) | 2.3 / 3.4 / 3.4 | 2.5 / 10.7 / 21.4 |
| POST /api/payments (cash) | 2.8 / 2.8 / 2.8 | 2.1 / 8.0 / 19.5 |
| POST /api/payments (card, simulated) | 2.1 / 2.5 / 2.5 | 2.0 / 8.5 / 18.1 |
| POST /api/shop/orders (storefront) | 2.1 / 2.3 / 2.3 | 2.1 / 8.7 / 23.9 |
| POST /api/payments (online, simulated) | 2.3 / 2.9 / 2.9 | 2.7 / 9.7 / 21.0 |
| POST /api/kitchen/orders (bump) | 2.0 / 2.6 / 28.6 | 1.7 / 8.5 / 20.9 |
| GET /api/kitchen/orders (KDS poll) | 2.2 / 4.7 / 9.5 | 5.8 / 19.9 / 87.6 |
| GET /api/orders/open | 2.8 / 7.9 / 7.9 | 3.4 / 11.1 / 11.1 |
| GET /api/delivery/dispatch | 1.8 / 2.9 / 9.1 | 2.1 / 7.5 / 17.1 |
| GET /api/shop/track (customer poll) | 1.4 / 2.0 / 2.0 | 1.7 / 9.0 / 18.3 |

Slowest path as history grows: the KDS poll (p99 87 ms at 1000x vs 9 ms at 3x), because it rebuilds
tickets from every order in memory. Server RSS went 447 MB to 686 MB at 1000x.

## What will hurt on Postgres: ranked fixes

Round-trip counts assume the real Supabase auth mode (`getCurrentUser`: 1 GoTrue call + memberships +
platform-admin) and one location with ~1,000 orders (about 8 hours at 120/hour).

1. **`assembleMenu` silently truncates menus (CORRECTNESS BUG, rank 1).** Its unfiltered `item_sizes`,
   `modifiers` and `item_modifier_groups` selects (no tenant filter, no `.range()` paging) hit PostgREST's
   1000-row `max_rows` cap platform-wide. Once the platform holds more than 1000 rows of any of them,
   tenants silently get menus missing sizes/modifiers, and repricing then rejects or mis-prices those
   items. Fix: scope by the tenant's ids and page with `fetchAllPages`. (Cost aspects are in fix 4.)
2. **KDS poll reads the whole order history (HIGH).** `GET /api/kitchen/orders` calls
   `driver.listOrders(tenant, location)` with no status filter and the default limit of 1,000
   (`supabase.ts` `listOrders`, then `readOrderRows`). `selectIn` fetches `order_items` in 100-order
   chunks and `order_item_modifiers` in 100-item chunks, **sequentially**: about 1 + 10 + 25 = 36
   queries, plus about 5 for auth/settings, so about 41 sequential round trips per poll (200-600 ms at
   5-15 ms each), then `buildTickets` discards everything not active. 2 screens x 3 locations at 4 s
   = 1.5 polls/s = about 60 queries/s for the kitchen alone, growing all day. Fix: add a
   `statuses` (or `created_at >= now - 24h`) filter to `listOrders`/a dedicated `listActiveOrders`, and
   run the `selectIn` chunks with `Promise.all`. With Supabase Realtime enabled (`getRealtimeProvider`
   picks it when the public Supabase env is set) every order write also triggers a debounced (150 ms)
   full board refetch per screen, so a burst is up to about 6 refetches/s/screen of the same 41-query
   read: the KDS fix matters even more there.
3. **Per-request auth and location check overhead (HIGH, cross-cutting).** Every authenticated route pays
   `auth.getUser()` (an external call) + `listMembershipsForUser` + `isPlatformAdmin`, and routes passing
   a `locationId` add `listLocations(tenant)` (`tenant-guard.ts` `grantFor` / `requireLocationInTenant`).
   About 4 round trips before any work, on every poll and every bump. Fix: verify the JWT locally
   (`getClaims`) and cache memberships + a tenant's location ids for 30-60 s.
4. **`assembleMenu` is 7 queries per call and 3 are not tenant-scoped (HIGH).** `item_sizes`, `modifiers`,
   `item_modifier_groups` are selected with no filter (whole platform), then filtered in memory with
   `.filter` per item (O(items x rows)). It runs on every order create (`priceOrder`), every storefront
   order, `/api/menu`, `/api/shop/location`. Cost grows with total platform menu size, not the tenant's.
   Fix: scope by the tenant's item/group ids, and cache the assembled menu per (tenant, location) for a
   short TTL, invalidated on menu/override writes.
5. **`createOrder` fan-out and order numbers (MEDIUM).** Per order: `select` existing, exact `count(*)`
   of every order at the location for `nextOrderNumber` (grows with history, and two concurrent tills
   can compute the same `A-####`, and `order_number` has no unique constraint, so colliding numbers are both inserted), insert, `writeOrderItems`, `readOrderRow` (2 queries), then
   `depleteForOrder`: `tenant_settings`, all `item_inventory_links` for the tenant, a sequential
   `resolveLocationInventory` per link, and `inventory_movements`. Roughly 12-25 round trips per order
   before pricing (which adds the 9 from the menu item). The order + lines write is not atomic (compensating
   delete). Fix: Postgres sequence / RPC for order numbers and for insert-order-with-lines; cache the
   tenant's inventory links.
6. **Kitchen bump (MEDIUM).** `requireOrderAccess` (auth 3 + `getOrder` 3 + `listLocations` 1), then
   `updateOrderStatus` (select + CAS update + `readOrderRow` 2): about 12 round trips per bump, and an
   order takes 3 bumps. At 3x peak that is small; it is the largest write-side count after order create.
7. **Dispatch board (MEDIUM, partly fixed here).** `GET /api/delivery/dispatch` did an N+1 (`getOrder`
   per delivery, 3 queries each) and `listDeliveries` is unbounded (every delivery ever). The N+1 is fixed
   in this PR (one `getOrdersByIds`). Still open: filter to active/recent deliveries and add a limit.
8. **Customer tracking poll (MEDIUM).** Each waiting customer polls `/api/shop/track` every 4 s
   (`getOrder` 3 queries + `getDeliveryForOrder` + more), unauthenticated. 100 customers waiting = about
   100+ queries/s. Fix: back off (4 s, 8 s, 15 s), pause when the tab is hidden, or rely on Realtime,
   and cache per order id for 2 s.
9. **Polling never pauses (LOW).** KDS (4 s), dispatch (5 s), open-orders (30 s), tracking (4 s) and the
   card-reader sync all poll regardless of tab visibility, and dispatch/KDS keep full-rate polling on
   hidden screens. Add `document.visibilityState` gating.
10. **Storefront order path (LOW-MEDIUM).** `POST /api/shop/orders` resolves the location (2-3 queries),
   subscription, entitlements, settings, menu (7), `ensureCustomer`, then `createOrder`: about 30
   round trips per web order. Same fixes as the menu and order-create items.
11. **Rate limits are per process (INFO).** `defaultLimiter` is in-memory, so on Vercel each instance has its own
    window and the limits do not hold across instances. Per-IP buckets (`orders` 60/min, `payments` 30/min,
    `cardSync` 600/min) are well above one location's 3x peak (6 orders/min) so they will not block
    normal service, but a shop's tills share one NAT IP, so a split-bill rush of 30+ tenders/min would
    get 429s. The harness runs with `RATE_LIMIT_DISABLED=1`.

## Changed in this PR

- `GET /api/delivery/dispatch`: replaced the per-delivery `getOrder` with one batched `getOrdersByIds`
  (same response shape; tenant-scoped by the driver). Verified on the mock with the harness; full unit
  suite, lint, typecheck and `next build` pass.
- Added `loadtest/` (harness, README, this report), `npm run loadtest` / `loadtest:serve`, and a
  `.gitignore` entry for `loadtest/results/`.

Everything else above is listed, not fixed: each touches driver semantics (filters, caching, sequences)
and needs a Postgres to validate.

## Next steps

1. Point the harness at a **disposable** Supabase project (local `supabase start` needs Docker, which this
   run did not touch) and rerun; the ranking above should be confirmed by per-endpoint p95 there.
2. Do the first four fixes first; they remove most round trips from polling and order creation.
