# diavola-88607 — Phase 7: Hardening for Production

Make the codebase production-trustworthy: a real automated test suite over the
risk areas, observability scaffolding, RLS harness, training mode, and
documented production readiness — all runnable **now** against the mock/pure
logic with **zero env vars**. No live Supabase/Stripe/crypto/DoorDash wiring
(that is the separate final phase).

## What was built

### 1. Automated test suite (Vitest)
- Added **Vitest 2** (+ `fake-indexeddb`, `jsdom`) as dev deps; wired
  `npm test` (watch) and `npm run test:run` (CI). `vitest.config.ts` mirrors the
  tsconfig `@/*` alias and runs in a Node environment.
- **106 tests across 15 files**, all passing with no env vars:

  | Risk area | File | Coverage |
  |---|---|---|
  | Money / pricing | `src/lib/pricing.test.ts` (14) | half-and-half (left+right == whole, ceil-rounded; no leak), size deltas, discount-before-tax, integer-cents invariants, round-half-up |
  | Platform fee | `src/lib/payments/fees.test.ts` (9) | bps+flat, round-half-up, clamp to charge, card-only, non-negative |
  | Payment idempotency / settlement | `src/lib/payments/service.test.ts` (8) | same UUID → one tender, paid-only-when-settled, split → zero balance, crypto pending-not-paid → confirm-settles, refund full/partial/void |
  | Offline queue | `src/lib/offline/queue.test.ts` (3), `sync.test.ts` (2) | idempotent upsert-by-UUID; double-flush + reconnect retry never duplicates |
  | Delivery | `src/lib/delivery/zones.test.ts` (8), `service.test.ts` (6) | out-of-zone + below-minimum rejected, fee/ETA quote, `pickProvider` selection (incl. pickup-only → null) |
  | Scheduling | `src/lib/shop/scheduling.test.ts` (12) | open/closed + midnight-wrap, ASAP gate, scheduled lead/horizon/hours rejections |
  | Entitlements | `src/lib/saas/entitlements.test.ts` (9) | over-limit location block on Starter / allowed on Pro / unlimited Multi, online-ordering + advanced-reports gates, canceled → blocked |
  | Reports | `src/lib/reports.test.ts` (7) | payment mix, **tip de-dup** (online order-level vs in-store tender), voids, failed-tender exclusion, per-location vs tenant rollup, date range |
  | Inventory | `src/lib/db/mock-inventory.test.ts` (5) | depletion on order (qty × line), low-stock flag, voided no-deplete, clamp ≥ 0 |
  | Drawer / Z-report | `src/lib/db/mock-drawer.test.ts` (4) | over/short math (over + short), idempotent business-day close |
  | App-layer tenant isolation | `src/lib/db/tenant-isolation.test.ts` (5) | a tenant can't read another's orders/menu/inventory/reports/locations via the driver |
  | Observability | `src/lib/observability/observability.test.ts` (11) | logger record/level, trace-id reuse/mint/traceparent, error seam log↔sentry |
  | Training mode | `src/lib/demo/mode.test.ts` (3) | env flag + mock-driver implies training |

### 2. RLS isolation harness
- Expanded `supabase/tests/rls_isolation.sql`: added assertions that the blocked
  cross-tenant write left **no row**, that **memberships** are tenant-scoped, and
  that a member can't read another tenant's **user** row.
- Added `supabase/tests/run-rls-isolation.sh` (one-command harness: apply
  migrations + run the test against any Postgres) and documented it in
  `supabase/README.md`.
- CI: added an **optional, non-blocking** `rls-isolation` job (Postgres service,
  `continue-on-error: true`) — a live DB is never a required CI gate.

### 3. Idempotency / double-charge review
- `docs/IDEMPOTENCY_REVIEW.md`: full review of order/payment/delivery/EOD
  idempotency with the test that pins each guarantee.
- **No double-charge/dupe bugs found.** Documented one behavioural nuance (not a
  bug): a live webhook that captures a tender by writing status *directly* via
  `upsertPayment` must also settle the order (the watcher path via
  `refreshPaymentStatus` already does). Noted for live wiring.

### 4. Observability scaffolding (all env-optional, no-op safe)
- `src/lib/observability/logger.ts` — structured JSON logs, `LOG_LEVEL`-aware,
  per-request child loggers.
- `src/lib/observability/trace.ts` — request/trace id (reuse `x-request-id` /
  `x-trace-id` / W3C `traceparent`, else mint), echoed on responses.
- `src/lib/observability/errors.ts` — `captureError` seam: structured-log no-op,
  routes to Sentry only when `SENTRY_DSN` set (SDK intentionally not a dep yet).
- Wired into `src/app/api/orders/route.ts` (representative route).
- `src/app/api/health/route.ts` (liveness, now echoes request id) +
  **new** `src/app/api/ready/route.ts` (readiness: probes the driver, reports
  training mode, 503 if a future dependency is down).

### 5. Production-readiness doc
- `docs/PRODUCTION_READINESS.md`: tenant-isolation audit (two-layer), idempotency
  guarantees, offline/store-and-forward risks, Connect/PCI posture (no PAN, SAQ-A
  scope, Connect application_fee), crypto finality, Supabase PITR/backups, full
  env-var inventory, and the go-live checklist gated on the live-wiring phase.

### 6. Training / demo mode
- `src/lib/demo/mode.ts`: `TRAINING_MODE` flag (also implied by the mock driver)
  + `demoModeInfo()` banner, surfaced by `/api/ready`. Documented in the readiness
  doc + `.env.example`.

### 7. CI
- Added a required **`test`** job (`npm run test:run`, zero env) to
  `.github/workflows/ci.yml` alongside `build`, plus the optional `rls-isolation`
  job.

### 8. Env
- `.env.example` extended with `LOG_LEVEL`, `SENTRY_DSN`, `TRAINING_MODE` (all
  blank — public repo).

## Local results (zero env vars)
- `npm run test:run` → **106 passed / 15 files**
- `npm run typecheck` → clean
- `npm run lint` → no warnings/errors
- `npm run build` → success (incl. new `/api/ready`)

## Scope discipline
No live services wired, no new product features. Tests, observability, docs, and
the small surface additions (ready endpoint, training flag) only. Everything is
green with no env vars.
