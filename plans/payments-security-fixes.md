# payments-security-fixes: close the money holes before online checkout

Status: PLAN (no code yet). **Ships first**, before `plans/online-card-checkout.md`. It is
about one dev-day and is independent of the new order lifecycle. It builds on the
`connect-hardening` branch, which:
- derives the tenant from the order in `/api/payments`,
- adds `cardReady`, `account.updated` and connection-token auth,
- moves the idempotency check ahead of the card gate (`resolveCardConnectAccountId`, `CardPaymentsNotReadyError`).

Rebase on that branch once it merges, and touch its files surgically.

Prod Stripe setup, which this plan relies on:

| Endpoint | Events | Secret |
|---|---|---|
| `/api/payments/stripe/webhook` | Connect (events on connected accounts) | `STRIPE_WEBHOOK_SECRET` |
| `/api/billing/webhook` | Account (Billing) | `STRIPE_BILLING_WEBHOOK_SECRET` |

## Fixes

| # | Problem (verified) | Fix |
|---|---|---|
| S1 | `/api/shop/orders` trusts client prices: `base_price_cents`, modifier `price_cents`, names, quantity (`pricing.ts:15-40`). A customer can pay $0.01. There is also no rate limit. | Re-price every line server-side from `driver.getMenu(tenant, location)` (location overrides applied, 86'd items excluded). Add `enforceRateLimit(request, "orders")`. |
| S2 | RLS `orders_insert` lets a signed-in customer insert their own order with any status/totals, including `placed` with no items, straight onto the KDS (`20260605000100_domain_rls.sql:264-270`). | Drop the `is_self_customer` branch from `orders_insert`. The app inserts online orders server-side with the service role, so nothing legitimate uses that branch. |
| S3 | The PI `client_secret` is persisted in `payments.raw` (`stripe-online.ts:108`). Unauthenticated `GET /api/payments?orderId=` returns it, along with all tenders. | Stop persisting `clientSecret` (return it only in the POST response). `GET /api/payments` requires `requireTenantMember(order.tenant_id)` and strips `raw`. |
| S4 | **The tip is double-charged in the shop.** The order `total_cents` includes the tip. The client then sends `amountCents = total_cents` and `tipCents`, and the rail charges `amount + tip` (`checkout-flow.tsx:144-149`). | For `online_*` orders, `/api/payments` ignores the client's `amountCents`/`tipCents` and derives them from the order: `amount = total − totals.tip_cents − already covered`, `tip = totals.tip_cents`. The client is fixed to match. Coverage uses `orderDueCents()` (see S6). |
| S5 | Webhooks never mark orders paid. Both Stripe and Coinbase handlers `upsertPayment({status: captured})` and then call `refreshPaymentStatus`, which early-returns on `captured`, so `maybeMarkOrderPaid` never runs (`service.ts:186`). The Stripe handler also ignores `event.type` and `event.account`, uses no timestamp tolerance, and accepts only one `v1` signature. | New `applyRailStatus(paymentId, status, opts)` in `service.ts`: persist with precedence (never downgrade `captured`/`refunded`), then **always** `maybeMarkOrderPaid`. Both webhooks and `refreshPaymentStatus` use it. Harden the Stripe webhook (details below). |
| S6 | `coveredCents` counts `requires_action` tenders (`service.ts:76-80`), so the balance shows $0 for an intent nobody paid. This affects the terminal too. | Exclude `requires_action` (covered = `pending`/`authorized`/`captured`; settled = `authorized`/`captured`). Add `orderDueCents(order) = total_cents − totals.tip_cents`. Order tips ride on the tender's `tip_cents`; terminal orders have an order tip of 0, so they are unchanged. |
| S7 | `maybeMarkOrderPaid` sets `paid` from any non-void status (`service.ts:255-266`), so a late settlement regresses `in_kitchen`/`ready`/`completed` back to `paid`. | Transition to `paid` only from `draft` or `placed`. Other statuses are left alone (still logged). |
| S8 | Direct-charge refunds send `reverse_transfer: true` (`stripe-terminal.ts:150`, check `stripe-online.ts` too). That parameter is for destination charges, so Stripe rejects it (or misbehaves) on a direct charge made on the connected account. Found by the terminal-reader planner. | Drop `reverse_transfer`. Refund on the connected account (`Stripe-Account` = `payment.connect_account_id`) with `refund_application_fee` decided explicitly. Default `true` so the platform returns its fee on a full refund; confirm with Snax. |
| S9 | Any tenant member, including the `kitchen` role, can refund (`/api/payments/refund`). | Require owner\|manager. Cashiers get no refunds in v1 unless Snax says otherwise. |
| S10 | `TRAINING_MODE=1` with a **live** Stripe key still makes real charges, so the training banner lies. | In training mode, card rails must not create real charges. Either refuse when the key is `sk_live_` and training is on, or route card to the simulated path. Recommend: card rails simulate whenever `isTrainingMode()`, whatever the key. Test-mode keys + training (today's prod) keep exercising real test-mode Stripe only if `TRAINING_MODE` is unset, so prod moves to "test keys, no flag" with a banner reason `stripe-test` instead. Implementer: make the banner reason/copy reflect `sk_test_` ("TRAINING — Stripe test mode, no real money"). |
| S11 | Every terminal Charge press mints a new UUID (`use-checkout.ts:147`, same in `use-shop-checkout.ts`), so a retry after a lost response creates a duplicate tender. | Generate the tender id once per pending tender (state/ref), reuse it on retry, and clear it only on success or explicit change of amount/rail. |

**S5: Stripe webhook details** (`/api/payments/stripe/webhook`, the Connect endpoint).

Verification:
- `verifyStripeWebhook(raw, header, secret, { toleranceSec: 300 })`.
- Reject if `|now − t| > 300`.
- Accept any of multiple `v1=` entries (secret rotation).
- Secret: `STRIPE_WEBHOOK_SECRET` (the Connect endpoint's).

Handling:
- Require `event.account` (Connect events always carry it).
- Look up the tender by `charge_id` (falling back to `data.object.metadata.payment_id`). Ignore the event (200) unless `event.account === payment.connect_account_id`. Also check that `pi.amount === amount_cents + tip_cents` and the currency matches. On a mismatch, log and audit, and do not settle.
- Switch on `event.type`:

| `event.type` | Action |
|---|---|
| `payment_intent.succeeded` | `applyRailStatus(captured)` |
| `payment_intent.processing` | `pending` |
| `payment_intent.payment_failed` | `requires_action`, and store `last_payment_error.message` in `raw.last_error` |
| `payment_intent.canceled` | `canceled` |
| `account.updated` | delegate to `connect-hardening`'s handler (same endpoint; merge, don't duplicate) |
| anything else | 200 no-op |

- Unknown tender: 200, logged. This covers retries arriving before the row exists.

**S5: Coinbase webhook.** Same `applyRailStatus` fix. The online-checkout plan replaces
the provider later; this is just the settlement bug.

## Files (step by step)

1. **S1 repricing:** new `src/lib/shop/reprice.ts`, `repriceItems(menu, items)`.
   - For each non-voided line:
     - Resolve `item_id` (and `size_id`) in the menu, else 422 "item unavailable".
     - Clamp `quantity` to an integer from 1 to 50, else 422.
     - Check each modifier belongs to a group linked to the item and that its placement is valid. Placement is `whole`, or `left`/`right` only when the group `supports_half` and the item `is_half_and_half_capable`.
     - Enforce group `min_select`/`max_select`.
   - Rebuild the line with snapshot names, `station` and prices from the menu, using `placementPriceCents` from `src/lib/build-line.ts`, then `withLinePricing`.
   - Ignore every client-sent price, name and station field. Keep the client line `id`, `notes` (trimmed, max 200) and `voided`.
2. `src/app/api/shop/orders/route.ts`:
   - Add `enforceRateLimit(request, "orders")` at the top.
   - Call `repriceItems` before both `computeOrderTotals` calls.
   - Validate `tipCents` with `isMoneyCents` and cap it at subtotal × 1.0.
   - Persist the repriced items.
3. `supabase/migrations/20261030000000_orders_insert_staff_only.sql` (new):
   `drop policy orders_insert on public.orders; create policy orders_insert on public.orders for insert with check (public.is_platform_admin() or public.is_tenant_member(tenant_id));`
   This stays keyed on memberships via `is_tenant_member`. Extend
   `supabase/tests/rls_isolation.sql`: a self-customer insert of their own order is denied,
   and a member insert is still allowed.
4. `src/lib/payments/rails/stripe-online.ts`:
   - Remove `clientSecret` from `raw` and return it as a top-level `ChargeResult.clientSecret?` (new optional field in `PaymentRail.ts`).
   - Add `metadata.order_id`/`payment_id`/`tenant_id`.
5. `src/app/api/payments/route.ts`:
   - **POST:** for `online_*` orders, derive amount and tip from the order and the existing tenders (S4). Return `clientSecret` from the charge result in the response body only.
   - **GET:** `requireTenantMember(order.tenant_id)`, and map tenders through `publicTender()` (drops `raw`).
6. `src/lib/payments/service.ts`: `orderDueCents`, the `coveredCents` and `settledCents` changes (S6), `applyRailStatus` (S5), and the `maybeMarkOrderPaid` transition guard (S7). `refreshPaymentStatus` goes through `applyRailStatus`.
7. `src/lib/payments/providers/stripe-client.ts`: tolerance, multiple `v1` signatures, a secret parameter, and `toleranceSec`.
8. `src/app/api/payments/stripe/webhook/route.ts`: the event switch, account/amount check and `applyRailStatus`, as described above.
9. `src/app/api/payments/coinbase/webhook/route.ts`: `applyRailStatus`.
10. `src/lib/store/use-shop-checkout.ts` and `checkout-flow.tsx`: send `amountCents = order.totals.total_cents − order.totals.tip_cents` and `tipCents = order.totals.tip_cents`. The server ignores both for online orders anyway. Use the repriced totals the server returns for display after placing.
11. Docs:
    - `docs/IDEMPOTENCY_REVIEW.md`: S5 resolves the "nuance". Document `orderDueCents` and the coverage rules.
    - `docs/PRODUCTION_READINESS.md` §1: customers no longer insert orders directly. §11: the webhook tolerance, the `/api/shop/orders` rate limit, and the GET auth.

## Tests (Vitest, zero env, mock driver)

- `src/lib/shop/reprice.test.ts`:
  - Tampered `base_price_cents` and modifier prices are overwritten.
  - An unknown or 86'd item gives 422.
  - A half placement on a non-half group gives 422.
  - A quantity of 0, a negative quantity, or 1e6 gives 422.
  - A max_select overflow gives 422.
  - Left+right halves of one topping cost the same as whole.
- `src/app/api/shop/orders` route test: a tampered payload produces server totals. A 61st request in a minute is limited (enable the limiter in that test).
- `payments/service.test.ts` additions:
  - **S4/S6:** a shop order with a tip, paid with the derived amounts, charges `total` exactly once and is marked `paid`.
  - **S6:** a `requires_action` tender leaves the balance equal to the due amount.
  - **S5:** `applyRailStatus(captured)` on a pending tender marks the order `paid`. A replay is a no-op. `failed` after `captured` doesn't downgrade.
  - **S7:** an order in `in_kitchen` stays `in_kitchen` after a settling tender.
- Webhook route test (`fetch` stubbed, secret set):
  - bad signature → 400
  - stale timestamp → 400
  - rotated second `v1` → ok
  - wrong `event.account` → ignored
  - amount mismatch → not settled
  - `payment_failed` → `requires_action` with `last_error`
- `api/payments` GET test: no session gives 401/403 in real-auth mode, and the response has no `raw`/`clientSecret`. POST for an online order ignores a client `amountCents`.
- RLS SQL test from step 3 (the optional CI job).
- Existing E2E (`shop.spec.ts`, `terminal.spec.ts`) stays green with zero env.

## Verify on the preview

Deploy with `vercel-deploy`. Then:
- Place a shop order with a 15% tip. In simulated mode the tender `amount + tip` equals the order total.
- `curl /api/payments?orderId=<id>` without a session is denied.
- Stripe CLI test against a test-mode deployment: `stripe trigger payment_intent.succeeded --stripe-account acct_…`. Only signed events with a matching account settle.

## Risks

- Repricing rejects carts built from a stale menu, for example an item 86'd mid-checkout. The client shows the 422 message and the customer rebuilds the cart. This is acceptable.
- GET auth on `/api/payments` could break the terminal payment screen if simulated-auth mode doesn't satisfy `requireTenantMember`. Verify with `terminal.spec.ts`.
- Dropping the customer-insert policy is safe only because nothing inserts orders with a customer JWT. Grep for browser-side `from("orders").insert` before merging (there are none today).

## Size

About **1 dev-day**:

| Area | Estimate |
|---|---|
| Repricing and tests | 3 h |
| Service, webhook and payments-route changes and tests | 3 h |
| RLS migration and SQL test | 0.5 h |
| Docs and verification | 1 h |
