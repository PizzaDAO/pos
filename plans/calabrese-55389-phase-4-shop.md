# Phase 4 — Customer Online Ordering (`/shop`) + Delivery

Customer-facing online ordering for the multi-tenant pizzeria POS: a per-location
storefront, the reused pizza builder (incl. half-and-half), a separate customer
cart, checkout (pickup/delivery, scheduling, guest + magic-link account stub),
online payment via the existing rails, pluggable delivery providers (in-house
manual + DoorDash Drive), online orders flowing into the Phase 3 KDS, and live
customer order tracking via the realtime polling seam.

Builds entirely on the merged Phase 0–3 foundations. **No live services, no
secrets** — the whole flow (build → cart → checkout → pay → track) works with
ZERO env vars; every external integration falls back to a deterministic
simulation behind an env guard.

---

## What was built

### Storefront (`/shop/[location]`)
- `src/app/(shop)/shop/[location]/page.tsx` — server component resolves the public
  location **slug** via the DB abstraction (`getLocationBySlug`), 404s on a bad
  slug, and renders the mobile-first client.
- `components/shop-client.tsx` — branding header, menu browse, sticky cart bar.
  **Reuses the Phase 1 `MenuBrowse` and `PizzaBuilder` components verbatim** (incl.
  half-and-half topping placement) — no duplication.
- `components/customer-cart-panel.tsx` — cart drawer reading a **separate**
  customer cart store, with half-and-half rendering, qty steppers, edit/remove.
- `components/checkout-flow.tsx` — 4-step checkout: fulfillment + scheduling +
  address/zone-quote → identity (guest / magic-link) → payment (card / crypto) +
  tip → confirmation w/ a tracking link.
- `track/[orderId]/page.tsx` + `track-client.tsx` — live status timeline +
  delivery driver/ETA.

### Shared libs
- `src/lib/store/customer-cart.ts` — Zustand store (localStorage-persisted),
  **separate** from the terminal staff cart; reuses `@/lib/pricing` line math.
- `src/lib/store/use-shop.ts`, `use-shop-checkout.ts`, `use-order-tracking.ts` —
  data + checkout + tracking hooks.
- `src/lib/shop/scheduling.ts` — pure store-hours + prep/lead gating (ASAP +
  scheduled-slot generation). Handles windows that wrap past midnight.
- `src/lib/shop/auth.ts` — guest customer upsert + **simulated** magic-link
  (no email sent; the link is returned in the response so the flow is demoable).

### Delivery (`src/lib/delivery/`)
- `zones.ts` — pure zone resolution + `checkDeliverable` (out-of-zone /
  below-minimum). The single source of truth shared by the providers AND the
  storefront, so address validation and provider quotes agree by construction.
- `env.ts` — `getDoorDashConfig()` / `isDoorDashConfigured()` env guard (lazy,
  never read at module load).
- `errors.ts` — `DeliveryUnavailableError` (shared by providers/service/routes).
- `simulate.ts` — deterministic `sim_*` ids, simulated drivers, `sim://` refs.
- `providers/in-house-manual.ts` — computes zone/fee/ETA from store config
  (needs no env, always "real"); dispatch = queue for **manual assignment**.
- `providers/doordash-drive.ts` — REAL Drive quote→accept→track behind the env
  guard (JWT signed with `node:crypto`); simulated quote/dispatch/track otherwise.
- `providers/index.ts` + `registry.ts` — register both providers on import.
- `service.ts` — `quoteDelivery`, `dispatchDelivery` (idempotent on order id),
  `refreshDelivery`, `assignDriver`; `pickProvider` selects the first
  **available** provider from the location's configured preference list.

### Data layer (extended, not forked)
- `src/lib/db/customer-types.ts` — `Customer`, `MagicLinkToken`,
  `DeliveryRecord`.
- `menu-types.ts` — `FulfillmentSettings` (hours, prep, zones, providers) on
  `StoreSettings`; `OrderFulfillment` + `DeliveryAddress` + `customer_id` on
  `Order`/`CreateOrderInput`; `out_for_delivery` added to `KDS_ACTIVE_STATUSES`.
- `driver.ts` + `mock.ts` — new methods: `listLocations`, `getLocationBySlug`,
  customer upsert/lookup, magic-link create/consume, delivery upsert/list/lookup.
- `seed-data.ts` — Downtown = pickup + delivery (two postal-code zones,
  in-house + DoorDash); Uptown = pickup-only.

### KDS integration
- `kds/status.ts` — `nextBumpStatus(status, channel)`: a `ready` **delivery**
  ticket bumps to `out_for_delivery` (then `completed`); recall handles
  `out_for_delivery`; `statusLabel` covers it.
- API routes: `/api/shop/location`, `/api/shop/orders`, `/api/shop/track`,
  `/api/shop/auth/magic-link`, `/api/shop/auth/verify`, `/api/delivery/quote`,
  `/api/delivery/dispatch` (list + assign).
- `/admin` gains `delivery-dispatch.tsx` — the in-house dispatch board where a
  dispatcher assigns a driver (→ order `out_for_delivery`).

---

## DeliveryProvider env-guard / simulation design

Mirrors the Phase 2 payments design exactly:

- **In-house manual** needs no credentials — it derives zone/fee/ETA from the
  location's `fulfillment.delivery_zones` and is always "real". `dispatch`
  persists a `pending_assignment` `DeliveryRecord`; a human assigns the driver in
  `/admin`, which flips the order to `out_for_delivery`. `refreshDelivery` never
  overlays a simulated driver onto an in-house record (the record is authoritative).
- **DoorDash Drive** ships the real Drive integration (JWT auth, quote → accept →
  deliveries/track), gated by `DOORDASH_DEVELOPER_ID` / `DOORDASH_KEY_ID` /
  `DOORDASH_SIGNING_SECRET`. With any missing, every method returns a deterministic
  **simulated** quote/dispatch/track (fee/ETA derived from the zone so pricing
  stays consistent). `DOORDASH_BASE_URL` overrides the host.
- **Selection**: a location's `fulfillment.delivery_providers` is a preference
  list; `pickProvider` picks the first **registered/available** key. New providers
  = a new impl + a registry entry, no core changes.

## Zone gating

`checkDeliverable(zones, address, subtotal)` returns the serving zone or a typed
rejection (`out_of_zone` / `below_minimum`). It gates BOTH the live quote
(`/api/delivery/quote`) and the server-side order intake (`/api/shop/orders`),
so an out-of-zone or below-minimum address is rejected with a 422 + a precise
message — never trusting the client. Verified: 10001 → $3.99/30min quote;
99999 → rejected; 10010 with a $15 cart → "below the $20 minimum".

## How online orders reach the KDS

`/api/shop/orders` creates the order through the **same** `getPosDriver()`
abstraction the terminal uses, with `channel = online_pickup | online_delivery`
and `status = "placed"`. The Phase 3 KDS lists all active orders for the
location, so online tickets appear immediately (channel-labelled "Pickup" /
"Delivery"). Bump advances `placed → in_kitchen → ready → (out_for_delivery for
delivery) → completed`. Verified end-to-end.

## Tracking via the realtime seam

`use-order-tracking.ts` subscribes through `getRealtimeProvider()` (the Phase 3
polling seam) to `/api/shop/track`, which returns the order status + live
delivery state (`refreshDelivery` pulls provider tracking for DoorDash; in-house
state comes from the manual-assignment record). The same seam swaps to Supabase
Realtime later with no component changes.

## Reuse summary

- **Builder/pricing**: `MenuBrowse` + `PizzaBuilder` + `@/lib/build-line` +
  `@/lib/pricing` reused as-is (half-and-half included).
- **Payments**: online checkout posts to the existing `/api/payments` →
  `payments/service.ts` using the `stripe_online` (card-not-present on the
  connected account, with `application_fee`) and `crypto_onchain_usdc` rails —
  payment logic is NOT forked.
- **DB / realtime**: extended the existing `PosDriver` + mock driver and reused
  the realtime polling provider; no new transports.

## Env

`.env.example` documents the (all-optional) `DOORDASH_*` + `DOORDASH_BASE_URL`
delivery vars and the magic-link/customer-auth simulation, each with an
"absence → simulated" note. Build + preview work with zero env vars.
