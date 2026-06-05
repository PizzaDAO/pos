# anon-harden — least-privilege anon/authenticated grants + scoped storefront policies

Corrective security task for a real least-privilege finding surfaced by live
PostgREST verification (anon/public key) against the provisioned Supabase
project. RLS still gated rows, but the GRANT layer was wide open.

## Findings (verified against the live DB)

1. **Over-broad anon GRANTs** — `anon` held effectively ALL privileges
   (SELECT/INSERT/UPDATE/DELETE/TRUNCATE/TRIGGER/REFERENCES) on essentially every
   public table (orders, payments, customers, memberships, audit_log, staff,
   subscriptions, …). Source: the domain RLS migration over-granted. A serious
   footgun even though RLS currently gates rows.
2. **Registry enumeration** — `tenants_public_select` (anon, qual=true) and
   `locations_public_select` (anon, qual=true) let the public read the ENTIRE
   tenant + location registry of ALL tenants. The storefront only needs to
   resolve ONE location/menu by slug.
3. **authenticated over-broad** — also held TRUNCATE/TRIGGER/REFERENCES; should
   be least-privilege DML only.

## Decision: anon menu read = KEPT (server-side path is authoritative)

The app's real data path is **server-side via the `service_role` key**
(`readSupabaseConfig()` prefers it; `src/lib/db/supabase.ts` filters every query
by `tenant_id`/`location_id`). The `/shop` RSC + `/api/shop/*` routes resolve the
location, menu, and settings server-side through `getPosDriver()` and **never use
the anon role**. So tightening anon cannot break the app.

We nonetheless **keep a narrow anon SELECT** on the storefront-public surface
(menu tables + `location_menu_overrides` + `store_settings` + `locations`) so the
menu *could* be read client-side with the anon key later without re-granting.
Everything else anon loses entirely. Net: anon can read menu + one active-tenant
location, and nothing else.

## Changes

`supabase/migrations/20260605000200_least_privilege_grants.sql` (new, last by ts):
- `REVOKE ALL ON ALL TABLES/SEQUENCES/FUNCTIONS IN SCHEMA public FROM anon`, then
  `GRANT USAGE ON SCHEMA` + `GRANT SELECT` to anon on the 9 storefront-public
  tables only.
- `REVOKE ALL ... FROM authenticated`, then `GRANT SELECT,INSERT,UPDATE,DELETE`
  on the tenancy + domain operational tables (no TRUNCATE/TRIGGER/REFERENCES);
  `GRANT USAGE,SELECT ON ALL SEQUENCES` to authenticated (defensive).
- `DROP POLICY IF EXISTS tenants_public_select` (kills registry enumeration; the
  member/admin `tenants_select` from the tenancy core is untouched).
- New SECURITY DEFINER helper `public.is_active_tenant(uuid)` + replace
  `locations_public_select` with `for select to anon using
  (public.is_active_tenant(locations.tenant_id))` — anon resolves a location by
  slug only for an **active** tenant, and never reads `tenants` directly (anon
  has no grant there; the helper runs as definer).
- Menu/`store_settings` `using(true)` SELECT policies are intentionally kept.

`supabase/tests/rls_isolation.sql` (extended, as `anon`):
- Added customers + staff + store_settings fixtures for both tenants.
- anon CAN read both menus, both menu categories, both stores' settings, and
  resolve a location by slug.
- anon CANNOT read `tenants`, `orders`, `payments`, `customers`, `staff`,
  `memberships` (looped; permission-denied OR 0 rows — never any data).
- Kept anon-cannot-write-menu and all authenticated cross-tenant assertions.

Docs: `supabase/README.md` (new "Public-surface least-privilege model" section +
layout entry) and `docs/PRODUCTION_READINESS.md` (grants model + isolation-test
description + go-live checkbox).

No app code changed — the service-role path already bypasses anon.

## Verification

- Local (zero env): `typecheck`, `lint`, `build`, `test:run` (106 tests) — all green.
- DB: the extended isolation test runs in the optional non-blocking
  `rls-isolation` Postgres CI job (vanilla PG + auth_shim; the shim creates the
  anon/authenticated/service_role roles). Local Docker was unavailable in the
  authoring environment (daemon hung), so CI is the authoritative DB gate.
