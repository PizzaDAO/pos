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
| Online checkout order id | One order id per checkout (client `sessionStorage`, keyed by cart/fulfillment/tip signature); retries, reloads and returns reuse the order. `POST /api/shop/orders` returns an existing order unchanged, 409 for an abandoned one. | `store/checkout-order-id.ts`, `api/shop/orders/route.ts` | `store/checkout-order-id.test.ts` |
| Online tender id | Derived server-side from `(orderId, rail, seq)` (UUIDv5): it is both the payments PK and the provider idempotency key; a repeat `/api/payments` call is the same tender. | `payments/ids.ts`, `nextOnlineTenderId` | `shop/lifecycle.test.ts` |
| One live card tender | Partial unique index `payments_one_live_card_or_cb`; the orphan intent is canceled on conflict. | migration `20261101000100`, `takePaymentDetailed` | `shop/lifecycle.test.ts`, `supabase/tests/rls_isolation.sql` |
| `finalizeOnlinePayment` | Compare-and-set `awaiting_payment -> paid`; only the winner depletes inventory / dispatches delivery, so webhook + sync + sweeper race safely. | `shop/finalize.ts`, `driver.transitionOrderStatus` | `shop/lifecycle.test.ts` (concurrent finalize) |
| Abandonment sweeper | Compare-and-set `awaiting_payment -> abandoned` after closing provider state; a payment that landed finalizes instead. | `shop/lifecycle.ts` | `shop/lifecycle.test.ts` |
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
- **Resolved (payments-security-fixes, S5):** the earlier "nuance" is closed.
  Every rail status change (takePayment, polling, Stripe and Coinbase webhooks)
  now goes through `applyRailStatus` in `payments/service.ts`, which (a) never
  downgrades a `captured`/`refunded` tender, and (b) **always** re-runs the
  order-paid check, even when the tender was already captured. The webhooks no
  longer write the status directly. Replays are no-ops.
- **Coverage rules** (`payments/service.ts`):
  - `orderDueCents(order) = total_cents - totals.tip_cents`. Online orders fold
    the customer's tip into `total_cents`; the tip rides on the tender's
    `tip_cents`, not its base `amount_cents`. Terminal orders have an order tip of
    0, so due == total there.
  - A tender *covers* the balance when `pending`, `authorized` or `captured`
    (`requires_action`, `failed`, `canceled`, `refunded` do not). The order is
    marked `paid` only when SETTLED (`authorized`/`captured`) base amounts reach
    the due amount, and only from `draft`/`placed` (a late settlement never
    regresses `in_kitchen`/`ready`/`completed`).
  - For online orders `/api/payments` ignores the client's `amountCents` and
    `tipCents` and derives them from the order and its covering tenders
    (`deriveOnlineTender`), so the tip is charged exactly once.
- **Client retries (S11):** the terminal and shop hooks mint one tender id per
  pending tender (`store/pending-tender.ts`) and reuse it on retry until the
  tender is recorded or its amount/rail changes.

## In-store card reader (server-driven)

- The tender id (client UUID) is the `payment_intents` `Idempotency-Key`; a
  repeat `POST /api/terminal/payments` with the same id returns the existing
  tender, and a different id while a card tender is open returns the open one
  (DB-backed by the partial unique index `payments_one_live_terminal`).
- `process_payment_intent` gets a per-ATTEMPT key `<paymentId>:process:<n>`; `n`
  (`raw.process_attempts`) is persisted BEFORE the Stripe call, so a key is never
  reused for a different request. A `terminal_reader_timeout` is retried once with
  the same key. A decline retries on the SAME PaymentIntent (never recreated).
- Polling and the webhooks converge in `syncCardTender`, which re-reads the
  PaymentIntent from Stripe (never trusting the event payload), verifies id,
  `metadata.payment_id`, currency and amount against the tender, and settles via
  `applyRailStatus` (never downgrades `captured`; promotes the order once).
- Cancel and the cron reconcile re-sync first, so a card that went through is
  never canceled away; an open tender left behind is canceled on Stripe.

## Live-wiring follow-ups

- Forward the tender UUID as the Stripe `Idempotency-Key` (already wired in the
  rails) and as the crypto deposit reference/memo.
- Webhook handlers are idempotent on the rail charge id and settle the order via
  `applyRailStatus` (done, S5).
