-- ============================================================================
-- RLS isolation test — tenant A cannot read tenant B's rows.
--
-- Demonstrates the core security guarantee: a user with a membership in tenant A
-- sees ONLY tenant A's tenants/locations/memberships, never tenant B's; and a
-- platform admin sees everything.
--
-- HOW TO RUN (once a live Supabase DB exists — see supabase/README.md):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/rls_isolation.sql
--
-- This script simulates the authenticated user by setting `request.jwt.claims`
-- (which Supabase's `auth.uid()` reads) and switching to the `authenticated`
-- role so RLS is enforced. It rolls everything back at the end — it does not
-- mutate persistent state.
-- ============================================================================

begin;

-- Make the helper assertions readable.
set client_min_messages = warning;

-- ---- Fixtures ---------------------------------------------------------------
-- Two tenants, two users (one member each), plus a platform admin.
-- We insert as the table owner with RLS forced off for setup via a temporary
-- superuser-style path: here we disable the policies by inserting before any
-- auth context is set AND temporarily bypassing with session_replication_role.
set session_replication_role = replica; -- bypass triggers; RLS still applies to non-owners

-- Insert fixtures directly (this script is intended to be run as a privileged
-- migration/test role that owns the tables; FORCE RLS means we still scope reads
-- below by switching roles).
insert into public.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'alice@tenant-a.example'),
  ('22222222-2222-2222-2222-222222222222', 'bob@tenant-b.example'),
  ('33333333-3333-3333-3333-333333333333', 'admin@platform.example');

insert into public.tenants (id, name, slug) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Tenant A', 'tenant-a'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Tenant B', 'tenant-b');

insert into public.locations (id, tenant_id, name, slug) values
  ('a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'A Downtown', 'a-downtown'),
  ('b1b1b1b1-b1b1-b1b1-b1b1-b1b1b1b1b1b1', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'B Downtown', 'b-downtown');

insert into public.memberships (user_id, tenant_id, role) values
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'owner'),
  ('22222222-2222-2222-2222-222222222222', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'owner');

insert into public.platform_admins (user_id) values
  ('33333333-3333-3333-3333-333333333333');

set session_replication_role = origin;

-- ---- Helper to impersonate a user --------------------------------------------
-- Supabase derives auth.uid() from request.jwt.claims->>'sub'.
create or replace function pg_temp.act_as(uid text) returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', uid)::text, true);
  execute 'set local role authenticated';
end;
$$;

-- ============================================================================
-- ASSERTIONS
-- ============================================================================

-- 1) Alice (tenant A member) sees exactly 1 tenant: tenant A.
select pg_temp.act_as('11111111-1111-1111-1111-111111111111');
do $$
declare n int;
begin
  select count(*) into n from public.tenants;
  assert n = 1, format('Alice should see 1 tenant, saw %s', n);
  perform 1 from public.tenants where slug = 'tenant-b';
  assert not found, 'Alice must NOT see tenant B';
  select count(*) into n from public.locations;
  assert n = 1, format('Alice should see 1 location, saw %s', n);
end $$;
reset role;

-- 2) Bob (tenant B member) sees exactly 1 tenant: tenant B; never tenant A.
select pg_temp.act_as('22222222-2222-2222-2222-222222222222');
do $$
declare n int;
begin
  select count(*) into n from public.tenants;
  assert n = 1, format('Bob should see 1 tenant, saw %s', n);
  perform 1 from public.tenants where slug = 'tenant-a';
  assert not found, 'Bob must NOT see tenant A';
end $$;
reset role;

-- 3) Cross-tenant WRITE is blocked: Alice cannot insert a location into tenant B.
select pg_temp.act_as('11111111-1111-1111-1111-111111111111');
do $$
declare blocked boolean := false;
begin
  begin
    insert into public.locations (tenant_id, name, slug)
    values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Hacked', 'hacked');
  exception when others then
    blocked := true;
  end;
  assert blocked, 'Alice must NOT be able to write into tenant B';
end $$;
reset role;

-- 4) Platform admin sees BOTH tenants.
select pg_temp.act_as('33333333-3333-3333-3333-333333333333');
do $$
declare n int;
begin
  select count(*) into n from public.tenants;
  assert n = 2, format('Platform admin should see 2 tenants, saw %s', n);
end $$;
reset role;

select 'RLS isolation test PASSED' as result;

rollback;
