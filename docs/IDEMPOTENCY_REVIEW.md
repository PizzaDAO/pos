# Idempotency & Double-Charge Review (Phase 7)

A focused review of every place a retry, replay, double-tap, or lost response
could create a duplicate order, a double charge, or an incorrect settlement —
plus the automated tests that pin each guarantee. All money is integer minor
units (cents / USDC base units); there is no floating-point money path.

## The end-to-end idempotency key

A single **client-generated UUID** flows through the whole lifecycle:

- It is the **order** primary key (`orders.id`) and the offline-queue key.
- It is the **payment tender** primary key (`payments.id`) **and** the rail
  `Idempotency-Key` forwarded to Stripe/Coinbase/onchain.

Because the same id is the DB key and the rail key, a retry maps to exactly one
row and one upstream charge.

## Order intake

| Path | Guarantee | Where | Test |
|---|---|---|---|
| `POST /api/orders` → `driver.createOrder` | Upsert-by-UUID; existing id returns the stored order unchanged, order number assigned once. | `src/lib/db/mock.ts` `createOrder` | `src/lib/offline/sync.test.ts` |
| Offline queue enqueue | Keyed by order UUID; re-enqueue of a synced/pending order does not duplicate. | `src/lib/offline/queue.ts` | `src/lib/offline/queue.test.ts` |
| Offline flush | Re-entrant-guarded; safe under reconnect + interval + manual triggers; POSTs are idempotent server-side. | `src/lib/offline/sync.ts` | covered via the upsert test |

## Payments

| Path | Guarantee | Where | Test |
|---|---|---|---|
| `takePayment` | Repeat `paymentId` returns the existing tender → **no second charge** (checked **before** calling the rail). | `src/lib/payments/service.ts` | `payments/service.test.ts` (idempotency, one tender) |
| Settlement | Order → `paid` only when **settled** (captured/authorized) tenders cover the total; never downgrades a paid order. | `maybeMarkOrderPaid` | `payments/service.test.ts` (settled-covers, split) |
| Split payment | Balance driven to zero across multiple tenders/rails; `getOrderBalance` never negative. | `getOrderBalance` / `coveredCents` | `payments/service.test.ts` (split) |
| Crypto pending | Pending crypto counts toward the displayed balance but **not** toward `paid`; confirm → settle. | `coveredCents` vs `settledCents` | `payments/service.test.ts` (crypto pending → confirm) |
| Refund | Tender `refunded` only when fully refunded; order `refunded` only when **all** tenders refunded; partial refund does neither. | `refundPayment` | `payments/service.test.ts` (refund full + partial) |
| Platform fee | Card-only `application_fee`; `pct(bps)+flat`, round-half-up, clamped to the charge. Integer cents. | `payments/fees.ts` | `payments/fees.test.ts` |

## Deliveries & end-of-day

| Path | Guarantee | Where | Test |
|---|---|---|---|
| `dispatchDelivery` | Idempotent on the order id (existing delivery returned). | `src/lib/delivery/service.ts` | exercised via service tests |
| `closeBusinessDay` | Idempotent: re-closing returns the frozen Z-report snapshot. | `src/lib/db/mock.ts` | `db/mock-drawer.test.ts` |

## Findings while writing the tests

- **No double-charge / duplicate-order bugs were found.** The end-to-end UUID
  idempotency model held under every retry/replay/split scenario tested.
- **Documented behavioural nuance (not a bug):** `refreshPaymentStatus`
  early-returns when a tender is *already* `captured`/`refunded` and therefore
  does **not** re-run `maybeMarkOrderPaid`. This is correct for the intended flow
  (the watcher/webhook transitions pending → captured *through*
  `refreshPaymentStatus`, which settles the order in the same call). If a future
  live webhook captures a tender by writing the status **directly** via
  `upsertPayment`, it must also call `maybeMarkOrderPaid` (or route through
  `refreshPaymentStatus`) so the order settles. The crypto-confirm test exercises
  the correct watcher path (`payments/service.test.ts`). Noted here for the
  live-wiring phase.

## Live-wiring follow-ups

- Forward the tender UUID as the Stripe `Idempotency-Key` (already wired in the
  rails) and as the crypto deposit reference/memo.
- Make all webhook handlers idempotent on the rail charge id, and have any
  direct-capture webhook settle the order (see the nuance above).
