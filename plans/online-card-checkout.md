# online-card-checkout: card, wallets, USDC and Coinbase behind a pay-before-kitchen lifecycle

Status: PLAN (no code yet), **revised after Snax's review**.

**Depends on:**
- `plans/payments-security-fixes.md` (ships first): server repricing, RLS insert, client-secret storage, tip, webhook settlement and hardening, coverage, backwards transitions.
- `connect-hardening`: tenant-from-order, `cardReady`, `account.updated`, connection-token auth.

**Out of scope:** the in-store reader (`plans/terminal-card-reader.md`). Pieces marked
**[SHARED]** below are reused by that plan.

**Launch scope (all of it):**
- Card via Payment Element.
- Apple Pay and Google Pay via the Express Checkout Element, with per-account domain registration.
- Onchain USDC on Base with a real UX.
- Coinbase hosted checkout.

Every rail goes through one `awaiting_payment → finalize` lifecycle.

## Goal

1. Paying online actually collects money on every launch rail. Card and wallet payments
   are direct charges on the pizzeria's Express account (`Stripe-Account` plus
   `application_fee_amount`), and crypto goes to the pizzeria's own wallet or Coinbase
   account.
2. **No online order reaches the KDS, inventory or delivery dispatch until it is paid.**
   Abandoned or failed checkouts expire.
3. Retries reuse the same order and the same rail charge.
4. With zero env (CI), every rail works end-to-end through the simulated path.

## Current state (verified)

- **Card:** `stripe_online` creates an unconfirmed PI. No Stripe.js exists in `src`. The
  checkout shows "done" for any tender (`checkout-flow.tsx:144-154`).
- **Order flow:** the shop creates `placed`, dispatches delivery, then pays
  (`api/shop/orders/route.ts:268-292`). Each Pay click mints a new order id (`:131`).
  `createOrder` depletes inventory immediately (`db/supabase.ts:1350`, `db/mock.ts:863`).
- **Onchain USDC** (`rails/crypto-onchain-usdc.ts`, `providers/base-provider.ts`):
  - One **platform-wide** `CRYPTO_PAY_TO_ADDRESS` env. There is no per-tenant wallet, and
    PLAN.md says crypto must never be pooled by us.
  - The real `chargeId` is a random `usdc_intent_…`, but `status()` only checks ids that
    start with `0x`, so **real mode can never confirm**.
  - Nothing records a tx hash. `getTxConfirmations` checks only that a receipt succeeded.
    **It does not decode the USDC `Transfer` (token, recipient, amount)**, so any
    successful tx hash would "pay" an order.
  - There is no expiry enforcement, no under/overpay handling, and no shop UI (no address,
    QR or wallet).
- **Coinbase** (`rails/crypto-coinbase.ts`, `providers/coinbase-client.ts`):
  - The rail uses the legacy Commerce Charges API (`X-CC-Api-Key`, version `2018-03-22`)
    with **one platform API key**, so funds go to the platform's account.
  - Coinbase now directs integrations to the **Coinbase Business Checkouts API** (CDP API
    keys with JWT bearer auth, single-use checkouts with `expiresAt`, and
    `checkout.payment.success|failed|expired` webhooks). Its FAQ says the Charge API "can
    still be used" but recommends migrating. Third-party sources report Commerce shutting
    down after 2026-03-31, with Business being custodial and US/SG-only. **Verify the
    current status against Coinbase docs at implementation.**
  - Coinbase isn't offered in the shop today.

## Approach

### 1. Order lifecycle (the core; build it first)

Add order statuses **`awaiting_payment`** (initial for every online order) and
**`abandoned`** (terminal).

```
online:   awaiting_payment ──(settled)──▶ paid ──▶ in_kitchen ──▶ ready ──▶ (out_for_delivery) ──▶ completed
                 └──(expired / cancelled / provider expired)──▶ abandoned
in-store: unchanged
```

- **[SHARED] `driver.transitionOrderStatus(id, from[], to)`:** a compare-and-set,
  `UPDATE … WHERE id=? AND status IN (…) RETURNING`, implemented in the mock and supabase
  drivers. The terminal plan can reuse it for its own transitions.
- **[SHARED] `finalizeOnlinePayment(orderId)`** in `src/lib/shop/lifecycle.ts`. It is
  called from `maybeMarkOrderPaid` (as fixed by the security plan) when the order is
  `awaiting_payment` and settled tenders cover `orderDueCents`.
  1. Compare-and-set `awaiting_payment → paid`. Only the winner continues, so the webhook,
     client sync, watcher and cron race safely.
  2. For ASAP orders, recompute `fulfillment.promised_at` from **now** (prep starts at
     payment).
  3. Deplete inventory. `createOrder` skips depletion for `awaiting_payment`; this calls
     the new `driver.depleteInventoryForOrder`.
  4. For delivery orders, `dispatchDelivery` from the quote persisted on the order
     (`fulfillment.delivery_provider`, `quote_id`, `eta_minutes`; jsonb, no migration).
     If dispatch fails, the order stays `paid` and on the KDS. The failure is logged,
     audited and surfaced in admin dispatch.

  Coverage, `applyRailStatus` and `orderDueCents` come from the security plan and are
  **[SHARED]** with the terminal.
- **KDS and realtime:** no change. The new statuses aren't in `KDS_ACTIVE_STATUSES`, and
  the `postgres_changes` UPDATE to `paid` triggers the refetch.
- **Tracking:** `awaiting_payment` shows "Waiting for payment" with Resume and Cancel
  actions. `abandoned` shows "Checkout expired". Update `statusLabel()`.
- **Reports, EOD and tenant health:** exclude both new statuses.
- **Gaps in order numbers** are accepted. Order numbers are display-only and not
  sequential-audit, and the Z-report counts orders rather than numbers.
- **Expiry windows** (env, per rail): the order expires at
  `created_at + window(rail of the live tender)`.

| Rail | Default window | Why |
|---|---|---|
| Card / wallets | 30 min | Covers 3DS. |
| Coinbase | 60 min | Hosted checkout and chain confirmation. Set the checkout's `expiresAt` to the order expiry. |
| Onchain USDC | **60 min** | **Crypto needs longer.** A manual send from an exchange (withdrawing to Base) commonly takes 10–30 min. Wallet-connect pays in under 2 min. |

  **Crypto late grace:** a matching transfer that confirms within 15 min after expiry is
  still auto-finalized (`promised_at` is recomputed). Later than that, the order is not
  promoted. It is flagged in admin as a "late payment, accept or refund" item, with an
  audit row.
- **TTL gate:** `/pay` refuses (409 "checkout expired, start again") after expiry and
  re-runs the hours/ASAP check.
- **Sweeper cron** every 5 min (Vercel Pro): `GET /api/cron/expire-online-orders`, guarded
  by `Authorization: Bearer $CRON_SECRET`, with `crons: [{ path, schedule: "*/5 * * * *" }]`
  in `vercel.json`. For each expired `awaiting_payment` order:

  | Rail | Action |
  |---|---|
  | Card | Cancel the PI. If it is already `succeeded`, finalize. If `processing`, skip. |
  | Coinbase | Deactivate the checkout, or finalize if it is `COMPLETED`. |
  | USDC | Run one last watcher pass. |

  Then compare-and-set to `abandoned` and mark the tenders `canceled`. It also runs the
  USDC watcher for all open USDC tenders (section 4).

  **Only touch tenders whose mode matches the running deployment** (`raw.livemode` for
  Stripe, `raw.chain_id` for USDC). Prod and staging share a DB (section 7).
- **Migrations:**
  - `20261101000000_order_status_lifecycle.sql`, enum values only, in their own file
    (`alter type public.order_status add value if not exists 'awaiting_payment' before 'placed'; … 'abandoned';`).
  - `20261101000100_online_checkout.sql`, which adds:
    - `orders_awaiting_payment_idx on public.orders (created_at) where status='awaiting_payment'`
    - `payments_one_live_card_or_cb on public.payments (order_id, rail) where rail in ('stripe_online','crypto_coinbase') and status not in ('canceled','failed')`
      (unique; one live PI or checkout per order)
    - `payments_crypto_tx_hash_uidx on public.payments (crypto_chain, crypto_tx_hash) where crypto_tx_hash is not null`
      (unique; one tx can never pay two orders)
    - the USDC tag index (section 4)
    - the tenant crypto and Coinbase config tables (sections 4 and 5)
    - `connect_accounts.pm_domains jsonb`

  RLS on the new tables follows the existing pattern:
  - SELECT for `is_platform_admin() or is_tenant_member(tenant_id)`
  - writes for `is_platform_admin() or has_tenant_role(tenant_id, array['owner','manager'])`
  - no `anon` grant
  - `FORCE ROW LEVEL SECURITY`, matching `20260605000200_least_privilege_grants.sql`

  The orders-insert tightening is done by the security plan (customers can't insert at
  all).

### 2. Retries and idempotency (all rails)

- **Stable `orderId`:** the client mints it once per checkout and stores it in
  `sessionStorage`, keyed by a hash of cart + fulfillment + tip. Retries, reloads, the 3DS
  return and the Coinbase return reuse it. A material change mints a new id, and the old
  order is cancelled best-effort (`/cancel`). `/api/shop/orders` returns an existing
  `awaiting_payment` order unchanged, and returns 409 for an `abandoned` one, which tells
  the client to mint a new id.
- **Deterministic tender id:** `deriveTenderId(orderId, rail, seq=0)` (UUIDv5 sha1 helper,
  `src/lib/payments/ids.ts`, no dependency) is both the payments PK and the provider
  idempotency key. `takePayment`'s existing guard makes repeat `/pay` calls return the
  same tender. `/pay` re-fetches the PI client secret from Stripe; it is never stored.
- **Declined card:** the PI goes back to `requires_payment_method`. Re-confirm the same PI.
- **Switching rail:** the client calls `/pay` with a new rail. The server first cancels
  the other live tender (PI cancel, Coinbase deactivate, or USDC tag release), then
  creates the new one.
- **The generic `/api/payments` rejects online rails for `online_*` orders.** There is one
  path: `/api/shop/orders/[id]/pay`.

### 3. Card and wallets (Stripe, direct charges)

- **Card: Payment Element in deferred-intent mode.**
  - `loadStripe(pk, { stripeAccount })` and
    `<Elements options={{ mode:'payment', amount, currency, paymentMethodTypes:['card'] }}>`.
  - A tip change calls `elements.update`.
  - Pay runs `elements.submit()`, then `POST /api/shop/orders` (`awaiting_payment`), then
    `POST /api/shop/orders/[id]/pay {rail:'stripe_online'}` (which returns `clientSecret`),
    then `stripe.confirmPayment({ elements, clientSecret, redirect:'if_required', confirmParams:{ return_url } })`,
    then `POST …/pay/sync`.
  - The server sync retrieves the PI on the connected account and verifies metadata,
    amount, currency and account before `applyRailStatus`. The UI shows "done" only when
    `orderStatus` is `paid`.
  - 3DS happens in Stripe's modal. The `return_url` is
    `/shop/{slug}/track/{orderId}?pay_return=stripe`. The track page ignores
    `redirect_status`, calls sync, then `replaceState`s the secret out of the URL.
  - The PI uses `payment_method_types: ['card']`. Wallets are card payment methods, so
    Apple Pay and Google Pay work.
- **Apple Pay and Google Pay: Express Checkout Element**, rendered above the Payment
  Element in the same `Elements` group.
  - It uses the same deferred flow. Its `confirm` event runs place, then `/pay`, then
    `stripe.confirmPayment({ elements, clientSecret, redirect:'if_required' })`, then
    sync. The shop has already collected email and fulfillment, so request no
    shipping/phone from the wallet sheet.
  - If the browser has no wallet, the element renders nothing.
- **Per-connected-account payment method domains (automatic).** The storefront is
  path-based on one host (`pos.pizzadao.org/shop/<slug>` today), so each pizzeria's
  account must register that host.
  - New `ensurePaymentMethodDomains(accountId)` in `src/lib/payments/connect.ts`:
    1. For each domain in `STOREFRONT_DOMAINS` (prod `pos.pizzadao.org`; staging
       `staging-pos.pizzadao.org`), `GET /v1/payment_method_domains?domain_name=…` with
       `Stripe-Account`.
    2. If missing, `POST /v1/payment_method_domains {domain_name, enabled:true}`.
    3. If it exists but Apple Pay status isn't `active`, `POST …/{id}/validate`.
    4. Persist the result in `connect_accounts.pm_domains`.
  - **Triggers:**
    - `connect-hardening`'s `account.updated` handler, when `charges_enabled` first
      becomes true
    - the onboarding wizard's `go_live` step
    - an admin "Re-check wallets" button
    - a one-off `scripts/backfill-pm-domains.mjs`, run per mode

    Idempotent.
  - Also register the domains on the **platform** account (once, via the script), and
    host Stripe's Apple Pay association file at
    `public/.well-known/apple-developer-merchantid-domain-association` (from the Stripe
    dashboard). Confirm at implementation whether connected-account registration still
    needs the file; it is harmless either way.
  - Each **new storefront domain** (for example a per-tenant custom domain later) means
    adding it to `STOREFRONT_DOMAINS` and rerunning.
- **Where keys and ids come from:** `GET /api/shop/location` returns
  `card: { mode:'stripe'|'simulated', publishableKey, stripeAccount }`.
  - The publishable key comes from runtime env through `getStripeConfig()`. Assert that
    the pk and sk modes match.
  - `stripeAccount` comes from `resolveCardConnectAccountId(location.tenant_id)` and is
    only sent when `cardReady`. An `acct_` id is not secret.
  - The `clientSecret` is returned only from `/pay`.

### 4. Onchain USDC on Base (real UX)

**Money goes to the pizzeria's own wallet. We never hold keys or funds.**

**Per-tenant wallet:** new table `tenant_crypto_wallets`.

| Column | Notes |
|---|---|
| `tenant_id` | FK |
| `chain_id` | int; 8453 Base mainnet, 84532 Base Sepolia |
| `usdc_address` | text |
| `pay_to_address` | text, EIP-55 checksummed |
| `verified_at` | timestamptz |
| timestamps | |

The primary key is `(tenant_id, chain_id)`. Admin → Payments gets a "USDC wallet" card
where the owner pastes an address, or connects a wallet via Privy and signs a message
(which sets `verified_at`). USDC is hidden in the shop unless the tenant has a wallet for
the deployment's `BASE_CHAIN_ID`. `CRYPTO_PAY_TO_ADDRESS` is removed. Simulated mode keeps
a sim address.

**Unique amount tag (matching without per-order addresses or custody):**
- `createCharge` sets `expected_units = due_cents × 10⁴ + tag`, where `tag` is in
  `1..9999` (less than $0.01). The tag is unique among open USDC tenders for that
  `pay_to`, enforced by a retry loop against a unique partial index on
  `payments ((raw->>'pay_to'), (raw->>'usdc_units')) where rail='crypto_onchain_usdc' and status='pending'`.
- Store `raw = { pay_to, usdc_units, chain_id, start_block (eth_blockNumber at creation), expires_at }`.
  `chargeId` is the tender id. The tx hash goes in `crypto_tx_hash`.

**Shop UX** (new `crypto-usdc-payment.tsx`):
- Shows the amount (`10.0042 USDC`, with a copy button), the address (copy), a "Base"
  network badge with a warning to send only USDC on Base, and a countdown to expiry.
- A **QR code** encoding EIP-681:
  `ethereum:<usdc>@<chainId>/transfer?address=<payTo>&uint256=<units>`, rendered as an SVG
  with the `qrcode` npm package.
- **"Pay with wallet" (Privy):** lazy-load `@privy-io/react-auth` and `viem` only when
  USDC is selected.
  - Connect an external wallet (MetaMask, Coinbase Wallet/Smart Wallet, WalletConnect) or a
    Privy embedded wallet, with no user login.
  - Switch to Base, send ERC-20 `transfer(payTo, units)`, take the tx hash, and
    `POST /api/shop/orders/[id]/pay/report-tx {txHash}`.
- **Manual send:** an optional "I've sent it, paste the tx hash" field (same endpoint). The
  watcher finds the transfer without it anyway.
- **Status polling:** `POST …/pay/sync` every 5 s (server rate-limited), showing
  "Waiting for payment" → "Seen, N/3 confirmations" → done when `orderStatus` is `paid`.

**Watcher** (`providers/base-provider.ts`, extended, still raw JSON-RPC with no server web3
dependency):
- **`verifyUsdcTransfer(txHash, {usdc, payTo})`:** gets the receipt and decodes `Transfer`
  logs. It requires `log.address == usdc`, `topic0 == Transfer(address,address,uint256)`
  (hard-coded constant) and `topic2 == payTo`, and returns `value` (BigInt), `from`,
  block and confirmations. **Never trust receipt status alone.**
- **`scanUsdcTransfers(payTo, fromBlock)`:** `eth_getLogs` on the USDC contract with
  topics `[Transfer, null, pad(payTo)]`, chunked by 2k blocks. **This needs a provider
  RPC** (Alchemy, QuickNode or CDP). Public `mainnet.base.org` rate-limits `getLogs`.
- **Matching:**
  1. A reported hash is verified directly. It must be after `start_block` and not already
     used, which the unique tx-hash index enforces.
  2. Otherwise the scan matches `value == expected_units` exactly.
  3. Unmatched inbound transfers to a tenant wallet go to an admin "unmatched crypto
     receipts" list for manual reconciliation.
- **Confirmations:** `REQUIRED_CONFIRMATIONS = 3` (about 6 s on Base). The tender is
  `pending`, then `applyRailStatus(captured)`, then finalize.
- **Under/overpay** (on a verified hash):
  - **Underpay:** the tender is `captured` with `amount_cents = floor(value / 10⁴)` and
    `raw.underpaid_units`. The order stays `awaiting_payment`. The UI offers "send the
    remaining X" as a new tender (`deriveTenderId(orderId, rail, seq+1)`, new tag) or "pay
    the rest by card". The split-tender model already sums settled tenders against
    `orderDueCents`.
  - **Overpay:** captured, with `raw.overpaid_units`. Above $0.50 (env) an admin "refund
    overpayment" flag is set. The sub-cent tag is ignored.
  - **Late** (after expiry plus grace): see section 1.
  - **Refunds** stay manual from the pizzeria's wallet (the rail records the intent, as
    today). Admin copy explains this.
- **Triggers:** client sync polling, the 5-min cron, and `report-tx`. Alchemy
  Address-Activity webhooks are a later optimisation.

### 5. Coinbase (hosted checkout, redirect, return, webhook)

- **Provider:** migrate `coinbase-client.ts` to the **Coinbase Business Checkouts API**:
  - `POST https://business.coinbase.com/api/v1/checkouts` with a CDP JWT bearer, signed
    with the tenant's API key.
  - amount and currency from `orderDueCents + tip`
  - `metadata {order_id, payment_id, tenant_id}`
  - `expiresAt` set to the order expiry
  - a success/redirect URL of `/shop/{slug}/track/{orderId}?pay_return=coinbase`, if the
    API supports one (verify the field names at implementation)

  `status()` uses Get Checkout: `COMPLETED` means captured; `EXPIRED`, `DEACTIVATED` or
  `FAILED` mean canceled or failed.
- **Funds go to the pizzeria:** new table `tenant_coinbase_accounts`.

  | Column | Notes |
  |---|---|
  | `tenant_id` | PK |
  | `cdp_api_key_id` | |
  | `cdp_api_key_secret_id` | Supabase **Vault** reference; never stored in plain text |
  | `webhook_secret_id` | Vault reference |
  | `status` | |
  | timestamps | |

  RLS: members read **without** secrets, and owner/manager write. Decryption happens only
  through a `security definer` function granted to `service_role`. The admin "Connect
  Coinbase" form posts the keys server-side. Coinbase is hidden in the shop unless it is
  configured for the tenant. The platform-wide `COINBASE_COMMERCE_API_KEY` is removed.
- **Flow:**
  1. `/pay {rail:'crypto_coinbase'}` creates the checkout (keyed by the tender id) and
     returns `hostedUrl`.
  2. The client navigates there.
  3. The return lands on the track page, which calls sync (server-side Get Checkout).
     **A redirect is never proof of payment**; only `COMPLETED` is.
- **Webhook** `/api/payments/coinbase/webhook`:
  - Subscribe to `checkout.payment.success|failed|expired`, per tenant CDP account (or one
    platform subscription, if Coinbase supports one).
  - Verify per the CDP webhooks doc. This differs from the legacy `X-CC-Webhook-Signature`;
    keep the legacy verifier only during migration.
  - Match the tender by checkout id or `metadata.payment_id`, check the tenant, then
    `applyRailStatus`, then finalize or abandon.
- **Fallback** if Coinbase Business isn't viable for the pilot: launch with USDC-direct
  only and hide Coinbase. The lifecycle work is unaffected.

### 6. CSP, Permissions-Policy, COOP (`src/lib/security/headers.ts`)

| Directive | Add | For |
|---|---|---|
| `script-src` | `https://challenges.cloudflare.com` | Privy |
| `frame-src` | `https://hooks.stripe.com`, `https://*.js.stripe.com`, `https://auth.privy.io`, `https://verify.walletconnect.com`, `https://verify.walletconnect.org`, `https://challenges.cloudflare.com` | 3DS, Stripe frames, Privy, WalletConnect |
| `child-src` (new) | `https://auth.privy.io`, `https://verify.walletconnect.com`, `https://verify.walletconnect.org` | Privy |
| `connect-src` | `https://auth.privy.io`, `wss://relay.walletconnect.com`, `wss://relay.walletconnect.org`, `wss://www.walletlink.org`, `https://*.rpc.privy.systems`, `https://explorer-api.walletconnect.com` | Privy and wallets |

The paid Base RPC is server-side only, so it needs no CSP entry.

- **Permissions-Policy:** change `payment=(self)` to
  `payment=(self "https://js.stripe.com" "https://*.js.stripe.com")`, otherwise Apple Pay
  and Google Pay never render in Stripe's iframe.
- **COOP:** `same-origin` breaks popup-based wallets (the Coinbase Smart Wallet keys popup,
  WalletConnect flows). Use `same-origin-allow-popups` on `/shop/:path*` (a per-path entry
  in `next.config.ts`), and keep `same-origin` elsewhere. Verify against the Coinbase Smart
  Wallet docs.
- **Privy dashboard:** allow the `pos.pizzadao.org` and `staging-pos.pizzadao.org` origins.
- Update `headers.test.ts`.

### 7. Staging environment (Stripe test mode, prod Supabase, isolated e2e tenant)

**Setup (one-time):**
1. **Vercel custom environment:** Project `pos` → Settings → Environments → Create
   "staging" (Pro allows one). Optional branch tracking on `staging`.
   - Deploy with `vercel-deploy --target=staging` (the wrapper passes args through).
   - Attach the domain `staging-pos.pizzadao.org` to that environment.
   - Keep Deployment Protection on, and create a **Protection Bypass for Automation**
     secret.
2. **DNS:** first confirm `pizzadao.org` is managed by `~/Code/namecheap`. Then dry-run,
   and add `--apply`:
   `python3 ~/Code/namecheap/add-dns-record.py pizzadao.org staging-pos CNAME cname.vercel-dns.com`.
   Otherwise PizzaDAO's DNS admin adds it.
3. **Staging env vars** (`vercel env add <NAME> staging`):

   | Area | Variables |
   |---|---|
   | Supabase | prod Supabase URL and keys |
   | Stripe | Open Pizza **test** `STRIPE_SECRET_KEY` / `STRIPE_PUBLISHABLE_KEY` / `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`, test `STRIPE_WEBHOOK_SECRET` (Connect endpoint) and `STRIPE_BILLING_WEBHOOK_SECRET`, test `STRIPE_PRICE_*` |
   | Wallets and storefront | `STOREFRONT_DOMAINS=staging-pos.pizzadao.org` |
   | Base | `BASE_CHAIN_ID=84532`, `BASE_RPC_URL=<Base Sepolia provider URL>`, `USDC_CONTRACT_ADDRESS=0x036CbD53842c5426634e7929541eC2318f3dCF7e` (Circle's Base Sepolia USDC; verify) |
   | Privy | `NEXT_PUBLIC_PRIVY_APP_ID` |
   | Coinbase | sandbox credentials only if they exist, else Coinbase is disabled |
   | Cron and isolation | `CRON_SECRET`, **`TENANT_ALLOWLIST=e2e-pizzeria`** |

4. **Tenant allowlist guard** (new, small): when `TENANT_ALLOWLIST` is set, `/shop/*`,
   `/api/shop/*` and the cron only serve or sweep those tenants (404 otherwise). Staging
   then can never put an order on the real pizzeria's KDS.
5. **Stripe test-mode webhooks:**
   - Connect endpoint
     `https://staging-pos.pizzadao.org/api/payments/stripe/webhook?x-vercel-protection-bypass=<secret>`
     (events `payment_intent.*`, `account.updated`)
   - Account endpoint `…/api/billing/webhook?x-vercel-protection-bypass=<secret>`

   The query-param bypass lets Stripe through Deployment Protection.
6. **Supabase Auth:** add `https://staging-pos.pizzadao.org/**` to the redirect allow-list
   (Dashboard → Auth → URL Configuration). The scoped CLI token can't change auth config,
   so Snax does this.
7. **e2e tenant:** create `e2e-pizzeria` via the signup wizard **on staging**, so Connect
   onboarding runs in test mode and `connect_accounts` holds a test `acct_`. Pro plan.
   Then:
   - Register a Base Sepolia pay-to wallet. The payer key is the CI secret
     `E2E_SEPOLIA_PAYER_KEY`, funded with Sepolia ETH and Circle-faucet USDC.
   - Run the pm-domain backfill in test mode.
   - Exclude the tenant from prod platform metrics (open question 6).
8. **Prod-side safety:** Vercel crons only run on **production**, which shares the DB.
   The sweeper and watcher skip tenders whose `raw.livemode`/`chain_id` don't match the
   deployment. Staging sweeps are triggered by the spec calling the cron route with
   `CRON_SECRET`.
9. **Migrations:** staging uses prod Supabase, so a branch's migrations must be on prod
   before staging tests. Every migration here is additive, so applying ahead of the code
   is safe. Run
   `SUPABASE_ACCESS_TOKEN="$(supabase-token)" npx supabase db push --linked --dry-run`,
   then push.

**How E2E targets it:**
- `playwright.config.ts`: when `VERCEL_AUTOMATION_BYPASS_SECRET` is set, add
  `extraHTTPHeaders: { 'x-vercel-protection-bypass': <secret>, 'x-vercel-set-bypass-cookie': 'true' }`.
- Run:
  `BASE_URL=https://staging-pos.pizzadao.org E2E_STRIPE=1 E2E_TENANT_SLUG=e2e-pizzeria VERCEL_AUTOMATION_BYPASS_SECRET=… CRON_SECRET=… E2E_SEPOLIA_PAYER_KEY=… npx playwright test shop-payments`
- Add a `workflow_dispatch` job in `.github/workflows/ci.yml` that runs the same with
  secrets.
- **Expiry in tests:** the cron route accepts `?asOf=<iso>` **only when
  `TENANT_ALLOWLIST` is set** (never in prod), so the spec can expire an order without
  waiting.

## Files (step by step; order = lifecycle → card → wallets → USDC → Coinbase → staging → tests)

1. **Migrations:** `20261101000000_order_status_lifecycle.sql` (enum only), then
   `20261101000100_online_checkout.sql`:
   - the indexes
   - the `tenant_crypto_wallets` and `tenant_coinbase_accounts` tables, with Vault refs,
     RLS, FORCE and grants
   - the security-definer secret reader
   - `connect_accounts.pm_domains`

   Extend `supabase/tests/rls_isolation.sql`: cross-tenant read and write on the new
   tables are denied, and secret columns are not readable by members.
2. **Types:** `src/lib/db/menu-types.ts` (`OrderStatus`, the `OrderFulfillment` quote
   fields), `payment-types.ts` (wallet and Coinbase config types).
3. **Drivers:** `src/lib/db/driver.ts`, `mock.ts`, `supabase.ts`:
   - `transitionOrderStatus` **[SHARED]** and `depleteInventoryForOrder`
   - `createOrder` skips depletion for `awaiting_payment`
   - `listOpenOnlineOrders(before)`
   - wallet and Coinbase config get/set
   - exclude the new statuses in health and EOD
4. `src/lib/payments/ids.ts` (new): `deriveTenderId`.
5. `src/lib/shop/lifecycle.ts` (new): `finalizeOnlinePayment` **[SHARED]**,
   `cancelOnlineCheckout`, `expireOnlineOrders`, `orderExpiresAt`.
6. `src/lib/payments/service.ts`: `maybeMarkOrderPaid` delegates `awaiting_payment` to
   finalize. The other service fixes ship in the security plan.
7. `src/lib/payments/rails/stripe-online.ts`:
   - `payment_method_types:['card']`
   - metadata and `receipt_email`
   - `retrieveIntent`, `cancelIntent`
   - `raw.livemode`
8. `src/lib/payments/connect.ts`: `ensurePaymentMethodDomains`. Wire it into the
   `account.updated` handler, the go-live step, the admin button, and
   `scripts/backfill-pm-domains.mjs`.
9. USDC rail and provider:
   - `rails/crypto-onchain-usdc.ts`: per-tenant wallet, tag, `start_block`, expiry,
     verify/scan status, under/overpay results
   - `providers/base-provider.ts`: `verifyUsdcTransfer`, `scanUsdcTransfers`
   - `env.ts`: `BASE_CHAIN_ID`, per-rail windows, `STOREFRONT_DOMAINS`,
     `TENANT_ALLOWLIST`; drop `CRYPTO_PAY_TO_ADDRESS`
10. Coinbase rail and provider:
    - `rails/crypto-coinbase.ts`, `providers/coinbase-client.ts`: Checkouts API, CDP JWT
      signing via `node:crypto` (match the CDP key type), per-tenant credentials
    - `api/payments/coinbase/webhook/route.ts`: the new verification and event mapping
11. **New API routes:**
    - `src/app/api/shop/orders/[id]/pay/route.ts` (all rails, TTL gate, rail switch)
    - `…/pay/sync/route.ts`
    - `…/pay/report-tx/route.ts`
    - `…/cancel/route.ts`
    - `src/app/api/cron/expire-online-orders/route.ts`
    - `src/app/api/admin/crypto-wallet/route.ts`, `src/app/api/admin/coinbase/route.ts`
      (owner/manager)

    Plus `vercel.json` crons.
12. **Existing routes:**
    - `src/app/api/shop/orders/route.ts`: `awaiting_payment`, persist the quote fields,
      remove the dispatch, 409 on an abandoned id, allowlist guard
    - `src/app/api/shop/location/route.ts`: the `card`, `usdc` and `coinbase`
      availability blocks
    - `src/app/api/payments/route.ts`: reject online rails for online orders
13. **Client:**
    - `package.json`: `@stripe/stripe-js`, `@stripe/react-stripe-js`,
      `@privy-io/react-auth`, `viem`, `qrcode`. Lazy-load Privy and viem.
    - `src/lib/store/use-shop-checkout.ts`: stable id, `pay`/`sync`/`reportTx`/`cancel`.
    - New components in `src/app/(shop)/shop/[location]/components/`:
      `stripe-payment.tsx` (Elements, Express Checkout, Payment Element),
      `crypto-usdc-payment.tsx`, `coinbase-payment.tsx`, `simulated-payment.tsx`.
    - `checkout-flow.tsx`: availability-driven rail picker, "done" only on `paid`.
    - The track page and `track-client.tsx`: new states, `?pay_return=` handling, resume
      and cancel.
14. **Admin:** wallet status and "Re-check wallets" in `connect-onboarding.tsx`. New USDC
    wallet and Coinbase cards. Unmatched-receipt, late-payment and overpay flags in the
    admin payments view.
15. **Other source:**
    - `src/lib/reports.ts`: exclude the new statuses
    - `src/lib/kds/status.ts`: labels
    - `src/lib/security/headers.ts` and `headers.test.ts`, plus the `/shop` COOP entry in
      `next.config.ts`
    - `public/.well-known/apple-developer-merchantid-domain-association`
    - `src/lib/shop/allowlist.ts`
16. **Docs:** `docs/PRODUCTION_READINESS.md` (rails, env, webhooks, cron, staging
    runbook), `docs/IDEMPOTENCY_REVIEW.md` (lifecycle, derived tender ids, tx-hash
    uniqueness), `PLAN.md` (order-status line), `.env.example`.

## Simulated mode (zero env, CI)

- `/api/shop/location` reports every rail as `mode:'simulated'`.
  - **Card:** a simulated panel, with no Stripe.js. `/pay` returns captured, then
    finalize, then `paid`.
  - **USDC:** a sim address, QR and countdown. It auto-confirms after 6 s via sync.
  - **Coinbase:** an in-app sim "hosted" confirm step (no external redirect) that
    auto-confirms.
- Without `NEXT_PUBLIC_PRIVY_APP_ID`, Privy never loads and "Pay with wallet" is hidden.
- The cron route works on the mock driver.
- **`e2e/shop.spec.ts` stays green unchanged.** Run it to confirm.

## Testing

**Unit tests (Vitest, zero env):**
- **Lifecycle:**
  - `awaiting_payment` is off the board, with no depletion or delivery.
  - Finalize under concurrent calls gives exactly one dispatch and one depletion.
  - ASAP `promised_at` is recomputed.
  - Per-rail expiry.
  - Late crypto within the grace window finalizes; after it, the order is flagged.
  - The sweeper skips mode-mismatched tenders.
- `deriveTenderId` is stable. A repeat `/pay` returns the same tender and the same
  `charge_id`.
- **USDC** (canned JSON-RPC fixtures):
  - Tag uniqueness.
  - `verifyUsdcTransfer` rejects the wrong token, the wrong recipient and reverted txs.
  - Exact gives captured; under gives a partial plus a remainder tender; over gives a
    flag.
  - The scan matches the exact amount only.
  - A duplicate tx hash is rejected.
- **Coinbase:** JWT shape, status mapping, webhook verify and match, tenant mismatch
  ignored.
- **Domains:** `ensurePaymentMethodDomains` is idempotent (exists, missing,
  inactive → validate).
- **Routes:** `/pay` (TTL 409, rail switch cancels the previous tender), `/pay/sync`
  verification mismatch, the `report-tx` rate limit, cron auth and `asOf` refused without
  the allowlist, the allowlist guard.
- `headers.test.ts`.

**Playwright, zero env (CI):** existing `shop.spec.ts`, plus:
- simulated USDC and Coinbase orders reach "Thanks…"
- an abandoned checkout never appears on the kitchen board

**Playwright, staging** (`e2e/shop-payments.spec.ts`, skipped unless `E2E_STRIPE=1`):
- **Card** (inside `iframe[title="Secure payment input frame"]`):

  | Card | Steps and expectations |
  |---|---|
  | 4242 4242 4242 4242 | Expect `paid`, and the ticket shows on the e2e location's KDS |
  | 4000 0025 0000 3155 (3DS) | `#challengeFrame` → Complete gives `paid`. A Fail variant leaves the order `awaiting_payment`; retry with 4242 and assert the **same order id and the same `pi_`** |
  | 4000 0000 0000 0002 | Decline: no KDS ticket; retry gives the same order and PI |
  | 4000 0000 0000 9995 | Insufficient-funds message |

  Also:
  - Abandon via `cron?asOf=`, which gives `abandoned` and a canceled PI.
  - Refund from admin (verifies the direct-charge refund parameters).
  - `raw.webhook_seen_at` is set, which proves the Connect endpoint is wired.
- **USDC (Base Sepolia):**
  1. Read the amount and address from the page.
  2. The runner sends the exact `transfer` from `E2E_SEPOLIA_PAYER_KEY`, using viem in the
     test.
  3. Expect `paid`.
  4. Underpay variant: the "send remaining" UI appears, then the remainder gives `paid`.
  5. Paste-hash variant: the `report-tx` path.
  6. Expiry variant: `asOf` gives `abandoned`, and a transfer after that is flagged as
     late.
- **Coinbase:** automated only if staging credentials and a test flow exist. Otherwise it
  is a manual checklist item.
- **Manual checklist:**
  - Apple Pay in Safari (macOS and iOS) and Google Pay in Chrome, after the domain
    backfill.
  - Privy wallet-connect with MetaMask and Coinbase Smart Wallet (the COOP check).
  - No CSP console violations across every rail.

## Risks

- **Scope:** roughly 2.5× the first draft. Ship in slices (below), with per-rail
  availability flags.
- **Coinbase eligibility and custody:** Business may be custodial and US/SG-only, and
  needs per-tenant credentials. USDC-direct is the fallback.
- **USDC:**
  - Wrong-amount sends become unmatched receipts that need manual reconciliation.
  - A wrong network is unrecoverable by us; the UI warns.
  - RPC rate limits need a paid provider.
- **Shared prod DB:**
  - The allowlist guard and the mode-matched sweeper are mandatory.
  - The e2e tenant pollutes prod platform metrics unless it is excluded.
  - Migrations must be applied before staging tests.
- **Wallets render only when three things are right:** domain registration,
  Permissions-Policy and the Privy origins. Each has a manual check.
- **Bundle weight:** Privy and viem are heavy. Lazy-load them and recheck the Lighthouse
  budget from `plans/quality-polish.md`.

## Open questions for Snax

1. **Coinbase:** is the pilot pizzeria eligible for Coinbase Business (US entity), and is
   custodial OK? May we store its CDP API key in Supabase Vault? If not, launch with
   USDC-direct only.
2. **Privy:** which Privy app (whose account)? Allowed origins `pos` and `staging-pos`. Is
   wallet-connect without user login OK?
3. **USDC policy:**
   - Overpay refund threshold of $0.50?
   - Late grace of 15 min?
   - Crypto window of **60 min** (recommended) vs card at 30?
4. **DNS:** is `pizzadao.org` in the Namecheap account `~/Code/namecheap` manages? If not,
   who adds `staging-pos`?
5. **Base RPC provider** for prod and Sepolia (Alchemy, QuickNode or CDP), and whose
   account?
6. **e2e tenant exclusion** from prod platform metrics: an `is_test` tenant flag (one small
   migration) or by slug?

## Size estimate

About **11–13 dev-days** in total. The security plan (about 1 day) is separate and ships
first.

| Area | Estimate |
|---|---|
| Lifecycle (migrations, drivers, finalize, cron, track/report/KDS touches) | 1.5 d |
| Card via Payment Element (deferred), sync, return handling | 1.25 d |
| Express Checkout, domain registration automation and backfill, CSP/Permissions/COOP | 1 d |
| USDC (wallet table and admin, tagging, verify/scan watcher, under/overpay, Privy wallet-connect, QR UI, report-tx) | 3.5 d |
| Coinbase Business migration (JWT, Vault creds, webhook, redirect/return) | 1.5–2 d |
| Staging environment, allowlist guard, mode-matched sweeper | 0.75 d |
| Unit tests | 1 d |
| Staging E2E (card and Sepolia USDC) and the manual wallet checklist | 1–1.5 d |

**Slices** (each mergeable, zero env green):
1. Lifecycle and everything simulated. This alone stops unpaid orders reaching the
   kitchen.
2. Card, wallets and staging environment, plus the card E2E.
3. USDC real UX, plus the Sepolia E2E.
4. Coinbase.

## Decisions (Snax, 2026-10-29)
- Launch scope stays as planned: card (Payment Element), Apple Pay and Google Pay (Express Checkout), onchain USDC on Base, and **Coinbase Business**.
  - Coinbase: build the Business Checkouts API with each pizzeria's own account and key in Supabase Vault.
  - Before building it, verify on Coinbase's own docs whether Commerce has shut down, plus Business eligibility and custody. Bring anything surprising back to Snax.
- Privy and Base RPC: reuse existing PizzaDAO accounts.
  - Privy: the app RSV.Pizza uses (`PRIVY_APP_ID` / `PRIVY_APP_SECRET` in the rsv-pizza backend). Add `pos.pizzadao.org` and `staging-pos.pizzadao.org` to its allowed origins.
  - RPC: rsv-pizza's `BASE_RPC_URL`, or the Alchemy key pizzadao-org uses (`ALCHEMY_API_KEY`) via `base-mainnet.g.alchemy.com`.
  - Confirm which with Snax and copy the values into the keychain when this slice starts.
- `pizzadao.org` DNS is on Namecheap BasicDNS. Use `/dns-add` for `staging-pos`.
