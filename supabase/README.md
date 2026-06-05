# Supabase — schema, RLS, and how to run

This directory holds the database schema as **migration files** and a full demo
seed. The Next.js app builds and runs with **no Supabase env vars set** (it falls
back to the in-memory **mock driver**); these files are applied once a Supabase
project is provisioned, at which point setting the env vars flips
`getPosDriver()` to the live **Supabase driver** (`src/lib/db/supabase.ts`) with
no call-site changes.

## Layout

```
supabase/
  migrations/
    20260601000000_tenancy_core.sql   # enums + tenancy tables (tenants, locations, users, memberships, platform_admins)
    20260601000100_tenancy_rls.sql    # strict RLS policies + helper functions for the tenancy core
    20260605000000_domain_core.sql    # ALL operational tables: menu, orders, payments, customers,
                                       #   deliveries, inventory, staff/shifts, reports/close, settings,
                                       #   subscriptions, onboarding, audit_log (+ enums + indexes)
    20260605000100_domain_rls.sql     # strict RLS + grants for every domain table (public menu read,
                                       #   customer-owns-their-orders, tenant-staff everything else)
    20260605000200_least_privilege_grants.sql  # CORRECTIVE: revoke the over-broad anon/authenticated
                                       #   table grants down to least privilege; drop anon's tenant-
                                       #   registry read; scope anon's location read to active tenants
  tests/
    auth_shim.sql                     # auth.uid() shim so the migrations/test run on vanilla Postgres
    rls_isolation.sql                 # proves isolation on tenancy + orders/menu/payments
    run-rls-isolation.sh              # one-command harness (shim + migrations + test)
  apply.sh                            # turnkey: apply ALL migrations + seed to a DATABASE_URL
  seed.sql                            # full demo tenant "Tony's Pizza" (2 locations, menu, inventory, staff, …)
  README.md                           # this file
```

## Driver selection (mock ↔ Supabase)

`getPosDriver()` (`src/lib/db/client.ts`) chooses lazily at call time:

- **Supabase env present** — `NEXT_PUBLIC_SUPABASE_URL` + a key
  (`SUPABASE_SERVICE_ROLE_KEY` server-side, else `NEXT_PUBLIC_SUPABASE_ANON_KEY`)
  → the real Supabase driver.
- **Otherwise** — the in-memory mock driver (the zero-env default; the build +
  the full Vitest suite pass with no env). Nothing reads env at module load.

## Tenancy & isolation model

- Hierarchy: **`tenants` (a pizzeria business) → `locations` → operational data.**
  Every tenant-scoped row carries a `tenant_id`.
- **`memberships` (user ↔ tenant ↔ role)** is the single source of truth for
  access. A row is visible/writable only if the current user holds a membership
  for that row's `tenant_id`. This is enforced by RLS on every tenant table.
- **`platform_admins`** are super-admins (us), **outside** tenant scope. Every
  policy includes an `is_platform_admin()` bypass for support/billing.
- Roles: `owner | manager | cashier | kitchen`. Phase 0 policies gate writes by
  role (e.g. only `owner`/`manager` edit tenant/locations; only `owner` manages
  memberships). Finer per-location/role scoping arrives with later tables.

### RLS assumptions (IMPORTANT)

1. **`auth.uid()` == `public.users.id`.** When Supabase Auth is wired up, the
   app's `users.id` must equal `auth.users.id` (1:1). Policies and helper
   functions (`is_tenant_member`, `has_tenant_role`, `is_platform_admin`) rely on
   this.
2. **The `service_role` key bypasses RLS.** It must NEVER be used for
   tenant-scoped reads/writes without an explicit `tenant_id` filter. App
   queries run as the `authenticated` role through PostgREST so RLS is enforced.
3. **Default-deny.** RLS is enabled AND `FORCE`d on tenant tables, so absent a
   matching policy, access is denied — including for the table owner.
4. Helper functions are `SECURITY DEFINER` with a pinned `search_path` so they
   can read membership tables without recursive policy evaluation.

## Public-surface least-privilege model (`anon` / `authenticated`)

GRANTs decide whether a role may touch a table **at all**; RLS decides **which
rows**. The two are independent defenses, and the public (`anon`) role is held to
the absolute minimum. This is enforced by
`20260605000200_least_privilege_grants.sql`, which corrects an earlier
over-grant that handed `anon` (and `authenticated`) effectively ALL privileges on
every table:

- **`anon` (the public/unauthenticated key)** holds **`SELECT` only**, and only
  on the **storefront-public read surface**:
  `menu_categories, menu_items, item_sizes, modifier_groups, modifiers,
  item_modifier_groups, location_menu_overrides, store_settings, locations`.
  It has **no** grant on `tenants, orders, payments, customers, memberships,
  staff, subscriptions, audit_log` or any other operational/PII table — a read
  there is denied at the **grant layer** (permission denied), independent of RLS.
  anon never has INSERT/UPDATE/DELETE/TRUNCATE anywhere.
- **`anon` policies**: the menu/overrides/`store_settings` tables expose a
  `using (true)` SELECT policy (no PII; a tenant's menu is already public on its
  storefront). `locations` exposes `locations_public_select` scoped to
  **active tenants** (`is_active_tenant()`, a SECURITY DEFINER helper so anon
  never reads `tenants` directly) so a visitor can resolve ONE store's location
  by slug — **not** enumerate the registry. There is **no anon policy** on
  `tenants` (the old blanket `tenants_public_select` was dropped); tenant
  resolution happens server-side via the `locations` row (which carries
  `tenant_id`).
- **`authenticated`** holds least-privilege DML — `SELECT, INSERT, UPDATE,
  DELETE` only (no `TRUNCATE/TRIGGER/REFERENCES`) — on the tenant-operational
  tables. Every row is still gated by the `memberships`-keyed RLS policies.

### Why the app is unaffected

The live data path is **server-side via the `service_role` key** (RLS-bypassing,
with explicit `tenant_id`/`location_id` filters in `src/lib/db/supabase.ts`).
`readSupabaseConfig()` prefers the service-role key; the storefront (`/shop` RSC +
`/api/shop/*` routes) resolves the location, menu, and settings server-side
through `getPosDriver()` and **never uses the `anon` role** for reads or writes.
The narrow `anon` SELECT grants above exist only so the storefront menu surface
*could* be read client-side with the anon key in a future iteration without
re-granting — tightening anon therefore cannot break the current app.

## Go-live: exact steps (once you have live credentials)

1. **Provision** a Supabase project; copy its URL + anon key + service-role key
   + the Postgres connection string.
2. **Apply** the schema + RLS + demo seed. Two equivalent paths:

   Turnkey script (plain `psql` against any Postgres/Supabase pooler URL):

   ```bash
   DATABASE_URL="postgres://postgres:<pw>@<host>:5432/postgres" npm run db:apply
   #   = bash supabase/apply.sh  (auto-detects auth.uid(); SKIP_SEED=1 to omit demo data)
   ```

   Or the Supabase CLI (migrations only) + seed:

   ```bash
   supabase link --project-ref <ref>
   supabase db push                                   # applies all migrations in order
   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/seed.sql
   ```

3. **Set env** on Vercel (and `.env.local` for local): `NEXT_PUBLIC_SUPABASE_URL`,
   `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL`.
   Presence of these flips `getPosDriver()` to the Supabase driver automatically.
4. **Wire Supabase Auth** so `auth.uid() == public.users.id` (the RLS assumption).
5. **Verify** isolation against the live DB:
   `SKIP_AUTH_SHIM=1 DATABASE_URL=... bash supabase/tests/run-rls-isolation.sh`
   → expect `RLS isolation test PASSED`.

> **service-role key is server-only.** The Supabase driver reads it only on the
> server and EVERY tenant-scoped query carries an explicit `tenant_id`/
> `location_id` filter, so it never crosses tenants even though it bypasses RLS.
> Never expose it to the client; keep it in a secret manager.

## Running the RLS isolation test

`tests/rls_isolation.sql` inserts two tenants + a member each + a platform admin,
then impersonates each user (via `request.jwt.claims` + the `authenticated`
role) and asserts:

- tenant A's member sees exactly tenant A's tenant/location and **never** tenant B's;
- tenant B's member sees only tenant B's;
- a cross-tenant **write** is blocked;
- a platform admin sees **both** tenants.

The whole script runs in a transaction and **rolls back** — it does not mutate
persistent data.

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/rls_isolation.sql
# expect: result = "RLS isolation test PASSED"
```

The script asserts:

- tenant A's member sees exactly tenant A's tenant/location and **never** tenant B's;
- tenant B's member sees only tenant B's;
- a cross-tenant **write** is blocked **and leaves no row behind**;
- **memberships** are tenant-scoped (no cross-tenant staff visibility);
- a member **cannot read another tenant's user row** but can read their own;
- a platform admin sees **both** tenants.

> Run this as a role that owns the tables (e.g. the migration/`postgres` role).
> It switches to `authenticated` internally to exercise RLS.

### One-command harness

`supabase/tests/run-rls-isolation.sh` applies the migrations and runs the test
in one step against any Postgres. Point it at a **fresh** database (a throwaway
container or a provisioned Supabase project):

```bash
# Local throwaway Postgres:
docker run -d --name pos-pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16
DATABASE_URL="postgres://postgres:postgres@localhost:5432/postgres" \
  bash supabase/tests/run-rls-isolation.sh
```

### CI

A **non-blocking** `rls-isolation` job in `.github/workflows/ci.yml` spins up a
Postgres service, applies the migrations, and runs this test on every PR. It is
marked `continue-on-error: true` because **a live DB must NOT be a required CI
dependency** for the platform (the app builds and the full Vitest suite passes
with zero env vars). The required gates are `build` + `test` (Vitest). The
app-layer complement to this DB-level test lives in
`src/lib/db/tenant-isolation.test.ts` and **does** run in the required suite.

## Note on `seed.sql` and the menu schema

The menu portion of the seed (categories, items, sizes, modifier groups with a
`supports_half` flag) targets tables introduced by a **Phase 1** migration. The
seed guards that section with `to_regclass(...)`, so it is a safe no-op until
those tables exist, and becomes a complete menu seed once they do.
