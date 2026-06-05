# Phase 6 — Self-Serve SaaS Layer (siciliana-77553)

Builds the platform/SaaS layer on top of Phases 0–5: self-serve tenant signup +
onboarding, subscription billing (Stripe Billing) with plan gating, and a
super-admin `/platform` surface with audited support impersonation. Everything
runs through `getPosDriver()` (mock driver) and builds + previews with **zero env
vars** — real Stripe Connect/Billing activate behind env keys; otherwise both run
**simulated**, mirroring the established Phase 2 env-guard pattern.

## What shipped

### 1. Tenant signup + onboarding wizard (`/signup`, public)
A six-step wizard (`src/app/(platform)/signup/`) that creates a **brand-new,
fully isolated tenant** through the DB abstraction:
1. **Business** — `createTenant()` makes a `Tenant` (starts `suspended`) + an
   owner `User` + initial onboarding state. Slug derived + de-duped.
2. **Location** — `createLocation()` gives the tenant its own location (own slug)
   plus its own store + payment settings (so terminal/shop/checkout work).
3. **Connect** — reuses the **Phase 2 Connect scaffold** (`/api/connect`): real
   Account Link behind `STRIPE_SECRET_KEY`, simulated `acct_sim_…` `connected`
   otherwise. No payment logic forked.
4. **Menu** — `importStarterMenu()` clones a **classic-pizzeria template**
   (`src/lib/saas/menu-template.ts`, modeled on the seed) with per-tenant ids.
5. **Plan** — pick a tier (simulated subscription when unkeyed).
6. **Go live** — `goLive()` flips the tenant to `active` + marks onboarding live.

Onboarding progress is persisted (`TenantOnboarding`) so the wizard is resumable.
The new tenant's `/admin?tenant=<id>` and `/shop/<slug>` work **in isolation**
from the demo seed tenant (verified: the new tenant has the template menu; the
demo tenant keeps its own items).

### 2. Subscription billing (Stripe Billing — OUR revenue)
Distinct from Connect (the tenant's card revenue).
- **Plans/tiers** (`src/lib/saas/plans.ts`): Starter ($49, 1 location, no online
  ordering/advanced reports), Pro ($99, 3 locations, online ordering + delivery +
  advanced reports), Multi-location ($199, unlimited). 14-day trials.
- **Service** (`src/lib/billing/`): `subscribeTenant()` creates a real Stripe
  **Customer + Checkout Session** when `isBillingConfigured()` (secret key **and**
  a tier Price id); otherwise a deterministic **simulated** subscription
  (`trialing → active`) in the mock driver. `/api/billing/webhook` reconciles
  lifecycle in real mode and is a guarded 200 no-op when unkeyed.
- **Dunning / past-due**: subscription status carries `past_due`; the back office
  shows a dunning banner; a demo control flips status so it's testable without a
  webhook.

### 3. Plan gating / entitlements
- `src/lib/saas/entitlements.ts` resolves effective entitlements from tier +
  lifecycle status (a `canceled` sub collapses to a blocked/read-only state).
  Pure functions; the server is authoritative and `useEntitlements` mirrors it
  for UX.
- **Wired into three real spots** (all re-checked server-side):
  1. **Add location** beyond `max_locations` → `/api/admin/locations` returns
     **402**; the Locations tab blocks the form. (Starter blocks the 2nd
     location; upgrading to Pro unblocks it — verified.)
  2. **Online ordering** on a sub-Pro plan → `/api/shop/orders` returns **402**.
  3. **Advanced reports** + **delivery** tabs are locked in `/admin` below Pro.

### 4. Super-admin `/platform` (outside tenant RLS)
`src/app/(platform)/platform/` + `/api/platform`, gated on the seeded
`platform_admins` identity:
- **Tenant health list**: subscription state, # locations, recent order volume +
  gross (derived from mock order data).
- **Tenant detail / billing overview**: plan, Connect status, footprint, audit
  trail.
- **Audited support impersonation** ("view as tenant"): start opens
  `/admin?tenant=<id>&impersonate=1` (a clear amber "support session — audited"
  banner) and **writes an audit-log entry**; ending writes another. Suspend /
  reactivate are likewise audited. The audit log is append-only and surfaced
  read-only in the console.

### 5. Data model + driver (extends the mock)
New types in `src/lib/db/saas-types.ts`: `Plan`/`PlanEntitlements`,
`Subscription`, `TenantOnboarding`, `AuditLogEntry`, `TenantHealth`. New
`PosDriver` methods (mock-implemented; Supabase later behind the same interface):
tenant CRUD + isolated provisioning, onboarding state, subscriptions, platform
admin/health, and the audit log. Money stays integer minor units. Demo tenant is
seeded as live on the Pro plan so `/platform` shows a healthy live tenant.

### 6. Env
`.env.example` adds blank `STRIPE_PRICE_STARTER/_PRO/_MULTI` +
`STRIPE_BILLING_WEBHOOK_SECRET` with a note that absence → simulated billing, and
a platform-admin note. No secrets; public repo.

## Design notes
- **Two revenue streams never conflated**: subscription (Stripe Billing, this
  phase) vs per-order platform fee (Connect `application_fee`, Phase 2). The UI
  states this at onboarding + on the Plan tab.
- **Tenant isolation**: signup provisions every dependent row per tenant (owner
  user, locations, settings, menu via fresh ids) so a new tenant can't read the
  demo tenant's data. Slugs are globally de-duped.
- **Auth remains simulated** (no real email/password): owner users + the platform
  admin are modeled via the tenancy tables (`users`/`memberships`/
  `platform_admins`) so Phase 7/Supabase can make them real without reshaping.

## Out of scope (Phase 7)
Real Supabase/RLS, production auth, the isolation/idempotency test suite, and
live Stripe credentials.
