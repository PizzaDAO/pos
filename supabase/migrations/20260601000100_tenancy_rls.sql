-- ============================================================================
-- Migration: tenancy_rls
-- Phase 0 — STRICT Row Level Security for the tenancy core.
--
-- The #1 correctness/security concern of this SaaS is tenant data isolation.
-- Every tenant-scoped row is visible/writable ONLY to users who hold a
-- `memberships` row for that row's tenant. Platform admins bypass via a
-- dedicated predicate. No query can cross tenants.
--
-- Assumptions:
--   * `auth.uid()` returns the current user's id and equals `public.users.id`.
--   * Access goes through PostgREST/Supabase with RLS enforced (the service-role
--     key bypasses RLS and must NEVER be used for tenant-scoped reads/writes
--     without an explicit tenant filter — see supabase/README.md).
--
-- DEFERRED: not applied to a live DB in Phase 0.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Helper functions (SECURITY DEFINER so they can read membership tables without
-- recursively triggering the policies that call them).
-- ----------------------------------------------------------------------------

-- True if the current user is a platform super-admin.
create or replace function public.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.platform_admins pa
    where pa.user_id = auth.uid()
  );
$$;

-- True if the current user has a membership in the given tenant.
create or replace function public.is_tenant_member(target_tenant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.memberships m
    where m.tenant_id = target_tenant_id
      and m.user_id = auth.uid()
  );
$$;

-- True if the current user has one of the given roles in the given tenant.
create or replace function public.has_tenant_role(
  target_tenant_id uuid,
  allowed_roles public.membership_role[]
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.memberships m
    where m.tenant_id = target_tenant_id
      and m.user_id = auth.uid()
      and m.role = any(allowed_roles)
  );
$$;

-- ----------------------------------------------------------------------------
-- Enable RLS. Default-deny: with RLS on and no matching policy, access is denied.
-- ----------------------------------------------------------------------------
alter table public.tenants enable row level security;
alter table public.locations enable row level security;
alter table public.memberships enable row level security;
alter table public.users enable row level security;
alter table public.platform_admins enable row level security;

-- Force RLS even for the table owner, so seeds/migrations can't accidentally
-- read across tenants without going through a privileged path.
alter table public.tenants force row level security;
alter table public.locations force row level security;
alter table public.memberships force row level security;

-- ----------------------------------------------------------------------------
-- tenants
--   read:  members of the tenant, or platform admins.
--   write: owners/managers of the tenant, or platform admins.
-- ----------------------------------------------------------------------------
create policy tenants_select on public.tenants
  for select
  using (
    public.is_platform_admin()
    or public.is_tenant_member(id)
  );

create policy tenants_insert on public.tenants
  for insert
  with check (
    public.is_platform_admin()
  );

create policy tenants_update on public.tenants
  for update
  using (
    public.is_platform_admin()
    or public.has_tenant_role(id, array['owner','manager']::public.membership_role[])
  )
  with check (
    public.is_platform_admin()
    or public.has_tenant_role(id, array['owner','manager']::public.membership_role[])
  );

create policy tenants_delete on public.tenants
  for delete
  using (public.is_platform_admin());

-- ----------------------------------------------------------------------------
-- locations
--   read:  members of the owning tenant, or platform admins.
--   write: owners/managers of the owning tenant, or platform admins.
-- ----------------------------------------------------------------------------
create policy locations_select on public.locations
  for select
  using (
    public.is_platform_admin()
    or public.is_tenant_member(tenant_id)
  );

create policy locations_insert on public.locations
  for insert
  with check (
    public.is_platform_admin()
    or public.has_tenant_role(tenant_id, array['owner','manager']::public.membership_role[])
  );

create policy locations_update on public.locations
  for update
  using (
    public.is_platform_admin()
    or public.has_tenant_role(tenant_id, array['owner','manager']::public.membership_role[])
  )
  with check (
    public.is_platform_admin()
    or public.has_tenant_role(tenant_id, array['owner','manager']::public.membership_role[])
  );

create policy locations_delete on public.locations
  for delete
  using (
    public.is_platform_admin()
    or public.has_tenant_role(tenant_id, array['owner']::public.membership_role[])
  );

-- ----------------------------------------------------------------------------
-- memberships
--   read:  the membership's own user, other members of the same tenant, or
--          platform admins.
--   write: owners of the tenant (manage staff), or platform admins.
-- ----------------------------------------------------------------------------
create policy memberships_select on public.memberships
  for select
  using (
    public.is_platform_admin()
    or user_id = auth.uid()
    or public.is_tenant_member(tenant_id)
  );

create policy memberships_insert on public.memberships
  for insert
  with check (
    public.is_platform_admin()
    or public.has_tenant_role(tenant_id, array['owner']::public.membership_role[])
  );

create policy memberships_update on public.memberships
  for update
  using (
    public.is_platform_admin()
    or public.has_tenant_role(tenant_id, array['owner']::public.membership_role[])
  )
  with check (
    public.is_platform_admin()
    or public.has_tenant_role(tenant_id, array['owner']::public.membership_role[])
  );

create policy memberships_delete on public.memberships
  for delete
  using (
    public.is_platform_admin()
    or public.has_tenant_role(tenant_id, array['owner']::public.membership_role[])
  );

-- ----------------------------------------------------------------------------
-- users
--   A user can read/update their own row. Platform admins can read all.
--   Tenant members can read users who share a tenant with them (so staff lists
--   resolve) — read-only.
-- ----------------------------------------------------------------------------
create policy users_select_self on public.users
  for select
  using (
    public.is_platform_admin()
    or id = auth.uid()
    or exists (
      select 1
      from public.memberships m_self
      join public.memberships m_other
        on m_other.tenant_id = m_self.tenant_id
      where m_self.user_id = auth.uid()
        and m_other.user_id = public.users.id
    )
  );

create policy users_update_self on public.users
  for update
  using (public.is_platform_admin() or id = auth.uid())
  with check (public.is_platform_admin() or id = auth.uid());

-- ----------------------------------------------------------------------------
-- platform_admins — only platform admins may read/manage this table.
-- ----------------------------------------------------------------------------
create policy platform_admins_select on public.platform_admins
  for select
  using (public.is_platform_admin());

create policy platform_admins_all on public.platform_admins
  for all
  using (public.is_platform_admin())
  with check (public.is_platform_admin());
