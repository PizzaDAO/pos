# margherita-60504 — Phase 0: Platform Foundations

**Priority:** P0 (blocks all other phases)
**Parent plan:** `../PLAN.md`
**GTM:** Pilot-first. Tenancy baked in from day one; self-serve onboarding deferred to Phase 6.

## Goal
Stand up the repository skeleton for the multi-tenant SaaS pizzeria POS: a Next.js 15 app deploying green on Vercel (pizza-dao scope), the five route-group surfaces, the tenancy + RLS database schema as **migration files** (no live Supabase yet — deferred), the pluggable PaymentRail / DeliveryProvider interface contracts as typed stubs, and a sample-pizzeria seed. This is scaffolding + schema + contracts only — no business logic.

## Constraints / decisions already made
- **Stack:** Next.js 15 (App Router), TypeScript, Tailwind + shadcn/ui, TanStack Query + Zustand. Package manager: pnpm.
- **Backend (DEFERRED):** Supabase. Phase 0 writes SQL migration files under `supabase/migrations/` and `supabase/seed.sql` but does NOT connect to a live project. No Supabase env vars required to build. Use a thin DB-access layer (`src/lib/db/`) that can later point at Supabase without changing call sites.
- **Hosting:** Vercel, pizza-dao scope. Repo: PizzaDAO/pos (public).
- **Money model:** Stripe Connect (per-tenant) + Stripe Billing (subscription) + per-order application_fee. Crypto: USDC on **Base** + Coinbase Commerce. (Not implemented in Phase 0 — interfaces only.)
- **Public repo:** NO secrets committed. `.env.example` only. All keys via Vercel/Supabase env later.

## Deliverables

### 1. Project scaffold
- `pnpm` + Next.js 15 App Router + TypeScript strict + ESLint + Prettier.
- Tailwind + shadcn/ui initialized.
- TanStack Query provider + Zustand store skeleton.
- `.env.example` documenting future vars (NEXT_PUBLIC_SUPABASE_URL, SUPABASE_*, STRIPE_*, etc.) — values blank.
- README with run instructions.

### 2. Route-group surfaces (App Router route groups)
Create the five surfaces as placeholder pages that render and deploy:
- `src/app/(terminal)/terminal` — POS terminal (will be PWA)
- `src/app/(kitchen)/kitchen` — KDS
- `src/app/(admin)/admin` — tenant back office
- `src/app/(shop)/shop/[location]` — customer storefront
- `src/app/(platform)/platform` — super-admin
- Root `/` — simple landing/health page (must deploy green). Add `/api/health` route returning `{ ok: true }`.

### 3. Tenancy schema as migrations (`supabase/migrations/`)
Timestamped SQL files. Tables (Phase 0 subset — the tenancy core only; later phases add menu/orders/payments):
- `tenants` (id, name, slug, created_at, status)
- `locations` (id, tenant_id FK, name, slug, timezone, address, created_at)
- `users` (id, email, created_at)  — app users (staff + platform admins; customers added later)
- `memberships` (id, user_id FK, tenant_id FK, role enum: owner|manager|cashier|kitchen, created_at)
- `platform_admins` (user_id FK)  — outside tenant scope
- Enums: `tenant_status`, `membership_role`.

### 4. RLS policies (the critical part)
- Enable RLS on `tenants`, `locations`, `memberships`.
- Policy pattern: a row is visible/writable only if the requesting user has a `memberships` row for that `tenant_id` (and role permits). Location access further scoped where relevant.
- `platform_admins` bypass via a dedicated policy.
- Include a **SQL isolation test** file (`supabase/tests/rls_isolation.sql` or a `/scripts` note) demonstrating tenant A cannot read tenant B's rows. Document how to run once a live DB exists.
- Document RLS assumptions in `supabase/README.md`.

### 5. Pluggable interface contracts (typed stubs, no impls)
- `src/lib/payments/PaymentRail.ts` — interface: `quote()`, `createCharge()`, `capture()`, `refund()`, `status()`; types for Money, ChargeResult, etc. Stub registry `src/lib/payments/registry.ts` mapping rail keys → impls (empty for now): `stripe_terminal`, `stripe_online`, `crypto_onchain_usdc`, `crypto_coinbase`.
- `src/lib/delivery/DeliveryProvider.ts` — interface: `quote()`, `dispatch()`, `track()`, `cancel()`. Registry with keys `in_house_manual`, `doordash_drive`.
- Each interface file documents the contract; implementations land in Phases 2/4.

### 6. Sample seed (`supabase/seed.sql`)
- One demo tenant ("Tony's Pizza"), two locations, a small but realistic menu (margherita, pepperoni, sizes S/M/L, crust/sauce/topping modifier groups with half-and-half flag). Used later once DB is live.

### 7. CI
- GitHub Actions: install, typecheck, lint, build on PR. Must pass.

## Out of scope for Phase 0
- Any live DB connection, auth flows, real payments/delivery, order logic, PWA offline behavior. Those are Phases 1+.

## Verification
- `pnpm install && pnpm build` succeeds locally with no env vars set.
- All five route-group pages + `/` + `/api/health` render.
- CI green on the PR.
- **Vercel preview deploys green** (pizza-dao scope) — this is the acceptance gate Snax reviews.
- Migration SQL files parse (lint via `psql --dry`/`sqlfluff` if available, else manual review).

## Worktree / PR
- Branch: `margherita-60504-phase-0`
- Worktree: `../pos-margherita-60504`
- Draft PR titled `margherita-60504: Phase 0 — Platform foundations`, body summarizing deliverables + the Vercel preview URL once green.
