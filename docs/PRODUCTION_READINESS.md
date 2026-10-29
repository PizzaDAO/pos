# Production Readiness — Pizzeria POS (SaaS)

Phase 7 hardening. This document is the go-live checklist + the standing record
of the platform's correctness/security posture. It covers what is proven **now**
(against the mock driver + pure logic, zero env vars) and what remains gated on
the **final live-wiring phase** (real Supabase + Stripe + crypto + DoorDash).

> Status of the build today: everything runs on the in-memory **mock driver**
> (`getPosDriver()`) when no Supabase env is set, every payment rail **simulates**
> settlement when its keys are absent, and the full automated test suite +
> production build pass with **no environment variables**.
>
> **Persistence is now wired.** The real **Supabase driver** (`src/lib/db/supabase.ts`)
> implements the entire `PosDriver` contract over a complete Postgres schema
> (`supabase/migrations/20260605000000_domain_core.sql` + `..._domain_rls.sql`),
> with strict RLS on every table. Setting the Supabase env vars flips
> `getPosDriver()` to it with **no call-site changes**; absent them, the mock
> stays the default. The remaining go-live work is provisioning + credentials
> (below), not code.

---

## 1. Tenant-isolation audit (highest priority)

Tenant data leakage is the #1 risk for a multi-tenant SaaS. Isolation is enforced
at **two layers**, both with automated tests:

| Layer | Mechanism | Test |
|---|---|---|
| **Database (authoritative)** | Postgres **RLS** on every tenant table, keyed to the `memberships` table; `FORCE ROW LEVEL SECURITY` so even the table owner is default-denied; platform-admin bypass via `is_platform_admin()`. | `supabase/tests/rls_isolation.sql` (+ `run-rls-isolation.sh`, optional non-blocking CI job) |
| **Application** | Every `PosDriver` read is scoped by `tenant_id` (+ `location_id`). No call site issues an un-scoped query. | `src/lib/db/tenant-isolation.test.ts` (runs in required CI) |

The app-layer test proves a second tenant created via `createTenant` cannot have
its orders, menu, inventory, reports, or locations surfaced through another
tenant's driver calls. The SQL test proves a member of tenant A cannot read or
write tenant B's tenants/locations/memberships/users, that a blocked cross-tenant
write leaves no row, and that a platform admin sees everything.

**Customers do not insert orders directly.** `orders_insert` (migration
`20261030000000_orders_insert_staff_only.sql`) is limited to tenant members and
platform admins: online orders are written server-side by `/api/shop/orders`
(service role) after the cart is **repriced from the menu**, so a signed-in
customer can no longer write an order with arbitrary status/totals straight onto
the KDS. Customers keep SELECT on their own orders. `rls_isolation.sql` asserts
the customer insert is denied and a member insert still works.

The SQL isolation test now also covers the **operational tables** (orders,
payments) and the **public menu** surface: it asserts a member of tenant A sees
only tenant A's orders/payments, a cross-tenant order write is blocked and leaves
no row, the storefront `anon` role can read **both** tenants' menus + store
settings + a location-by-slug (public) but **cannot** read `tenants`, `orders`,
`payments`, `customers`, `staff`, or `memberships`, and cannot write the menu.

**RLS/grants model for the new tables** (`..._domain_rls.sql`):
- Every domain table has RLS **enabled + FORCED**, keyed to `memberships` via the
  same `is_tenant_member()` / `has_tenant_role()` / `is_platform_admin()` helpers.
- **Public menu read**: menu definition tables (categories/items/sizes/groups/
  modifiers/links), `location_menu_overrides`, and `store_settings` grant
  `SELECT` to `anon` (storefront renders for unauthenticated visitors). Writes
  stay owner/manager-only. `locations` gets an additive anon `SELECT` policy
  scoped to **active tenants** for slug resolution.
- **Least-privilege anon/authenticated grants** (corrective migration
  `..._least_privilege_grants.sql`, fixing a live finding that `anon`/
  `authenticated` held effectively ALL privileges on every table): `anon` holds
  `SELECT` ONLY on the storefront-public surface (the menu tables +
  `store_settings` + `locations`) and **nothing else** — no grant on `tenants`,
  `orders`, `payments`, `customers`, `memberships`, `staff`, `subscriptions`,
  `audit_log`, etc., so a read there is denied at the grant layer regardless of
  RLS. The blanket anon `tenants_public_select` (registry enumeration) was
  **dropped**. `authenticated` is trimmed to `SELECT/INSERT/UPDATE/DELETE` (no
  TRUNCATE/TRIGGER/REFERENCES). The app is unaffected: its data path is
  server-side via the `service_role` key (explicit tenant filters); the
  storefront never uses the anon role.
- **Customer-owns-their-data**: a signed-in customer (`auth.uid() == customers.id`)
  may read their own customer row + their own orders + those orders' line items,
  modifiers, payments, and delivery (via `can_read_order()`). They may also
  insert their own online order. All other order/payment writes are tenant-staff.
- Everything else (payments writes, inventory, staff/shifts, reports/close,
  payment_settings, connect, subscriptions, onboarding) is tenant-member /
  owner-manager scoped; `audit_log` is platform-admin only.
- Explicit `GRANT`s: `authenticated` gets full DML on every domain table (rows
  gated by policies); `anon` gets `SELECT` only on the storefront-public surface.

- **`users` + `platform_admins` are FORCED too** (migration
  `20260607000000_force_rls_users_platform_admins.sql`; they had RLS enabled but
  not forced). Safe because the identity-bridge trigger and the `is_*` helpers are
  `SECURITY DEFINER` and run as the function owner (`postgres`, BYPASSRLS/superuser
  on Supabase), which skips RLS even on forced tables; seed/`apply.sh` run as that
  same role and the app uses `service_role` (BYPASSRLS). The migration refuses to
  apply if `is_platform_admin()`'s owner can't bypass RLS (it would recurse). The
  isolation test asserts no public table is RLS-enabled-but-unforced.

**Go-live dependencies:**
- [x] Schema + RLS for orders/payments/menu/inventory/staff/settings/SaaS exist
      with the same `memberships`-keyed policies (RLS ON + FORCED on all).
- [x] **anon/authenticated grants are least-privilege** (corrective migration):
      anon = `SELECT` on the storefront-public surface only; authenticated =
      DML only; no anon tenant-registry read. Verified by the extended SQL
      isolation test (optional Postgres CI job).
- [ ] Provision Supabase; `npm run db:apply` (or `supabase db push` + seed).
- [ ] Wire Supabase Auth so `auth.uid() == public.users.id` (the RLS assumption).
- [ ] Confirm the **service-role key is never** used for tenant-scoped
      reads/writes without an explicit `tenant_id` filter — the Supabase driver
      already filters every tenant-scoped query by `tenant_id`/`location_id`.
- [ ] Run `run-rls-isolation.sh` against the live DB; expect "RLS isolation test PASSED".

---

## 1a. Real Supabase Auth (sessions, identity bridge, role gating, PIN)

Authentication is **env-guarded**, exactly like the data driver and the payment
rails: with the Supabase public env vars **unset** the app runs **simulated
auth** (no real login; every surface resolves a seeded demo session derived from
`memberships`, so the build + Vitest + the preview stay green with zero env).
With `NEXT_PUBLIC_SUPABASE_URL` + `NEXT_PUBLIC_SUPABASE_ANON_KEY` **set**, the app
uses **real Supabase Auth**.

### How it works
- **Session plumbing** (`@supabase/ssr`): a browser client
  (`src/lib/auth/supabase-browser.ts`), a cookie-backed server client
  (`src/lib/auth/supabase-server.ts`), and **middleware** (`src/middleware.ts`)
  that refreshes the session on every protected request and coarse-gates
  signed-out visitors to the right login. `getServerSession()`/`getCurrentUser()`
  (`src/lib/auth/session.ts`) returns the authed user + their `memberships`
  (tenant_ids + roles) + a platform-admin flag — all derived from the session,
  never a hardcoded constant.
- **Identity bridge** (`supabase/migrations/20260606000000_auth_user_bridge.sql`):
  a trigger on `auth.users` (insert) upserts a `public.users` row with
  `id = auth.users.id` and email, so `auth.uid() == public.users.id` (the RLS
  assumption). It links **existing seed users by email** by re-pointing the
  seeded `public.users.id` to the new auth id (FKs cascade on update), so the
  seeded owner/admin "become" real auth users when the bootstrap creates them.
  Idempotent; the trigger is skipped on vanilla Postgres (no `auth` schema).
- **Role gating matrix** (`src/lib/auth/roles.ts` + guards in
  `src/lib/auth/guard.ts`, enforced in each surface's server component):
  - `/admin` → **owner | manager** of the active tenant
  - `/terminal`, `/kitchen` → **owner | manager | cashier | kitchen** of the
    active location's tenant
  - `/platform` → **platform_admin only**
  - `/shop` → **public** (guest checkout; optional customer accounts)
  Unauthenticated → redirect to `/login` (tenant) or `/platform/login`. A
  multi-tenant user gets a chooser at `/login/choose`. Tenant-scoped **API
  routes** additionally re-check the session/membership against the request's
  tenant (`src/lib/auth/api.ts`) so a logged-in user can't act on another tenant.
- **Data access**: all **authorization** decisions come from the real
  session/memberships, and every tenant-scoped query is scoped to the
  session-derived tenant. The Supabase **driver still uses the service-role key**
  server-side (it implements the full `PosDriver` and filters every query by
  `tenant_id`/`location_id`); it is reserved for trusted server ops. Per-query
  user-scoped RLS clients are available (`getServerSupabase()`) and used by the
  auth flows; a full per-query RLS switch across the entire feature-complete app
  was intentionally **not** done in this pass (documented trade-off — RLS remains
  the backstop, the session is the gate).
- **Staff PIN quick-switch** (`src/lib/auth/pin.ts`, `/api/terminal/pin`): on a
  shared terminal the **device** is logged in (real session); cashiers then
  switch the **active staff** by a 4–8 digit PIN verified **server-side** against
  `staff.pin_hash` (scrypt). The hash never leaves the server (`listStaff` strips
  it; only `getStaffById` carries it). Placed orders attribute to the active
  staff via `orders.staff_id`. Demo seed PINs: Tony 1111 · Carmela 2222 ·
  Christopher 3333 · Furio 4444.

### Live Supabase Auth dashboard settings the orchestrator MUST set
In the Supabase project → **Authentication**:
- [ ] **Providers → Email**: enable Email; enable "Confirm email"; enable magic
      link (OTP). (Email/password optional.)
- [ ] **URL Configuration → Site URL**: the production domain
      (e.g. `https://pos.example.com`).
- [ ] **URL Configuration → Redirect URLs**: allow
      `https://<domain>/auth/callback` and `https://<domain>/shop/*` (the
      customer magic-link returns to `/shop/<slug>?signedin=1`). Add the Vercel
      preview domains too if you want auth to work on previews.
- [ ] Configure the **SMTP** sender (or rely on Supabase's built-in email for
      low volume) so magic links actually send.

### Post-deploy bootstrap (so you can log in)
1. `npm run db:apply` (applies all migrations incl. the identity bridge + seed).
2. `npm run auth:bootstrap` (run with `NEXT_PUBLIC_SUPABASE_URL` +
   `SUPABASE_SERVICE_ROLE_KEY` set; optional `BOOTSTRAP_*_PASSWORD`). Creates the
   Supabase Auth users for the demo **owner** (`tony@tonys-pizza.example`) and
   the **platform admin** (`ops@pizzapos.example`), email-confirmed; the bridge
   links them to the seeded membership / platform_admins rows.
3. Sign in at `/login` (owner → `/admin`, `/terminal`, `/kitchen`) and
   `/platform/login` (platform admin → `/platform`). Magic-link or password
   (if you set one). Then verify each role's gating per the matrix above.

---

## 2. Idempotency & double-charge guarantees

See `docs/IDEMPOTENCY_REVIEW.md` for the full review. Summary of the guarantees,
each covered by tests:

- **Orders** — `createOrder` is an idempotent **upsert-by-client-UUID**. The
  offline queue keys entries by the order UUID and the flush POSTs to
  `/api/orders`; a double-flush / reconnect-retry returns the existing order and
  assigns the order number **once**. (`offline/sync.test.ts`, `offline/queue.test.ts`)
- **Payments** — every tender carries a client UUID that is **both** the rail
  idempotency key **and** the payment row primary key. `takePayment` returns the
  existing tender on a repeat id → **no second charge**. (`payments/service.test.ts`)
- **Order settlement** — the order flips to `paid` only when **settled** tenders
  (captured/authorized) cover the total; pending crypto counts toward the
  displayed balance but **not** toward `paid`. Split payments drive the balance
  to zero across tenders. (`payments/service.test.ts`)
- **Refund/void** — a tender is marked `refunded` when fully refunded; the order
  flips to `refunded` only when **all** tenders are refunded; a partial refund
  does not. (`payments/service.test.ts`)
- **Deliveries** — `dispatchDelivery` is idempotent on the order id.
- **End-of-day** — `closeBusinessDay` is idempotent: re-closing returns the
  frozen Z-report snapshot. (`db/mock-drawer.test.ts`)

**Go-live dependencies:** forward the same client UUID as the Stripe
`Idempotency-Key` (already wired in the rails) and as the crypto deposit
reference; verify webhook handlers are idempotent on the charge id.

---

## 3. Offline / store-and-forward risk notes

- The terminal **always-queues** placed orders in IndexedDB (Dexie) keyed by the
  order UUID, then flushes idempotently — safe across reconnect + interval +
  manual triggers (the flush is re-entrant-guarded).
- **Offline card** uses Stripe Terminal **store-and-forward** (reader secure
  element queues the txn, forwards on reconnect). Known trade-offs, surface them
  in UX: per-txn cap + time window, **card-present only**, **no offline refunds**,
  and the **merchant carries decline risk**. Crypto + online card need connectivity.
- Mitigations in place: idempotent upsert end-to-end (no dupes on replay), clear
  pending-sync count in the terminal, and a balance model that won't ask a
  cashier to collect twice while a tender is in flight.

---

## 4. Connect / PCI posture

- **We never custody tenant card revenue.** Card charges (Terminal + online) are
  created on the tenant's **Stripe Connect connected account**; funds settle to
  **their** account. Our revenue is (1) **subscription** via Stripe Billing and
  (2) a per-order **`application_fee`** off card charges.
- **We never store a PAN / card data.** Card entry is handled by Stripe
  (Terminal hardware secure element / Stripe.js + PaymentIntents). No card number
  touches our servers or DB → **SAQ-A-level** scope. The `payments` table stores
  only rail-native ids (PaymentIntent id, charge id), amounts, and status.
- The platform fee is **disclosed to tenants at onboarding** and is **card-only**
  (cash + crypto carry no `application_fee` in v1). Fee math is clamped to the
  charge amount and proven in `payments/fees.test.ts`.

**Go-live dependencies:** complete Stripe **Connect KYC onboarding** per tenant
(Stripe handles identity/KYC); confirm payouts route to the tenant's bank; never
log card data; keep the service-role key server-only.

---

## 5. Crypto finality handling

- Quote + settle in **USDC** (USD-pegged → no FX risk for USD orders). USDC has 6
  decimals; cents → base units is integer math (no float drift).
- **Onchain (Base):** an order is **not** marked paid until the tx reaches
  `REQUIRED_CONFIRMATIONS` (3). The tender stays `pending` until then; the watcher
  (`status`) / webhook flips it to `captured`, which then settles the order.
  Reverted txs → `failed`. (`payments/service.test.ts` covers pending-not-paid →
  confirm-settles.)
- **Coinbase Commerce:** charge stays `pending` until a signature-verified
  `charge:confirmed`/`charge:resolved` webhook.
- Pending crypto counts toward the **displayed** balance (so the cashier isn't
  asked to collect twice) but never toward `paid`.

**Go-live dependencies:** set `BASE_RPC_URL` (+ Privy for per-order deposit
addresses) and/or `COINBASE_COMMERCE_API_KEY` + webhook secret; handle
under/overpay + quote expiry; decide platform-fee-on-crypto (v1: subscription-only).

---

## 6. Backups & data durability (Supabase)

- Use Supabase **Point-in-Time Recovery (PITR)** on the production project (paid
  tier) for continuous WAL backups; otherwise rely on daily automated backups.
- [ ] Enable PITR (or daily backups) on the prod project; document RPO/RTO.
- [ ] Periodically test a **restore** into a scratch project.
- [ ] Treat `supabase/migrations/*` as the source of truth; never hand-edit prod.
- [ ] Keep the `service_role` key in a secret manager; rotate on exposure.

---

## 7. Observability

Scaffolding added this phase, all **env-optional** and no-op-safe:

- **Structured logging** (`src/lib/observability/logger.ts`) — single-line JSON to
  stdout/stderr, `LOG_LEVEL`-aware (default `info`), with per-request child
  loggers carrying a correlation id.
- **Request/trace ids** (`src/lib/observability/trace.ts`) — reuse upstream
  `x-request-id` / `x-trace-id` / W3C `traceparent`, else mint one; echoed on the
  response. Wired into `/api/orders` (representative) + the health/ready endpoints.
- **Error-tracking seam** (`src/lib/observability/errors.ts`) — `captureError`
  always emits a structured error log and routes to Sentry
  (`@sentry/nextjs`, `Sentry.captureException`) **only when `SENTRY_DSN` /
  `NEXT_PUBLIC_SENTRY_DSN` is set**; log-only otherwise. Init lives in
  `src/instrumentation.ts` (server/edge) and `src/instrumentation-client.ts`
  (browser); `next.config.ts` wraps with `withSentryConfig` only when a DSN is
  set, uploads source maps only with `SENTRY_AUTH_TOKEN`, and the CSP gains the
  DSN's ingest origin in `connect-src` only then. All SDK imports are dynamic and gated on the DSN env vars, so a no-env build
  ships no Sentry code (first-load JS and middleware match the pre-Sentry sizes).
  Edge/middleware errors are not reported (the SDK is Node-runtime only).
- **Health/readiness** — `/api/health` (liveness) and `/api/ready` (readiness:
  probes the driver, reports training-mode + 503 if a future dependency is down).

**Go-live dependencies:** set `SENTRY_DSN` + `NEXT_PUBLIC_SENTRY_DSN` (and
`SENTRY_AUTH_TOKEN`/`SENTRY_ORG`/`SENTRY_PROJECT` for source maps) in Vercel;
point a log drain at the JSON logs; alert on `/api/ready` 503s + error-rate.

---

## 8. Training / demo mode

`src/lib/demo/mode.ts` formalizes a `TRAINING_MODE` flag (also implied whenever
the **mock driver** is active — the current default, where nothing is real). In
training mode, payments simulate and orders are disposable, so a tenant can train
staff without real charges. `/api/ready` and `demoModeInfo()` expose a badge
(`"TRAINING MODE — orders and payments are simulated"`; when training is on
only because Stripe is unset on a live driver: `"… card payments are simulated
(Stripe not configured)"`, since cash and crypto rails are unaffected).

Training is **also on whenever payments would be simulated** — i.e. the Stripe
secret key is unset (the same `isStripeConfigured()` check the rails use) — even
on the Supabase driver, so a half-wired production never reports
`trainingMode:false`. `/api/ready` also returns `paymentsSimulated`. The badge is
rendered server-side as an in-flow labelled `<aside>` (`src/components/training-banner.tsx`) in the terminal,
kitchen, and admin layouts.

**Card rails and training mode (payments-security-fixes, S10).** When training is
on because of the `TRAINING_MODE` flag **or the mock driver**, the card rails
(Stripe Terminal/online, Connect, connection tokens) take the **simulated path
whatever Stripe key is set** (`cardRailsSimulated()` in `payments/env.ts`), so a
live key plus the flag can never make a real charge behind a "training" banner.

Banner reasons, in precedence order (`/api/ready` returns `trainingReason`):

| Reason | When | Card rails |
|---|---|---|
| `flag` | `TRAINING_MODE` set | simulated |
| `mock` | mock driver | simulated |
| `stripe-unset` | live driver, no `STRIPE_SECRET_KEY` | simulated |
| `stripe-test` | live driver, `sk_test_` key, no flag | **real Stripe test mode** ("TRAINING — Stripe test mode, no real money") |
| none | live driver, `sk_live_` key, no flag | real |

**While production runs on Stripe TEST keys, drop `TRAINING_MODE=1`** so the real
test-mode Stripe path (Connect accounts, PaymentIntents, webhooks) is exercised;
the banner then reads "TRAINING — Stripe test mode, no real money". Leaving the
flag on keeps cards simulated and tests nothing in Stripe.

**Go-live:** the badge clears only when Supabase AND a live (`sk_live_`)
`STRIPE_SECRET_KEY` are set and `TRAINING_MODE` is off — that is the explicit
"now taking real orders" switch.

---

## 9. Environment variable inventory

Full annotated list in `.env.example` (all blank — **public repo, never commit
secrets**). Everything is optional; the app builds + the suite passes with none.

| Area | Vars | Unset behaviour |
|---|---|---|
| Supabase | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL` | Mock driver |
| Stripe (Connect/Terminal/online) | `STRIPE_SECRET_KEY`, `STRIPE_*PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_CONNECT_CLIENT_ID` | Simulated charges + Connect |
| Platform fee | `PLATFORM_FEE_BPS`, `PLATFORM_FEE_FLAT_CENTS` | 250 bps + 10¢ |
| Stripe Billing | `STRIPE_PRICE_STARTER/_PRO/_MULTI`, `STRIPE_BILLING_WEBHOOK_SECRET` | Simulated subscriptions |
| Crypto onchain | `BASE_RPC_URL`, `NEXT_PUBLIC_PRIVY_APP_ID`, `PRIVY_APP_SECRET`, `USDC_*`, `CRYPTO_PAY_TO_ADDRESS` | Simulated auto-confirm |
| Crypto Coinbase | `COINBASE_COMMERCE_API_KEY`, `COINBASE_COMMERCE_WEBHOOK_SECRET` | Simulated auto-confirm |
| KDS | `KDS_POLL_INTERVAL_MS`, `KITCHEN_PRINTER_URL` | Polling realtime + browser print |
| Delivery | `DOORDASH_DEVELOPER_ID`, `DOORDASH_KEY_ID`, `DOORDASH_SIGNING_SECRET`, `DOORDASH_BASE_URL` | In-house real, DoorDash simulated |
| Observability | `LOG_LEVEL`, `SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_DSN`, `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT` | info logs, Sentry fully inert, no source-map upload |
| Training | `TRAINING_MODE` | Mock driver or no `STRIPE_SECRET_KEY` ⇒ training on |
| Online checkout lifecycle | `CRON_SECRET`, `ONLINE_CHECKOUT_WINDOW_CARD_MIN` / `_COINBASE_MIN` / `_USDC_MIN` | Sweeper callable only on the mock driver; windows 30 / 60 / 60 min |
| App | `NEXT_PUBLIC_APP_URL` | Request origin |

---

## 10. Go-live checklist (depends on the final live-wiring phase)

- [ ] Provision Supabase; `npm run db:apply` (migrations + seed); enable + verify
      **RLS/FORCE** on all tenant tables; run the RLS isolation harness green
      (now covers orders/menu/payments).
- [ ] Wire Supabase Auth (`auth.uid() == users.id`) — the identity-bridge
      migration handles this; set the Supabase env vars (auto-selects the
      Supabase driver AND real auth; mock + simulated auth is the no-env
      default). Then set the live **Auth dashboard settings** (Site URL, redirect
      URLs, enable Email provider) and run **`npm run auth:bootstrap`** to create
      the owner + platform-admin Auth accounts. See **§1a "Real Supabase Auth"**.
- [ ] Verify the role-gating matrix live: signed-out → login; cashier blocked
      from `/admin`; non-admin blocked from `/platform`; staff PIN switch works.
- [ ] Enable **PITR/backups**; test a restore.
- [ ] Stripe: live keys + **Connect onboarding per tenant** (KYC); Billing Prices
      per tier; verify webhooks (payments, Connect, Billing) signature-checked.
- [ ] Crypto: `BASE_RPC_URL` (+ Privy) and/or Coinbase keys + webhook secret;
      confirm confirmation thresholds + under/overpay handling.
- [ ] DoorDash Drive keys (optional); confirm in-house dispatch.
- [ ] Observability: Sentry behind `SENTRY_DSN`; log drain; alerts on `/api/ready`.
- [ ] Flip `TRAINING_MODE` off for real stores; confirm the training badge clears.
- [ ] Hardware field test (reader, printer, drawer, tablet) — separate from this
      code phase.
- [ ] Re-run the full Vitest suite + production build with the live env; both green.

---

## 11. Security hardening (headers/CSP, rate limiting, audit, service-role)

Defense-in-depth added in the hardening pass, layered on top of (never replacing)
RLS + the session-gated auth model. All of it is **zero-env safe** (build + Vitest
green with no env) and adds **no new npm dependency**. Code lives under
`src/lib/security/*`; the threat model is in
`plans/arrabbiata-71129-phase-7-security-hardening.md`.

### 11a. Security headers + Content-Security-Policy

Applied to **every** route via `next.config.ts` `headers()` (source
`src/lib/security/headers.ts`), so `/shop`, `/`, and static routes are covered too
(middleware only matches the protected surfaces). Static values — no env reads.

| Header | Value (summary) | Defends |
|---|---|---|
| `Content-Security-Policy` | `default-src 'self'`; enumerated `script/style/img/font/connect/frame/worker/manifest-src`; `object-src 'none'`; `base-uri 'self'`; `form-action 'self'`; `frame-ancestors 'none'`; `upgrade-insecure-requests` | XSS, injection, clickjacking, downgrade |
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains; preload` | HTTPS downgrade/MITM (inert on localhost) |
| `X-Content-Type-Options` | `nosniff` | MIME-sniffing |
| `X-Frame-Options` | `DENY` | clickjacking (legacy companion to `frame-ancestors`) |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | referrer leakage |
| `Permissions-Policy` | `camera=()`, `microphone=()`, `geolocation=()`, `payment=(self)`, `usb=()`, … | feature abuse |
| `Cross-Origin-Opener-Policy` | `same-origin` | cross-origin tab interference |

**CSP nonce/hashing approach — documented trade-off.** The policy is **static**
(no per-request nonce). Next.js App Router injects framework **inline** runtime
scripts on every page; a nonce-based `script-src` would require minting a nonce in
middleware and threading it through the document, but this app's middleware
intentionally matches the protected surfaces only (`/admin|/terminal|/kitchen|
/platform`) — `/shop`, `/`, and statically-rendered routes are not matched, so a
nonce cannot be applied uniformly without broadening the matcher (out of scope and
it would break static optimisation). We therefore allow `script-src 'self'
'unsafe-inline'` (+ Stripe origins). This is weaker than a nonce, but the app
ships **no author-controlled inline scripts** (no inline `<script>`, no
`dangerouslySetInnerHTML`), so the practical XSS surface is small, and every other
directive is locked down. **Upgrade path:** mint a nonce in middleware, broaden the
matcher to all routes, set `script-src 'self' 'nonce-…' 'strict-dynamic'`, and pass
the nonce into the root layout. `connect-src`/`frame-src` are a superset of mock-
and live-mode origins (Supabase REST+WSS, Stripe API/JS, Base RPC) so a later env
flip needs no header change. The PWA service worker is covered by `worker-src
'self' blob:`.

> **Go-live check:** load the deployed preview, open devtools → Network → the
> document response, confirm the headers above are present, and watch the Console
> for any CSP violation while exercising terminal/shop/admin (esp. Stripe.js +
> Supabase Realtime). If a needed origin is blocked, add it to the relevant
> directive in `headers.ts` (do not loosen `script-src`).

### 11b. Rate limiting

Zero-dependency in-memory **fixed-window** limiter (`src/lib/security/rate-limit.ts`)
+ a route-handler guard (`enforceRateLimit` in `http.ts`) that derives the client
IP from `x-forwarded-for`/`x-real-ip`, limits per-IP (and per-account/email where
sensible), and returns **429 + `Retry-After` + `RateLimit-*`** headers. **No-op
when disabled** (`RATE_LIMIT_DISABLED`) or under tests (`VITEST`/`NODE_ENV=test`),
so CI/dev never throttle.

| Endpoint | Bucket (limit / 60s) | Keys |
|---|---|---|
| `POST /api/terminal/pin` | `pin` (8) | IP |
| `POST /api/shop/auth/magic-link` | `auth` (10) | IP + email |
| `POST /api/orders` | `orders` (60) | IP |
| `POST /api/shop/orders` | `orders` (60) | IP |
| `POST /api/payments` | `payments` (30) | IP |
| `POST /api/payments/refund` | `payments` (30) | IP |

**Coverage note for tenant/platform login:** the `/login` + `/platform/login`
forms call Supabase Auth **directly from the browser** (`signInWithOtp`/
`signInWithPassword`) — there is no first-party server endpoint to limit, and
Supabase enforces its own auth rate limits. The customer **magic-link** flow does
go through a server route and is limited above; the staff **PIN** path (the only
first-party credential check) is limited strictly.

**Caveat:** the store is **process-local**, so on serverless each instance keeps
its own window and the effective global limit scales with instance count. This is
a deliberate no-new-dep trade-off; for a hard global limit, swap `defaultLimiter`
for a shared store (Redis/Upstash) — call sites are unchanged.

### 11c. Audit logging (broadened)

Coverage of the existing append-only, tenant-scoped `audit_log` is broadened beyond
platform impersonation/lifecycle via a fail-open helper (`recordAudit` in
`src/lib/security/audit.ts` — it never throws, so a logging failure can't break the
primary action). New `AuditAction` values + where they are written:

| Action | Written at | Tenant-scoped |
|---|---|---|
| `auth_sign_in` | `/auth/callback` after a successful code exchange (one entry per membership; platform admins get a null-tenant entry; customers not audited) | yes (per membership) |
| `staff_pin_switch` | `/api/terminal/pin` on a verified PIN switch | yes |
| `payment_refund` / `payment_void` | `/api/payments/refund` (void = fully refunded) | yes |
| `menu_86` | `/api/admin/overrides` when availability is set false | yes |
| `connect_change` | `/api/connect` on Connect onboarding start/refresh | yes |
| `subscription_change` | `/api/billing` on subscribe / tier change / status advance | yes |
| `tenant_go_live` | `/api/signup` `go_live` | yes |
| `membership_change` | *reserved* — no dedicated member-management route yet; action defined for when one lands | yes |

Pre-existing (unchanged): `impersonate_start/end`, `tenant_suspend/reactivate`,
`subscription_override`. All surface read-only in `/platform`.

### 11d. Service-role key inventory + review (T8)

The service-role key (`SUPABASE_SERVICE_ROLE_KEY`) **bypasses RLS**, so every use
must be a trusted server op with an explicit tenant filter. Inventory after review:

- **Single construction site:** `src/lib/db/supabase.ts` →
  `readSupabaseConfig()` builds **one** `@supabase/supabase-js` client, preferring
  the service-role key (falling back to anon) on the server. This is the live
  `PosDriver`. It is the **only** code that reads the service-role key (verified by
  grep: the only other hit is a doc comment in `src/lib/auth/api.ts`).
- **Justification:** the driver implements the full server-side data contract
  (route handlers / RSC) for background + cross-cutting writes (order intake,
  payment persistence, reports) where there is no end-user RLS session; RLS remains
  the DB backstop and the **session is the gate** (route guards in
  `src/lib/auth/api.ts` re-check membership against the request's tenant).
- **Tenant-scoping audit (the key risk):** every tenant-scoped read/write in the
  driver carries an explicit `.eq("tenant_id", …)` (and `.eq("location_id", …)`
  where applicable): tenants/locations/menu/orders/payments/inventory/staff/shifts/
  reports/settings/subscriptions/onboarding/audit all filter by tenant. By-id
  lookups used internally (`getOrder`, `getPayment`, `getStaffById`,
  `getDrawerReconciliation`) are reached only after the route layer has authorized
  the caller for that object's tenant. **No un-scoped tenant query was found.**
- **User-scoped (RLS) path is used where it belongs:** the auth flows use
  `getServerSupabase()` (anon key + the user's session cookie → RLS-enforced), **not**
  the service-role client — the correct split. `pin_hash` is only carried on the
  server PIN-verification path (`getStaffById`) and stripped from list/upsert
  results.
- **Finding / fix:** `POST /api/payments/refund` previously performed a refund from
  a client-supplied `paymentId` with **no authorization** — any caller could refund
  any payment. Fixed: it now loads the payment, derives its tenant, and requires
  `requireTenantMember(tenant)` before refunding (and audits the result).
  `POST /api/connect` similarly gained an `owner|manager` check (money-routing).
- **Go-live:** keep the service-role key server-only (never `NEXT_PUBLIC_*`); store
  it in a secret manager; rotate on exposure. The driver's tenant-filter invariant
  is the load-bearing control — keep it covered by `tenant-isolation.test.ts`.

### 11e. Input validation (T9)

Dependency-free guards (`src/lib/security/validate.ts`): `readJsonBody` enforces a
**256 KB** body cap (413) before/after decode and rejects empty/invalid JSON (400);
`isMoneyCents` rejects negative/NaN/fractional/absurd amounts; `isClientId` bounds
length + allowlists charset; `isEmail` bounds + shape-checks. Wired into the
order/payment/refund/PIN/magic-link routes (the money + auth paths). Existing
domain-level validation (scheduling, zone gates, idempotency) is unchanged.

### 11f. Payments hardening (payments-security-fixes)

**Online order lifecycle (checkout-lifecycle, slice 1).** Every online order is
created `awaiting_payment` and becomes a real order only when it is paid:

```
awaiting_payment --(settled tenders cover the due amount)--> paid --> in_kitchen --> ...
        +--(expired / cancelled)--> abandoned
in-store: unchanged (placed -> paid)
```

- `awaiting_payment` and `abandoned` are not in `KDS_ACTIVE_STATUSES`, so such an
  order is off the kitchen board and the realtime feed; inventory is NOT depleted
  (`createOrder` skips it) and delivery is NOT dispatched. Reports, the EOD/Z
  report and tenant health exclude both statuses.
- `finalizeOnlinePayment` (`src/lib/shop/finalize.ts`, **shared with the terminal
  card-reader plan**) is the single promotion point, called from
  `maybeMarkOrderPaid`: compare-and-set `awaiting_payment -> paid`
  (`driver.transitionOrderStatus`, also shared), then (winner only) recompute an
  ASAP order's `promised_at` from payment time, deplete inventory
  (`driver.depleteInventoryForOrder`) and dispatch the delivery from the quote
  persisted on the order (`fulfillment.delivery_provider`, `zone_id`,
  `eta_minutes`). A failed dispatch leaves the order paid and on the KDS and
  writes a `failed` delivery record so it shows in admin dispatch. A settlement
  that arrives for an `abandoned`/`voided` order is NOT promoted; it is logged for
  a manual accept-or-refund.
- **Retries reuse the order.** The storefront mints the order id once per checkout
  and keeps it in `sessionStorage`, keyed by a signature of cart + fulfillment +
  time + address + email + tip (`src/lib/store/checkout-order-id.ts`). A material
  change mints a new id and cancels the old unpaid order best-effort.
  `POST /api/shop/orders` returns an existing order unchanged and answers 409
  (`checkout_abandoned`) for an abandoned one.
- **Expiry** (env, minutes): `ONLINE_CHECKOUT_WINDOW_CARD_MIN` (30),
  `_COINBASE_MIN` (60), `_USDC_MIN` (60), measured from `created_at` by the rail
  of the order's live tender. `POST /api/payments` refuses (409) after the window
  of the rail being paid, and re-checks ASAP availability.
- **Sweeper**: Vercel Cron `*/5 * * * *` calls `GET /api/cron/expire-online-orders`
  with `Authorization: Bearer $CRON_SECRET` (**set `CRON_SECRET` in production**;
  without it the route is only open on the mock driver). For each expired order it
  re-checks real tenders, cancels open card intents (a PaymentIntent that had
  succeeded finalizes the order instead; `processing` is skipped), cancels pending
  crypto, then moves the order to `abandoned` by compare-and-set. Real card
  tenders carry `raw.livemode`; a deployment never touches tenders of the other
  Stripe mode, nor real tenders when it simulates cards (prod and staging share a
  database, and Vercel crons run only on production).
- `POST /api/shop/orders/[id]/pay/sync` lets the shop and the tracking page ask the
  SERVER to re-check an order's open tenders (a crypto payment confirming). The
  UI treats only `orderStatus === 'paid'` as money received.
- Gaps in order numbers (abandoned orders consume one) are accepted.
- **Review hardening.**
  - *Race:* after a tender is written, `/api/payments` re-reads the order; if the
    sweeper/cancel abandoned it meanwhile, the PaymentIntent/Coinbase charge is
    canceled, the tender canceled, and the client gets 409 `checkout_abandoned`
    with no secret/URL. `checkout_abandoned` is only returned when the order really
    is abandoned; if a payment is in flight the code is `payment_pending` (keep
    waiting). The route and the sweeper share `orderExpiresAt` (earliest window of
    the live tenders).
  - *Late payments:* money settling on an `abandoned`/`voided` order does not
    promote it. It sets `fulfillment.late_payment` (durable, no schema change),
    alerts (`captureError`), writes an audit row (`late_payment_flagged`), and the
    order appears under Admin -> Late payments (owner/manager) where Accept
    (`finalizeOnlinePayment` from `abandoned`, compare-and-set) or Refund
    (`refundPayment`) resolves it. The tracking page says so instead of "Nothing
    was charged". `refundPayment` never turns an abandoned order into `refunded`.
    Closing a pending Coinbase tender cancels the charge at Coinbase (best effort,
    logged). Webhooks cannot 500 on the one-live-tender index: a settling flip
    cancels the newer unsettled tender and records the money; a double settlement
    is alerted.
  - *Crash recovery:* promotion stamps `fulfillment.paid_at`; inventory +
    dispatch (both idempotent) then stamp `finalized_at`. The sweeper re-runs the
    steps for paid orders with no `finalized_at` older than 2 minutes. A failed
    delivery dispatch is surfaced as a `failed` delivery record and does not block
    `finalized_at`.
  - *Sweeper:* keyset paging (100 x 20 per run), orders carry
    `fulfillment.checkout_mode` (live/test/sim) and a deployment only queries its
    own mode (unmarked legacy orders included), settled-but-uncovering expired
    orders raise `checkout.in_flight` alerts, `maxDuration = 60`.
  - *Switching rails* cancels the other open tender (card intent, pending USDC
    locally, pending Coinbase with the provider; a USDC tender with a reported tx
    hash and a processing card are never canceled). Several cash tenders (client
    ids) may split an online bill. `/pay/sync` has its own `paySync` rate bucket.
  - *Second review round.*
    - Crypto refunds never claim to move money: `refundPayment` only records the
      intent for USDC/Coinbase, so the refund API returns `manualRefund` + a note,
      the terminal shows it, and the admin late-payment Refund leaves crypto
      tenders `captured` with the item `refund_owed_manual` (listed with amounts,
      return address if known and a Coinbase link) until staff press Mark refunded
      (audited). The tracking page says "Your refund is being processed" until then.
    - Accept/Refund/Mark refunded first CLAIM the marker with an atomic
      compare-and-set (`claim_late_payment`), so concurrent actions cannot both
      act; marker updates are atomic RPCs (`update_late_payment`,
      `merge_order_fulfillment`), not read-modify-write.
    - The one-open-tender index now covers only `requires_action`/`pending`, so a
      settlement can always be recorded (never captured money stored as canceled).
      When an online order ends up with more settled money than it is worth, a
      `duplicate` marker ("Duplicate payment, refund one") appears in the same tab.
      Cancels are STRICT: a provider that refuses (Coinbase payment detected, card
      confirming) is re-synced, never marked canceled; the sweeper leaves such an
      order `awaiting_payment`.
    - Cash on an online order: till-role check first; partial cash carries no tip
      (the final covering tender does); a racing overpaying cash tender is voided
      deterministically. A REAL pending USDC tender is never auto-canceled (TODO
      slice 3).
    - Recovery: grace 6 min (> the cron's 60 s maxDuration), per-item idempotent
      depletion, one delivery per order (`deliveries_order_id_uidx`), exponential
      backoff on failing orders, oldest-`paid_at` first, expired delivery quotes
      re-quoted. Orders stamped with another deployment mode are swept/recovered
      after 24 h if they hold no real tender, otherwise alerted once.
    - Late payments come from a dedicated capped query (`listOpenLatePayments`).
    - Migration `20261101000300_late_payment_and_idempotency.sql`.
  - Migration `20261101000200_audit_action_values.sql` adds the late-payment audit
    actions and the Phase 7 actions (`payment_refund`, `payment_void`, ...) that
    were never in the DB enum, so those audit rows had been silently dropped.

- **Shop orders are repriced server-side.** `POST /api/shop/orders` rebuilds every
  line from `driver.getMenu` (location overrides applied, 86'd items excluded) via
  `src/lib/shop/reprice.ts`; client prices, names and stations are ignored.
  Unknown/86'd items, bad sizes, illegal half placements, min/max_select
  violations and quantities outside 1-50 are 422. The tip must be an integer
  between 0 and the subtotal. The route is rate-limited (`orders` bucket).
- **`GET /api/payments?orderId=`** requires a member of the order's tenant, and
  tenders are returned without rail internals (`publicTender`). The Stripe
  `client_secret` is never stored; it is returned only in the `POST /api/payments`
  response that created the intent.
- **Stripe Connect webhook** (`/api/payments/stripe/webhook`, secret
  `STRIPE_WEBHOOK_SECRET`; the Billing endpoint `/api/billing/webhook` uses
  `STRIPE_BILLING_WEBHOOK_SECRET`): signatures use a 5-minute timestamp tolerance
  and accept any of several `v1` entries (secret rotation). `payment_intent.*`
  events must carry `account` equal to the tender's `connect_account_id`, and the
  intent amount and currency must match the tender, or they are ignored (200,
  logged). Only `succeeded`, `processing`, `payment_failed`, `canceled` and
  `account.updated` are acted on.
- **Refunds** require `owner` or `manager` (not cashier/kitchen). Direct-charge
  refunds are made on the connected account with no `reverse_transfer`;
  `refund_application_fee` is set on every refund, so Stripe returns the platform
  fee in proportion to each refund (`REFUND_APPLICATION_FEE` in
  `payments/fees.ts`). The idempotency key is per refund request: the client
  sends a `refundId` (reused on retry), so repeated partial refunds work and a
  retried identical request is a no-op.
- **Currency** is always the order's; a payment body naming another currency is
  400, and tenders in another currency never cover an order.
- **Connect accounts** are managed on `isStripeConfigured()` (not training mode),
  and the drivers refuse to overwrite a real `acct_` row with a simulated one.
  Only card CHARGE rails follow `cardRailsSimulated()`.
- **Online orders** accept only `stripe_online`, crypto and (staff-only) cash.
  An unconfigured crypto rail is refused unless the whole environment is a
  simulation, and `/api/shop/location` returns `cryptoReady` so the shop hides it.
  Before a new `stripe_online` intent is created, earlier ones still in
  `requires_action` are canceled on the connected account.
- **Order lines** get server-minted ids; the Supabase `createOrder` deletes the
  order row if writing its lines fails (no item-less `placed` order).
- **Concurrent intent creation is closed.** Two simultaneous `POST /api/payments`
  calls for one online order could each create a `stripe_online` intent (the
  cancel-earlier-intents step runs before creation, not under a lock). Two layers
  now close it: (1) an ONLINE order's tender id is DERIVED from the order id +
  rail (`deriveTenderId`, UUIDv5; the client's `paymentId` is ignored), so
  concurrent calls are the same tender and the same Stripe idempotency key; and
  (2) the partial unique index `payments_one_live_card_or_cb`
  (`(order_id, rail) where rail in ('stripe_online','crypto_coinbase') and status
  not in ('canceled','failed')`, migration `20261101000100_online_checkout.sql`)
  makes the database refuse a second live card/Coinbase tender for an order. On
  that conflict `takePayment` cancels the orphan PaymentIntent it just created and
  the route answers 409. A canceled/failed tender frees the slot (rail switch,
  retry after a decline). The mock driver enforces the same rule.
- **Unpaid-order cancel** (`POST /api/shop/orders/cancel`). An `awaiting_payment`
  order (see "Online order lifecycle" below) is moved to `abandoned` after its open
  card intents are canceled, by compare-and-set; a settled or in-flight tender
  refuses it (409). `abandoned` (not `voided`) is deliberate: the order never rang,
  so it must not show in the void tallies. The previous rule (void a `placed`
  online order within 10 minutes with no live tender, and cancel its delivery) is
  kept ONLY for legacy `placed` orders created before the lifecycle shipped; delete
  that branch once none can exist.
- **Refund bookkeeping is atomic** (`reserve_payment_refund` /
  `release_payment_refund`, migration `20261030000100_payment_refund_atomic.sql`,
  new `payments.refund_ids` column): cash/crypto reserve before calling the rail
  (released on failure); cards call Stripe first (it caps the money and dedupes on
  the key) and then record atomically. `upsertPayment` never touches
  `refunded_cents`/`refund_ids` on an existing tender.
- **Live key guard.** With `sk_live_`/`rk_live_` and `VERCEL_ENV` not
  `production`, Connect account creation and card charges are refused.
