# pos — Pizzeria Point of Sale (SaaS)

A multi-tenant SaaS point-of-sale platform for pizzerias. Independent pizzerias sign up, run one or more locations, take in-store (offline-capable PWA terminal) and online orders, and get paid into their own accounts via Stripe Connect. Operated as a subscription + per-order-fee platform.

## Surfaces

- **`/terminal`** — counter POS (Web PWA, offline-first)
- **`/kitchen`** — kitchen display system (KDS)
- **`/admin`** — tenant back office (menu, inventory, reports, staff)
- **`/shop/{location}`** — customer online ordering (pickup + delivery)
- **`/platform`** — super-admin (us): tenants, billing, support

## Stack

Next.js 15 (App Router, TypeScript) · Supabase (Postgres + RLS + Realtime + Auth) · Stripe Connect + Stripe Terminal + Stripe Billing · Crypto (USDC on Base + Coinbase Commerce) · Vercel (pizza-dao).

## Status

Greenfield. Build is phased — see [`PLAN.md`](./PLAN.md) for the full architecture and [`plans/`](./plans) for per-phase task plans.

| Phase | Scope                                                                                                 |
| ----- | ----------------------------------------------------------------------------------------------------- |
| 0     | Platform foundations: scaffold, tenancy + RLS schema, route groups, pluggable interfaces, sample seed |
| 1     | Terminal order taking + menu, offline queue, PWA                                                      |
| 2     | Payments + Stripe Connect (card, cash, crypto)                                                        |
| 3     | Kitchen display / tickets                                                                             |
| 4     | Customer online ordering + delivery                                                                   |
| 5     | Back office                                                                                           |
| 6     | Self-serve SaaS layer (signup, billing, super-admin)                                                  |
| 7     | Production hardening                                                                                  |

## Develop

```bash
npm install
npm run dev        # http://localhost:3000
```

No environment variables are required to build or run the Phase 0 scaffold. See `.env.example` for variables added in later phases.

Useful scripts:

```bash
npm run build        # production build (succeeds with no env vars)
npm run typecheck    # tsc --noEmit (strict)
npm run lint         # next lint
npm run format       # prettier --write .
```

### Surfaces (placeholders in Phase 0)

`/` landing · `/api/health` (`{ ok: true }`) · `/terminal` · `/kitchen` · `/admin` · `/shop/[location]` · `/platform`

### Database (Supabase — deferred)

Phase 0 ships the tenancy schema + strict RLS as **migration files** under
[`supabase/`](./supabase) — there is no live database yet and the app needs no
Supabase env vars. See [`supabase/README.md`](./supabase/README.md) for the
isolation model and how to apply migrations / run the RLS isolation test once a
project exists.

> Tooling note: pnpm is the intended package manager (see `PLAN.md`), but this
> scaffold was generated with **npm** and commits `package-lock.json`. CI uses
> `npm ci`.
