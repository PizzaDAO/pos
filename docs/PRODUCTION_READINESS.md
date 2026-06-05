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

The SQL isolation test now also covers the **operational tables** (orders,
payments) and the **public menu** surface: it asserts a member of tenant A sees
only tenant A's orders/payments, a cross-tenant order write is blocked and leaves
no row, the storefront `anon` role can read **both** tenants' menus (public) but
**cannot** read any orders/payments or write the menu.

**RLS/grants model for the new tables** (`..._domain_rls.sql`):
- Every domain table has RLS **enabled + FORCED**, keyed to `memberships` via the
  same `is_tenant_member()` / `has_tenant_role()` / `is_platform_admin()` helpers.
- **Public menu read**: menu definition tables (categories/items/sizes/groups/
  modifiers/links), `location_menu_overrides`, and `store_settings` grant
  `SELECT` to `anon` (storefront renders for unauthenticated visitors). Writes
  stay owner/manager-only. `tenants`/`locations` get an additive anon `SELECT`
  policy for slug resolution.
- **Customer-owns-their-data**: a signed-in customer (`auth.uid() == customers.id`)
  may read their own customer row + their own orders + those orders' line items,
  modifiers, payments, and delivery (via `can_read_order()`). They may also
  insert their own online order. All other order/payment writes are tenant-staff.
- Everything else (payments writes, inventory, staff/shifts, reports/close,
  payment_settings, connect, subscriptions, onboarding) is tenant-member /
  owner-manager scoped; `audit_log` is platform-admin only.
- Explicit `GRANT`s: `authenticated` gets full DML on every domain table (rows
  gated by policies); `anon` gets `SELECT` only on the storefront-public surface.

**Go-live dependencies:**
- [x] Schema + RLS for orders/payments/menu/inventory/staff/settings/SaaS exist
      with the same `memberships`-keyed policies (RLS ON + FORCED on all).
- [ ] Provision Supabase; `npm run db:apply` (or `supabase db push` + seed).
- [ ] Wire Supabase Auth so `auth.uid() == public.users.id` (the RLS assumption).
- [ ] Confirm the **service-role key is never** used for tenant-scoped
      reads/writes without an explicit `tenant_id` filter — the Supabase driver
      already filters every tenant-scoped query by `tenant_id`/`location_id`.
- [ ] Run `run-rls-isolation.sh` against the live DB; expect "RLS isolation test PASSED".

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
  always emits a structured error log and routes to an external tracker (Sentry)
  **only when `SENTRY_DSN` is set**; a no-op otherwise (SDK intentionally not yet
  a dependency).
- **Health/readiness** — `/api/health` (liveness) and `/api/ready` (readiness:
  probes the driver, reports training-mode + 503 if a future dependency is down).

**Go-live dependencies:** add the Sentry SDK behind `SENTRY_DSN`; point a log
drain at the JSON logs; alert on `/api/ready` 503s + error-rate.

---

## 8. Training / demo mode

`src/lib/demo/mode.ts` formalizes a `TRAINING_MODE` flag (also implied whenever
the **mock driver** is active — the current default, where nothing is real). In
training mode, payments simulate and orders are disposable, so a tenant can train
staff without real charges. `/api/ready` and `demoModeInfo()` expose a badge
(`"TRAINING MODE — orders and payments are simulated and not charged."`).

**Go-live dependencies:** surface the training badge in the terminal/admin
chrome; ensure flipping `TRAINING_MODE` off (with live keys) is the explicit
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
| Observability | `LOG_LEVEL`, `SENTRY_DSN` | info logs, error-tracking no-op |
| Training | `TRAINING_MODE` | Mock driver ⇒ training on |
| App | `NEXT_PUBLIC_APP_URL` | Request origin |

---

## 10. Go-live checklist (depends on the final live-wiring phase)

- [ ] Provision Supabase; `npm run db:apply` (migrations + seed); enable + verify
      **RLS/FORCE** on all tenant tables; run the RLS isolation harness green
      (now covers orders/menu/payments).
- [ ] Wire Supabase Auth (`auth.uid() == users.id`). Set the Supabase env vars —
      `getPosDriver()` auto-selects the Supabase driver when they are present
      (no call-site changes; the mock is the no-env default).
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
