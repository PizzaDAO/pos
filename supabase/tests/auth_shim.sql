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
-- (the platform supplies `auth.uid()`); do NOT apply it there.
-- ============================================================================
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
