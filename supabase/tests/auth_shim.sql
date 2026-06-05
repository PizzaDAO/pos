-- ============================================================================
-- auth.uid() shim for running the RLS isolation test on a VANILLA Postgres.
--
-- Supabase provides the `auth` schema and `auth.uid()` (which reads the current
-- request's JWT `sub` claim). A plain Postgres (local container / CI service)
-- has neither, so the tenancy RLS migration — and the isolation test that sets
-- `request.jwt.claims` — fail with `schema "auth" does not exist`.
--
-- This shim recreates EXACTLY the Supabase contract the policies rely on:
--   auth.uid() = (current_setting('request.jwt.claims')::json ->> 'sub')::uuid
-- so the migrations apply and the isolation test exercises real RLS off-platform.
--
-- Apply this BEFORE the migrations. On a real Supabase project it is unnecessary
-- (the platform supplies `auth.uid()` and these roles); do NOT apply it there.
-- ============================================================================

-- Supabase ships these Postgres roles; the isolation test does `set local role
-- authenticated` (and policies may target anon/authenticated). Vanilla Postgres
-- has none of them, so recreate the no-login role contract.
do $$
begin
  if not exists (select from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end
$$;

create schema if not exists auth;

create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(
    current_setting('request.jwt.claims', true)::json ->> 'sub',
    ''
  )::uuid;
$$;
