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

-- ---- Domain fixtures (menu, orders, payments) for both tenants -------------
-- A menu category + item per tenant (public-readable), an order per tenant
-- (tenant-scoped), and a payment per order (tenant-scoped). These let us assert
-- isolation on the operational tables, not just the tenancy core.
insert into public.menu_categories (id, tenant_id, name, sort_order) values
  ('caca0001-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'A Pizzas', 1),
  ('cbcb0001-0000-0000-0000-000000000001', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'B Pizzas', 1);

insert into public.menu_items (id, tenant_id, category_id, name) values
  ('11aa0001-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'caca0001-0000-0000-0000-000000000001', 'A Margherita'),
  ('11bb0001-0000-0000-0000-000000000001', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
   'cbcb0001-0000-0000-0000-000000000001', 'B Margherita');

insert into public.orders
  (id, tenant_id, location_id, status, channel, currency, discount_cents, totals, order_number)
values
  ('0ada0001-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1', 'paid', 'in_store', 'USD', 0,
   '{"total_cents":1099}'::jsonb, 'A-0001'),
  ('0bdb0001-0000-0000-0000-000000000001', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
   'b1b1b1b1-b1b1-b1b1-b1b1-b1b1b1b1b1b1', 'paid', 'in_store', 'USD', 0,
   '{"total_cents":1299}'::jsonb, 'A-0001');

insert into public.payments
  (id, order_id, tenant_id, location_id, rail, status, amount_cents, currency)
values
  ('0aea0001-0000-0000-0000-000000000001', '0ada0001-0000-0000-0000-000000000001',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1',
   'cash', 'captured', 1099, 'USD'),
  ('0beb0001-0000-0000-0000-000000000001', '0bdb0001-0000-0000-0000-000000000001',
   'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'b1b1b1b1-b1b1-b1b1-b1b1-b1b1b1b1b1b1',
   'cash', 'captured', 1299, 'USD');

-- A customer + a staff row per tenant, so the anon-cannot-read assertions below
-- exercise tables that actually hold rows (a 0-row read must be a DENIAL, not an
-- empty table).
insert into public.customers (id, tenant_id, email, name, verified) values
  ('c0a00001-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'cust-a@example.com', 'Cust A', true),
  ('c0b00001-0000-0000-0000-000000000001', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
   'cust-b@example.com', 'Cust B', true);

insert into public.staff (id, tenant_id, name, role, active) values
  ('57a00001-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'Staff A', 'cashier', true),
  ('57b00001-0000-0000-0000-000000000001', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
   'Staff B', 'cashier', true);

-- A store_settings row per location so anon's public-surface read returns rows.
insert into public.store_settings (tenant_id, location_id, currency, tax_rate_bps) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1', 'USD', 825),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'b1b1b1b1-b1b1-b1b1-b1b1-b1b1b1b1b1b1', 'USD', 825);

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

-- 4) The blocked cross-tenant write (assertion 3) left NO row behind. Check as
--    the table owner (RLS reset) so we see the true persisted state.
do $$
declare n int;
begin
  select count(*) into n from public.locations where slug = 'hacked';
  assert n = 0, format('Blocked cross-tenant insert must leave no row, found %s', n);
end $$;

-- 5) memberships are tenant-scoped: Alice sees only tenant A's membership rows,
--    never Bob's (no cross-tenant staff visibility).
select pg_temp.act_as('11111111-1111-1111-1111-111111111111');
do $$
declare n int;
begin
  select count(*) into n from public.memberships;
  assert n = 1, format('Alice should see 1 membership (her own tenant), saw %s', n);
  perform 1 from public.memberships
    where tenant_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  assert not found, 'Alice must NOT see tenant B memberships';
end $$;
reset role;

-- 6) Alice cannot read Bob's user row (no shared tenant); she can read her own.
select pg_temp.act_as('11111111-1111-1111-1111-111111111111');
do $$
declare n int;
begin
  perform 1 from public.users where email = 'bob@tenant-b.example';
  assert not found, 'Alice must NOT see Bob''s user row';
  select count(*) into n from public.users where id = '11111111-1111-1111-1111-111111111111';
  assert n = 1, 'Alice must be able to read her own user row';
end $$;
reset role;

-- 7) Platform admin sees BOTH tenants.
select pg_temp.act_as('33333333-3333-3333-3333-333333333333');
do $$
declare n int;
begin
  select count(*) into n from public.tenants;
  assert n = 2, format('Platform admin should see 2 tenants, saw %s', n);
end $$;
reset role;

-- ============================================================================
-- DOMAIN-TABLE ISOLATION — orders, payments, and (public) menu.
-- ============================================================================

-- 8) ORDERS are tenant-scoped: Alice sees only tenant A's order, never B's.
select pg_temp.act_as('11111111-1111-1111-1111-111111111111');
do $$
declare n int;
begin
  select count(*) into n from public.orders;
  assert n = 1, format('Alice should see 1 order (tenant A), saw %s', n);
  perform 1 from public.orders where tenant_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  assert not found, 'Alice must NOT see tenant B orders';
end $$;
reset role;

-- 9) PAYMENTS are tenant-scoped: Bob sees only tenant B's payment, never A's.
select pg_temp.act_as('22222222-2222-2222-2222-222222222222');
do $$
declare n int;
begin
  select count(*) into n from public.payments;
  assert n = 1, format('Bob should see 1 payment (tenant B), saw %s', n);
  perform 1 from public.payments where tenant_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  assert not found, 'Bob must NOT see tenant A payments';
end $$;
reset role;

-- 10) Cross-tenant ORDER WRITE is blocked: Alice cannot insert an order into B.
select pg_temp.act_as('11111111-1111-1111-1111-111111111111');
do $$
declare blocked boolean := false;
begin
  begin
    insert into public.orders
      (id, tenant_id, location_id, status, channel, currency, discount_cents, totals, order_number)
    values
      ('0ada9999-0000-0000-0000-000000000099', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
       'b1b1b1b1-b1b1-b1b1-b1b1-b1b1b1b1b1b1', 'paid', 'in_store', 'USD', 0,
       '{"total_cents":1}'::jsonb, 'HACK');
  exception when others then
    blocked := true;
  end;
  assert blocked, 'Alice must NOT be able to write an order into tenant B';
end $$;
reset role;

-- 11) The blocked cross-tenant order write left NO row (checked as table owner).
do $$
declare n int;
begin
  select count(*) into n from public.orders where order_number = 'HACK';
  assert n = 0, format('Blocked cross-tenant order insert must leave no row, found %s', n);
end $$;

-- Clear any impersonation so the anon blocks below run as a TRUE anonymous
-- visitor (auth.uid() = null), not a leftover authenticated subject.
select set_config('request.jwt.claims', '', true);

-- 12) MENU is intentionally PUBLIC-READABLE (storefront). The `anon` role sees
--     BOTH tenants' menu items (public reads), but writes stay tenant-scoped.
--     This is the storefront-public surface anon retains SELECT on after the
--     least-privilege migration (20260605000200).
set local role anon;
do $$
declare n int;
begin
  select count(*) into n from public.menu_items;
  assert n = 2, format('anon (storefront) should read both menus (2 items), saw %s', n);
  select count(*) into n from public.menu_categories;
  assert n = 2, format('anon should read both menu categories, saw %s', n);
  -- store_settings is part of the public surface (currency/tax/hours).
  select count(*) into n from public.store_settings;
  assert n = 2, format('anon should read both stores'' settings, saw %s', n);
  -- A storefront resolves a LOCATION by slug; anon can read the location row
  -- (active tenant) so the slug lookup works.
  select count(*) into n from public.locations where slug = 'a-downtown';
  assert n = 1, format('anon should resolve a public location by slug, saw %s', n);
end $$;
reset role;

-- 13) anon CANNOT read the tenant REGISTRY or any operational/PII table. After
--     the least-privilege migration, anon has NO table grant on these (the
--     blanket grant was revoked) AND no anon SELECT policy, so each read must be
--     DENIED — a hard permission error (insufficient_privilege) or, if a grant
--     somehow lingered, 0 rows. Either way: NEVER any data. This is the core
--     regression guard for finding #1 (over-broad anon grants) and finding #2
--     (tenant/location registry enumeration via tenants_public_select).
set local role anon;
do $$
declare n int; tbl text;
begin
  foreach tbl in array array[
    'tenants', 'orders', 'payments', 'customers', 'staff', 'memberships'
  ]
  loop
    begin
      execute format('select count(*) from public.%I', tbl) into n;
      -- If the grant/policy ever leaks, at least prove no ROW is visible.
      assert n = 0,
        format('anon must NOT read any %s rows, saw %s', tbl, n);
    exception when insufficient_privilege then
      -- permission denied at the grant layer is the strongest "no access".
      null;
    end;
  end loop;
end $$;
reset role;

-- 14) anon CANNOT write the public menu (read-only storefront surface).
set local role anon;
do $$
declare blocked boolean := false;
begin
  begin
    insert into public.menu_items (id, tenant_id, category_id, name)
    values ('11cc9999-0000-0000-0000-000000000099',
            'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
            'caca0001-0000-0000-0000-000000000001', 'anon hack');
  exception when others then
    blocked := true;
  end;
  assert blocked, 'anon must NOT be able to write menu items';
end $$;
reset role;

select 'RLS isolation test PASSED' as result;

rollback;
