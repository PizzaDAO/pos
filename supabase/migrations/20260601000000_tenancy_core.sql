-- ============================================================================
-- Migration: tenancy_core
-- Phase 0 — tenancy core schema (tenants, locations, users, memberships,
-- platform_admins) + enums. RLS policies live in the next migration so the
-- table DDL and the security policies are reviewable independently.
--
-- DEFERRED: this is NOT applied to a live DB in Phase 0. It is reviewed/applied
-- once a Supabase project is provisioned. See supabase/README.md.
-- ============================================================================

-- Required for gen_random_uuid().
create extension if not exists "pgcrypto";

-- ----------------------------------------------------------------------------
-- Enums
-- ----------------------------------------------------------------------------
create type public.tenant_status as enum ('active', 'suspended', 'cancelled');

create type public.membership_role as enum ('owner', 'manager', 'cashier', 'kitchen');

-- ----------------------------------------------------------------------------
-- users — app users (staff + platform admins; customers added in a later phase)
--
-- NOTE: When Supabase Auth is wired up, `users.id` is expected to equal
-- `auth.users.id` (1:1). RLS policies below assume `auth.uid()` returns this id.
-- ----------------------------------------------------------------------------
create table public.users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  created_at timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- tenants — a pizzeria business. Top of the tenancy hierarchy.
-- ----------------------------------------------------------------------------
create table public.tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  status public.tenant_status not null default 'active',
  created_at timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- locations — a physical store belonging to a tenant.
-- ----------------------------------------------------------------------------
create table public.locations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  name text not null,
  slug text not null,
  timezone text not null default 'America/New_York',
  address text,
  created_at timestamptz not null default now(),
  -- slug is unique within a tenant, not globally.
  unique (tenant_id, slug)
);

create index locations_tenant_id_idx on public.locations (tenant_id);

-- ----------------------------------------------------------------------------
-- memberships — the user <-> tenant <-> role join that drives ALL tenant RLS.
-- A user with a membership row for a tenant can see that tenant's data
-- (scoped further by role in later phases).
-- ----------------------------------------------------------------------------
create table public.memberships (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  role public.membership_role not null,
  created_at timestamptz not null default now(),
  -- one membership per user per tenant.
  unique (user_id, tenant_id)
);

create index memberships_user_id_idx on public.memberships (user_id);
create index memberships_tenant_id_idx on public.memberships (tenant_id);

-- ----------------------------------------------------------------------------
-- platform_admins — super-admins (us). OUTSIDE tenant scope. Bypass tenant RLS.
-- ----------------------------------------------------------------------------
create table public.platform_admins (
  user_id uuid primary key references public.users (id) on delete cascade,
  created_at timestamptz not null default now()
);
