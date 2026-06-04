# Supabase — schema, RLS, and how to run (DEFERRED in Phase 0)

This directory holds the database schema as **migration files** and a sample
seed. In **Phase 0 there is no live Supabase project** — nothing here is applied
yet, and the Next.js app builds and runs with **no Supabase env vars set**. These
files are reviewed now and applied once a Supabase project is provisioned.

## Layout

```
supabase/
  migrations/
    20260601000000_tenancy_core.sql   # enums + tables (tenants, locations, users, memberships, platform_admins)
    20260601000100_tenancy_rls.sql    # strict RLS policies + helper functions
  tests/
    rls_isolation.sql                 # proves tenant A cannot read/write tenant B
  seed.sql                            # sample tenant "Tony's Pizza", 2 locations, menu
  README.md                           # this file
```

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

## How to run (once a live DB exists)

Using the Supabase CLI (recommended):

```bash
# point at your project
supabase link --project-ref <ref>

# apply all migrations
supabase db push

# load the sample pizzeria (after migrations)
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/seed.sql
```

Or with plain `psql` against any Postgres:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/migrations/20260601000000_tenancy_core.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/migrations/20260601000100_tenancy_rls.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/seed.sql
```

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

> Run this as a role that owns the tables (e.g. the migration/`postgres` role).
> It switches to `authenticated` internally to exercise RLS. In CI this becomes
> part of an automated tenant-isolation suite (Phase 7 hardening).

## Note on `seed.sql` and the menu schema

The menu portion of the seed (categories, items, sizes, modifier groups with a
`supports_half` flag) targets tables introduced by a **Phase 1** migration. The
seed guards that section with `to_regclass(...)`, so it is a safe no-op until
those tables exist, and becomes a complete menu seed once they do.
