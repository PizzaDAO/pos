# marinara-31903 — Phase 2: Payments + Money Routing

**Priority:** P1 (revenue surface)
**Parent plan:** `../PLAN.md`
**Builds on:** Phase 0 (foundations) + Phase 1 (terminal/cart/offline/mock DB).

## Goal
Make the terminal take money. Implement the **real** Stripe Connect / Stripe
Terminal / Stripe online / onchain-USDC(Base) / Coinbase Commerce integration
code behind the existing `PaymentRail` interface, plus a fully-real **cash**
rail — but guard every external rail behind its env keys so that with **no keys**
(the default, including the Vercel preview) each falls back to a deterministic
**simulated settlement**. The whole checkout flow (rail picker, tips, split
payment, refund/void, receipts, Connect onboarding) works end-to-end with **zero
env vars**. Supabase stays deferred: all new state persists through the mock
`PosDriver`.

## The core design rule: env-guarded real code + simulated fallback
`src/lib/payments/env.ts` centralizes every credential read (lazily, never at
module load). Each rail checks `isStripeConfigured()` / `isCoinbaseConfigured()`
/ `isOnchainConfigured()`:
- **keys present** → the real provider code path runs (Stripe/Coinbase REST via
  `fetch`, Base JSON-RPC via `fetch` — no SDK deps added, so the bundle still
  builds with nothing installed beyond Phase 1).
- **no keys** (default/preview) → a `sim_…`-prefixed simulated charge approves
  instantly (card/cash) or auto-confirms after ~6s (crypto). Cash is **always
  real** (no external dependency).

This keeps the production wiring in place for the final credentials phase while
staying green now.

## What was built

### Payment domain + DB abstraction
- `src/lib/db/payment-types.ts` — `Payment` (one tender; UUID = idempotency key),
  `ConnectAccount`, `PaymentSettings`. All money integer cents.
- `OrderStatus` gains `paid`. `PosDriver` gains `updateOrderStatus`,
  `getPaymentSettings`, `upsertPayment` (idempotent upsert-by-UUID),
  `getPayment`, `getPaymentByChargeId` (webhook reconciliation),
  `listPaymentsForOrder`, `getConnectAccount`, `upsertConnectAccount`.
- `src/lib/db/mock.ts` implements them with process-lifetime Maps. Seed adds
  `paymentSettings` (2.5% + $0.10 platform fee, 15/18/20% tip presets).

### PaymentRail implementations (registered in the registry)
- `cash` (`rails/cash.ts`) — fully real: tender entry, change due, instant
  capture.
- `stripe_terminal` (`rails/stripe-terminal.ts`) — real card-present
  PaymentIntent on the **connected account** with `application_fee_amount`,
  capture, refund (with fee/transfer reversal). Connection-token endpoint for
  the reader SDK. **Offline store-and-forward semantics documented** (reader
  secure-element queue → forward-on-reconnect; our IndexedDB queue + idempotent
  charge mirror it). Simulated approval when no key.
- `stripe_online` (`rails/stripe-online.ts`) — card-not-present PaymentIntent +
  `client_secret` for Stripe.js; same Connect + fee model. Reused by the Phase 4
  shop. Simulated otherwise.
- `crypto_onchain_usdc` (`rails/crypto-onchain-usdc.ts`) — quote fiat→USDC
  (1:1 for USD), pay-to address/intent, confirmation **watcher** on Base
  (`providers/base-provider.ts`, raw JSON-RPC `eth_getTransactionReceipt`, N=3
  confirmations). Simulated "confirmed after ~6s" otherwise.
- `crypto_coinbase` (`rails/crypto-coinbase.ts`) — Coinbase Commerce charge
  creation (`providers/coinbase-client.ts`) + hosted URL + signature-verified
  webhook. Simulated otherwise.
- `rails/index.ts` registers all rails on import (the `@/lib/payments` barrel
  pulls it in). `PaymentRailKey` extended with `cash`.

### Payment service (server orchestration) — `src/lib/payments/service.ts`
- `takePayment` — **idempotent on `paymentId`**: returns the existing tender if
  the id was already used (offline replay / double-tap → never double-charges).
  Computes the card application fee, calls the rail, persists the tender, and
  marks the order `paid` once **settled** tenders cover the total.
- **Split payment:** `getOrderBalance` = total − covered (covered counts pending
  crypto so the cashier isn't re-prompted); the order flips to `paid` only when
  `settledCents` (captured/authorized) ≥ total. Multiple tenders across rails
  drive the balance to zero.
- `refreshPaymentStatus` — re-checks a pending tender with its rail (crypto
  watcher / Stripe capture) and persists the result.
- `refundPayment` — full/partial refund via the rail; marks the order `refunded`
  only when **all** tenders are fully refunded.

### Platform fee — `src/lib/payments/fees.ts`
`application_fee_amount = roundHalfUp(amount×bps/10000) + flat`, computed on
**base + tip**, clamped to the charge, **card rails only** (cash/crypto carry no
per-order fee in v1, per PLAN.md). Rate/flat from `payment_settings` (mock) with
`PLATFORM_FEE_*` env defaults. Shown in the receipt breakdown.

### Stripe Connect onboarding — `src/lib/payments/connect.ts`
Create/refresh an Express connected account + Account Link (real when keyed;
simulated `acct_sim_…` reporting `connected` otherwise). Status persists via the
DB abstraction. Surfaced at `/admin` (`connect-onboarding.tsx`).

### API routes
- `POST/GET /api/payments` — take a tender / list tenders + balance.
- `POST /api/payments/refund` — refund/void a tender.
- `GET /api/payments/status` — watcher poll for pending crypto.
- `GET/POST /api/connect` — Connect status / start onboarding.
- `POST /api/payments/stripe/connection-token` — Terminal reader token.
- `POST /api/payments/stripe/webhook` + `POST /api/payments/coinbase/webhook` —
  signature-verified when the secret is set; **no-op 200** otherwise. Reconcile
  the matching tender by charge id and re-evaluate the order's paid state.

### Terminal checkout UI (`src/app/(terminal)/terminal/components/`)
- `payment-screen.tsx` — opens after "place order" (online). Rail picker, tip
  selector, cash entry + change, crypto "awaiting confirmation", **split** until
  balance = 0, **refund/void** of completed tenders, live receipt.
- `tip-selector.tsx` — preset % (off the remaining balance) + custom.
- `receipt-view.tsx` — full breakdown (items + modifiers incl. half-and-half,
  discount, tax, tip, platform fee, each tender + change); print/email/SMS
  **stubs**.
- `use-checkout.ts` — client hook: take tenders (fresh UUID per tender),
  poll pending crypto, refund. `/api/menu` now also returns `paymentSettings`.
- Offline: paying needs connectivity (beyond reader store-and-forward), so an
  order placed offline shows the queued confirmation and is paid once online.

## Idempotency (no double charges)
The client UUID on each tender is **both** the Stripe/Coinbase idempotency key
**and** the payment row PK. `takePayment` short-circuits if the id exists; the
mock `upsertPayment` is upsert-by-UUID. Verified: re-POSTing the same
`paymentId` yields one tender.

## Verification (no env vars set)
- `npm install && npm run typecheck && npm run lint && npm run build` — all pass.
- `npm run start` + curl, full flow confirmed:
  - card (simulated approve) + tip → captured, app fee attached, order `paid`;
  - cash $20.00 on $18.39 due → change $1.61, order `paid`;
  - crypto → `pending` (order stays `placed`) → auto-confirms ~6s → `paid`;
  - split cash $10 + card $8.39 → 2 tenders, balance 0, order `paid`;
  - refund a tender → tender `refunded`;
  - **re-POST same `paymentId` → still one tender (no double charge)**;
  - Connect onboarding (simulated) → `connected`, persisted; webhooks no-op 200.

## Out of scope (later phases)
KDS (3); customer shop (4 — reuses the `stripe_online` rail); back-office /
reports / Stripe Billing subscriptions (5/6); live Supabase + live Stripe/crypto
keys (final wiring phase); auth.
