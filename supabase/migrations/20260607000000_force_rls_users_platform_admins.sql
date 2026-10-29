-- ============================================================================
-- Migration: force_rls_users_platform_admins
--
-- Corrective: `users` and `platform_admins` had RLS ENABLED but not FORCED (the
-- tenancy_rls migration only forced tenants/locations/memberships), so the table
-- owner silently bypassed their policies. Every other public table is forced;
-- this brings these two in line.
--
-- Safety (why forcing does not break the privileged paths):
--   * public.handle_new_auth_user() (auth.users -> public.users bridge) and the
--     is_platform_admin()/is_tenant_member()/has_tenant_role() helpers are all
--     SECURITY DEFINER, so they run as the FUNCTION OWNER (`postgres` on
--     Supabase). That role is SUPERUSER/BYPASSRLS, and BYPASSRLS roles skip RLS
--     even on FORCED tables, so the trigger's upsert/re-point of public.users and
--     the helpers' read of platform_admins are unaffected. This is the same
--     reliance memberships (forced since tenancy_rls) already has.
--   * Without a bypassing owner, forcing would make platform_admins_select ->
--     is_platform_admin() -> platform_admins recurse infinitely. The guard below
--     therefore refuses to apply unless the helper's owner bypasses RLS.
--   * supabase/seed.sql and supabase/apply.sh run as that same owner role, and
--     the app's data path uses service_role (BYPASSRLS) — unaffected.
--
-- IDEMPOTENT: FORCE is a no-op if already forced.
-- ============================================================================

do $$
declare
  owner_ok boolean;
begin
  select r.rolsuper or r.rolbypassrls into owner_ok
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  join pg_roles r on r.oid = p.proowner
  where n.nspname = 'public' and p.proname = 'is_platform_admin';

  if owner_ok is distinct from true then
    raise exception
      'public.is_platform_admin() owner must be SUPERUSER or BYPASSRLS before forcing RLS on users/platform_admins (else policy recursion)';
  end if;
end;
$$;

alter table public.users force row level security;
alter table public.platform_admins force row level security;
