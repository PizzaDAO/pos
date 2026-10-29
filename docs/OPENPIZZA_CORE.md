# Open Pizza core integration (POS-1 / POS-2 / POS-5 / POS-7)

POS is the **commerce source** (`source: "openpizza_pos"`) for `@openpizza/core` 0.1.0.
Other modules never read POS tables; they use the `/v1` contract and consume events.

## Dependency

`@openpizza/core` is vendored as `vendor/openpizza-core-<ver>.tgz` (`"file:vendor/..."` in
package.json; the lockfile has no path outside the repo). Update with
`npm run core:vendor -- <path to core/packages/core>` (re-packs, re-points, reinstalls).
Replace with a semver range once the package is on npm.

## `/api/v1/*` (src/lib/core/v1.ts)

One router for every op in `V1_ROUTES`; method, path and **required scopes come
from the package**. Note the base path is `/api/v1` (the package README mentions
`/api/op/v1`; pass `baseUrl: "https://<pos>/api/v1"` to `createHttpCoreClient`).

| Area | Ops |
| --- | --- |
| Read | tenant, capabilities, entitlements, locations (+get), menu (ETag/304), orders (list/get), payments, customers (list/get/lookup), staff, drawer sessions, deliveries (list/get), sales daily + summary |
| Write | `quotes.create` (stateless), `orders.create` (held by default), `orders.release`, `orders.cancel`, `menu.setAvailability` (86 / un-86) |
| 501 `CAPABILITY_UNSUPPORTED` | `orders.updateStatus`, `payments.recordExternal`, `customers.upsert`, `deliveries.updateStatus`, `events.list` (events go out by webhook) |

`quotes.get` answers `QUOTE_NOT_FOUND`: quotes are not stored. Send the cart to
`POST /orders`, optionally with `quote_hash` (stale hash -> `PRICE_CHANGED` with the
fresh quote in `details.quote`).

### Auth

`Authorization: Bearer <hub JWT>`, verified against `OPENPIZZA_HUB_JWKS_URL`
(ES256/RS256/EdDSA, WebCrypto, keys cached 10 min, refetched on unknown `kid`, with
exponential backoff and stale-key fallback when the hub is down).
Required: `aud = openpizza:api`, unexpired, and **`OPENPIZZA_HUB_ISSUER` whenever the JWKS URL
is set** (otherwise every request is rejected).

* **Tenant comes from the `tid` claim only.** No tenant parameter is read; ids that
  belong to another tenant answer `404`.
* `lids` restricts locations (lists are filtered, path locations answer `403`).
* Scopes are checked per route (`orders:read`, `quotes:write`, wildcards `*`,
  `orders:*`, `*:read`, `menu:write` implies `menu.availability:write`).
* **Simulated mode** (mock driver active, no JWKS URL, `VERCEL_ENV !== production`): the dev token
  `dev-openpizza-token` acts as the demo tenant with every scope. Setting a JWKS URL
  disables it.

### Mapping notes

* POS `order_status` is split onto `fulfillment_status` + `payment_status`
  (`fromPosOrderStatus`); the payment axis is derived from tenders (POS loses `paid`
  after `in_kitchen`). `draft` = `held`.
* `shifts` are exposed as `drawer_sessions`.
* POS items without sizes get one synthetic size `Regular` whose id is the item id.
* Required single-select modifier groups (`min_select >= 1`, `max_select = 1`)
  advertise their first option as `default_modifier_ids` (what the POS builder does).
* Item `kind` and modifier `role` are inferred from names (`role_inferred: true`).
* An order-level discount is exposed as one aggregated `pos.manual` adjustment;
  adjustment labels/sources sent on create are applied to pricing but not stored.
* Not supported on create yet: **delivery** fulfillment and `tax_exempt` (both 501),
  `fire_at`. `dine_in` is stored as pickup.

### Write guards

Parity with the security-branch routes: tenant must be `active` (else 403 on every write);
`adjustments` need the `orders:discount` scope; tips are capped (`maxTipCents`); anything
but a counter order is plan-gated (`canUseOnlineOrdering`); pickup/delivery enabled,
accepting orders, scheduling window and store hours come from `priceCart`. A **terminal**
principal (scope `orders:place_direct`, covered by `*`/`orders:*`) may place counter
(`in_store`) orders directly and skip hours; every other principal gets **held** orders
even for `pay_at_counter`, and `release` of an `awaiting_payment` hold needs full payment
coverage unless the token has `orders:release_unpaid`. Cancel refuses while any tender is
pending/authorized/requires_action. Release/cancel are compare-and-set on `status`
(`transitionOrderStatus`), inventory depletes only for the caller that won the transition.
Replays that hit an id outside the token's tenant/locations answer the same neutral
`IDEMPOTENCY_CONFLICT`. Bodies are stream-limited to 256 KB (413); bad percent-escapes are 400.

### Order writes

`POST /orders` prices with the canonical `priceCart` against the contract view of the
POS menu, then persists through the same repricing the terminal/shop use
(`priceOrder`). Both totals must agree or nothing is written (`INTERNAL`). Orders
are **held** (`draft`, hidden from the KDS) when `hold` is sent or `payment_intent`
is `prepaid` (default; 15 min `awaiting_payment`). A tender that covers the total
moves a held order to `paid` (POS payments service); `POST /orders/{id}/release`
sends it to the kitchen (idempotent; an expired hold voids the order). Inventory
depletes on release, not on hold. Replays are idempotent on the order `id` (or on
`Idempotency-Key`); reuse with different lines -> `IDEMPOTENCY_CONFLICT`.
Cancel is allowed before the kitchen and only when no captured money remains.

## Event outbox (src/lib/core/outbox.ts, migration `20260620000000_core_v1.sql`)

```
change (orders, payments, ...)  --AFTER trigger-->  core_outbox row  (same transaction)
cron  GET|POST /api/core/outbox  -> claim (SKIP LOCKED) -> hydrate contract payload
      -> sign (Standard Webhooks) -> POST OPENPIZZA_HUB_INGEST_URL
```

* Triggers: orders (`order.placed|updated|status_changed|ready|completed|canceled`;
  held orders are silent until released), payments (`payment.authorized|captured|failed|refunded`),
  menu overrides (`menu.item.unavailable|available`, price -> `menu.updated`), menu
  structure (`menu.updated`, debounced 1/min/tenant), locations + store settings
  (`location.updated`), customers, staff (`created|updated|deactivated`, PIN hash never
  stored), shifts (`drawer_session.opened|closed`), business day closes, deliveries.
* `sequence` is per tenant and gap-free (allocated in the same transaction).
* Event id `evt_<ULID>` is derived from the outbox row, so **retries carry the same
  id** (at-least-once; consumers dedupe on `id`).
* The payload is hydrated from **current** POS state at delivery time and validated
  by `createEvent` against the catalog schema; `subject.version` (orders) lets
  consumers drop stale events, `changes` keeps the original transition.
* Retry schedule is the package's `RETRY_SCHEDULE_SECONDS` (10s, 1m, 5m, 30m, 2h,
  6h, 12h, 24h) then `dead`. Rows whose subject was deleted are dead-lettered
  (`subject_gone`).
* **Enqueue switch:** triggers write rows only while `core_config.outbox_enabled = 'true'`;
  the cron sets it from the hub env (`core_set_outbox_enabled`), so an unconfigured POS never
  accumulates a backlog. Run the cron once after configuring the hub, before go-live.
* **Claim counts the attempt**, hydration is bounded (15 s) and a run has a 45 s budget, so a
  poison row ends dead-lettered. Retention (`core_outbox_prune`, run by the cron): delivered
  rows 7 d, dead 30 d, stale pending 3 d; snapshots are ids only (no PII) and are nulled once
  delivered. `menu.updated` coalesces into an unclaimed pending row and keeps all item ids.
* The per-tenant `sequence` upsert holds a row lock until the transaction ends; triggers emit
  last in their statement, and writers should keep transactions short.
* The mock store is never signed or sent (`deliverOutbox` returns `skipped: "mock_store"`).
* Schedule `/api/core/outbox` every minute (Vercel Cron on Pro, or an external
  scheduler) with `Authorization: Bearer $CRON_SECRET`. Not in `vercel.json` because
  Hobby only allows daily crons. With the hub env unset it is a no-op.
* Mock driver: `withOutbox()` appends the same rows in memory (`memoryOutbox`).

Not yet emitted: `tenant.module.*` and `entitlements.changed` (owned by core/billing,
POS-4), shift `drawer` cash events.

## Other changes

* `tenant_settings.inventory_owner` (`pos_basic` | `backofhouse`): with `backofhouse`
  POS no longer depletes inventory on sale/release. Exposed as
  `entitlements.modules.pos.config.inventory_owner`; set via
  `driver.setTenantSettings` (no admin UI yet).
* `staff.user_id` (login link) and `staff.location_ids` (POS-7).
* `orders.source` (jsonb), `orders.hold` (jsonb), `orders.version` (bumped by trigger).
* `locations.address_line1/2, city, region, postal_code, country, lat, lng`; the
  display `address` line is unchanged.
* Admin "Clock in / Clock out" is now "Open drawer / Close drawer" (the cash-drawer
  session); the time clock is owned by workforce.
* Mock ids are now real UUIDs (`genId`), and the KDS demo seed uses GUID ids, so mock
  data validates against the contract.
