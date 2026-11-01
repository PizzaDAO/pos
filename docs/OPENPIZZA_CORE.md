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
| Tenders + identity (phase 2) | `payments.recordExternal`, `customers.upsert`, `staff.verifyPin` (a HUB_ROUTES op, added to the table by hand), `staff.setPin` |
| 501 `CAPABILITY_UNSUPPORTED` | `orders.updateStatus`, `deliveries.updateStatus`, `events.list` (events go out by webhook) |

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

**Literal scopes.** `orders:discount`, `orders:place_direct` and `orders:release_unpaid` must be
granted BY NAME: `*`, `orders:*` and `*:write` do not imply them (the dev principal lists them
explicitly). Only a principal with `orders:place_direct` may choose a hold reason; for everyone
else any caller-supplied `hold.reason` is ignored and forced to `awaiting_payment`. `release`
requires full payment coverage for ANY hold reason unless the caller has `orders:release_unpaid`.
`cancel` runs in one SQL function (`core_cancel_order`) that locks the order row, checks in-flight
tenders, voids abandoned ones and transitions to voided atomically (mirrored in the mock driver).

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
Only `draft` (held), `placed` and `paid` orders are cancelable here; an online checkout still
`awaiting_payment` (main's storefront lifecycle) answers **409 `CANCEL_NOT_ALLOWED`** (the
storefront's own cancel abandons it). Cancel follows main's storefront order of steps: open
`stripe_online` intents are closed first (`cancelOpenOnlineIntents`; a provider failure is
`UPSTREAM_UNAVAILABLE`), the tenders are re-checked, `core_cancel_order` voids, and then the
order's delivery is canceled (`cancelDeliveryForOrder`; a provider error there is logged, the
order stays voided). A held order that main's payment path moves to `paid`
(`transitionOrderStatus(["draft","placed"], "paid")`) drops its `hold` and depletes then
(per-item idempotent, so a later `release` is a no-op). `release` counts captured tenders net
of `refunded_cents`.

Sales rollups (`/sales/summary`, `/locations/{id}/sales/daily`) drop unpaid online checkouts
(`awaiting_payment`, `abandoned`) before mapping, like main's reports: they are neither orders
nor voids.

## Event outbox (src/lib/core/outbox.ts, migrations `20261102000300_core_v1.sql` … `20261102000500_core_cancel_and_prune.sql`)

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
* **Announcement.** `orders.core_announced` is set (BEFORE trigger, never reset) the first time
  an order is in a live status (anything but `draft`, `awaiting_payment`, `voided`,
  `abandoned`, `refunded`). Leaving a never-announced state for a live one emits
  `order.placed` once (a released/paid hold, a paid checkout, and a late-payment Accept
  `abandoned -> paid`); ending a never-announced order (`voided`, `abandoned`, `refunded`)
  emits nothing. Only announced orders get `status_changed` / `updated` / `canceled`.
* `order.updated` fires for totals, notes, discount, customer and fulfillment changes, NOT for
  checkout bookkeeping inside `fulfillment` (`paid_at`, `finalized_at`, `late_payment`,
  `recovery_*`, `foreign_alerted_at`, `checkout_mode`).
* **Payment events only for announced orders.** While the order is `draft`,
  `awaiting_payment`, `abandoned`, or voided/refunded without ever being announced, tender
  changes are suppressed. A normal online payment is recorded BEFORE finalize moves the order
  to `paid`, so its `payment.captured` is suppressed; the `order.placed` that follows is hydrated
  from current state and its `tenders[]` (payment id, status, amount, tip, refunded) already
  carry it.
* **Failed refunds.** Cash/crypto refunds reserve first (`reserve_payment_refund` emits
  `payment.refunded`) and release on a rail failure (`release_payment_refund`: refunded_cents
  goes down, `refunded -> captured`). The release emits nothing and marks the still-unclaimed
  `payment.refunded` row `dead` (`last_error = 'retracted: refund released'`); only if a worker
  already claimed that row does it emit a corrective `payment.captured|authorized` with
  `changes.refunded_cents`. A retracted row's `sequence` is never delivered (like a dead row).
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
* **A cron is REQUIRED.** Nothing is delivered, pruned, or even enqueued until `/api/core/outbox`
  runs. The `outbox_enabled` flag lives in the database, which previews/branches may share with
  production, so only the production deployment (`VERCEL_ENV=production`) or an explicit
  `OUTBOX_OWNER=1` acts; every other deployment answers `{skipped:"not_outbox_owner"}`.
  `OUTBOX_PENDING_EXPIRY_DAYS` (default 7) controls when undelivered pending rows expire.
* Run budget: rows may START only within 25 s (hydrate 15 s + fetch 10 s on top, under
  `maxDuration=60`); claimed-but-unattempted rows are released without counting an attempt.
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

### Phase 2: external tenders, customer upsert, staff PIN

**`payments.recordExternal`** (`POST /orders/{id}/payments`). Money taken outside POS's
processors (kiosk card reader, cash on delivery, paid invoice, gift card) goes on the new
`external` rail (`payments.method/processor/processor_ref/collection/staff_id`; the ref is
NOT `charge_id`, which is the Stripe webhook key). Server-enforced:

* Scope: `payments:write`, or `payments.terminal:write` for a CAPTURED `collection: "terminal"`
  tender only. A terminal tender also needs the caller to be the device that took the order:
  the hub signs POS calls `sub = hub:<client id>`, and that id must equal `order.source.device_id`
  (fails closed when the order has none).
* The order must still take money (voided/abandoned/refunded = 409 `INVALID_TRANSITION`);
  amounts use core's `checkTenderAmounts` against the FOOD amount due (the order tip never
  reduces it; 422 with `details.reason` + `amount_due_cents`). An expired hold takes no
  promise (pending/authorized = 409 `expired`) but captured money is still recorded.
* Only `captured` counts; `authorized` is stored `pending` (reported back as `authorized`).
  A captured tender supersedes a pending one with the same processor + ref; the same captured
  processor + ref can never be counted twice (partial unique index).
* Id = `input.id` ?? uuidv5(`tenant:Idempotency-Key`); replay = 200 `idempotent-replayed`; same id,
  other body = `IDEMPOTENCY_CONFLICT`. One SQL function (`core_record_external_tender`) writes under
  a row lock on the order and refuses when the order's tenders changed since the caller validated
  the amounts (`stale`: re-validate; after 4 tries 409 `tender_in_progress`). Afterwards open
  siblings close and the order is paid/released like a card; a replay re-runs that step.
  A hold that is not an `awaiting_payment` hold is not ended by money.
* No platform fee is taken on external tenders (`application_fee_cents` 0). They cannot be
  refunded through POS (GAPS #48): `refundPayment` refuses `external`. A pending external tender
  never blocks `orders.cancel` (it is voided with the order); a captured one does.

**`customers.upsert`** (`POST /customers`): `customers.email` is nullable (phone-only customers).
`core_upsert_customer` runs under advisory locks: match by email, else normalised phone
(`core_phone_key`); never merges two customers; only fills blanks; never touches `verified`;
consent only with an `at` (older never beats newer); tags union; existing external ids win;
writes nothing (no `customer.updated`) when nothing changed.

**`staff.verifyPin` / `staff.setPin`**: POS only answers (`{staff}` / 403 generic / 429 locked);
the hub mints the session. Reuses the till's `begin_pin_attempt` lockout (5 -> 15 min, shared with
`/api/terminal/pin`) and scrypt. `setPin` needs the literal `staff:set_pin`, stores only a hash, and
resets the lockout. PINs are never logged or echoed.

### Phase 2 review hardening

* **Who may record external money.** `recordExternal` can mark an order paid, so beyond the scope
  the caller's module (`op_mod`) must be `kiosk`, `driver`, `catering` or `guests`; anything else
  (pizza-mcp, ...) is 403 `module_not_allowed`. The recording principal + module are stored in the
  tender's `raw.recorded_by` (server-derived). `staff_id` in the body is attribution only (must be an
  active member of the tenant). Outside the zero-env dev mode, `recordExternal` and `staff.setPin`
  also refuse a `sub` without the `hub:` prefix (so the hub's rank / device-kind / tender-lock /
  revoked-client checks cannot be skipped by a direct call).
* **OTP identity.** `customers.email_verified_at` / `phone_verified_at` are the only proof of a
  contact (the shop's magic-link stub proves nothing). Only `customers.upsert` with
  `verified_contact: "email" | "phone"` sets them, and only with the literal `customers:verify` scope
  (wildcards never grant it) through the hub. Phone: matches only a row whose phone is already
  verified, else creates a new row. Email: the row holding that email (the unique constraint allows
  one) is stamped verified. Ordinary upsert and the shop path never set verified state and never fill
  a contact onto a row that has a verified contact. Consent applies only to a contact that ended up
  attached to the row; a future `at` is clamped to now.
* Late-payment refunds: an `external` tender cannot be sent back by POS; it is "owed by hand" and
  `Mark refunded` records the bookkeeping, so the item is never stuck. Reports key external tenders
  by method + processor (COD is cash, not card; gift cards are "Other").

### Phase 2, second review

* **Verification is per contact.** The contract `Customer` gains optional `email_verified` /
  `phone_verified`; the legacy `verified` is true only when the row has a contact and EVERY contact it
  has is proven. The legacy `customers.verified` column (set by the shop's magic-link stub for
  anyone) is never read for this. A consumer must treat a missing per-contact flag as unverified
  and must not log anyone in through a contact whose flag is not true.
* A **phone-only row never gains an email** through an ordinary upsert (another customer is
  created); an email row may take a blank phone, but not once any of its contacts is proven.
* The trigger `core_guard_customer_verified` clears a contact's stamp whenever that contact's value
  changes (any actor, including the service role); only a formatting change of a phone keeps it.
* **National-format phones** (`415-555-0199`) are read as +1 only for US/CA locations (the tenant's
  first location for customers, the order's location for orders); elsewhere they are null.
* Late-payment "Mark refunded" books each external tender and stays open (409) when a booking does
  not fit or the payment is gone.

## Phase 3: read models and tip events

* **`sales.hourly`**: one row per location-local date x hour that had orders, bucketed by
  `placed_at` (else `created_at`) in the LOCATION's zone (DST days are right: no hour 2 on
  spring-forward, the repeated hour folds into one bucket). Same order set as `sales.daily`
  (unpaid checkouts, held and canceled excluded), so the rows of one `business_date` add up to
  that day's daily figures. `tip_cents` is the ORDER-level tip (`totals.tip_cents`), exactly the
  figure `sales.daily` reports; it is not the tip-fact total (use `tips.list` for that).
* **`sales.items`**: per location x business date x item x size; voided lines skipped.
* **`kitchen.load`**: active statuses filtered in SQL, newest first, capped at 300 orders;
  `accepting_orders` mirrors `locations.get` (POS has no pause flag).
* **`tips.list`** and `tip.recorded` / `tip.adjusted` carry `TipFact`s built by one function
  (`src/lib/core/tips.ts`). Rule: if any settled tender has a tip, tender tips are the truth (one
  fact per tender; `staff_id` = the tender's, else the order's); otherwise the order tip is one
  `online` fact. Held, canceled and unpaid-checkout orders have no facts. Refunds come off the tip
  first; each is a signed `adjustment` fact dated by WHEN THE REFUND HAPPENED (location zone), not
  by the order's business date, so a refund after a period closed lands in the open period. An
  online tip is reversed once, in full, only when every settled tender is refunded in full.
* **`processing_fee_cents` is always 0.** POS holds no card-processing fee data for a tender (the
  Stripe fee is not stored; `application_fee_cents` is the platform's cut, a different thing).
  Consumers must not read 0 as "no fee was charged", and no capability flag claims fee data.
* Events are emitted by the `payments` trigger for an order the hub has seen, and by a backfill
  when an order first becomes announced (shop card tips are captured before that). The trigger
  never fails the write it rides on (own exception block; malformed totals count as 0).
* Ranges are at most 93 days, ids are strings (not GUIDs), the cursor is
  `[business_date, occurred_at, id]`, and a range that holds too many orders answers 422 early.
