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
-- Assertions are FIXTURE-SCOPED (the two fixture tenants aaaaaaaa-… and
-- bbbbbbbb-…), so this file is valid against a live, non-empty database as well
-- as a fresh one; it runs in a transaction and rolls back. (The harness script
-- run-rls-isolation.sh also applies migrations, so that script needs a fresh DB.)
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

-- A connect_accounts row per tenant (server/service path writes these).
insert into public.connect_accounts (tenant_id, account_id, status, simulated) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'acct_fixture_a', 'connected', false),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'acct_fixture_b', 'connected', false);

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
  -- Scoped to the two fixture tenants so this holds on a non-empty database.
  select count(*) into n from public.tenants
    where id in ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
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
--
-- Reset to an EMPTY JSON OBJECT, not an empty string: a SELECT as anon still
-- triggers the *_write policies' USING (FOR ALL policies apply to SELECT too),
-- which call is_platform_admin() -> auth.uid() -> (claims)::json. The auth shim
-- casts the GUC to json before extracting 'sub', and ''::json is INVALID json
-- (would error), whereas '{}'::json ->> 'sub' is NULL → auth.uid() = NULL.
select set_config('request.jwt.claims', '{}', true);

-- NOTE: every count over a whole table above/below is scoped to the two fixture
-- tenants (or to RLS-restricted fixture users), so the file is valid against a
-- non-empty database, not just a fresh one.
-- 12) MENU is intentionally PUBLIC-READABLE (storefront). The `anon` role sees
--     BOTH tenants' menu items (public reads), but writes stay tenant-scoped.
--     This is the storefront-public surface anon retains SELECT on after the
--     least-privilege migration (20260605000200).
set local role anon;
do $$
declare n int;
begin
  select count(*) into n from public.menu_items
    where tenant_id in ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
  assert n = 2, format('anon (storefront) should read both menus (2 items), saw %s', n);
  select count(*) into n from public.menu_categories
    where tenant_id in ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
  assert n = 2, format('anon should read both menu categories, saw %s', n);
  -- store_settings is part of the public surface (currency/tax/hours).
  select count(*) into n from public.store_settings
    where tenant_id in ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
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

-- 15) Every public table with RLS enabled must also have it FORCED (incl.
--     users + platform_admins, forced by 20260607000000).
do $$
declare unforced text;
begin
  select string_agg(c.relname, ', ') into unforced
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r'
    and c.relrowsecurity and not c.relforcerowsecurity;
  assert unforced is null,
    format('RLS enabled but not FORCED on: %s', unforced);
end $$;

-- 16) connect_accounts is READ-ONLY to tenant staff: an owner can read their own
--     tenant's row (not Bob's) but CANNOT insert, update or delete it (money-
--     routing config is written only by the service-role server path), and
--     account_id is unique.
select pg_temp.act_as('11111111-1111-1111-1111-111111111111');
do $$
declare n int; blocked boolean;
begin
  select count(*) into n from public.connect_accounts
    where tenant_id in ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
  assert n = 1, format('owner should read only own connect account, saw %s', n);

  blocked := false;
  begin
    insert into public.connect_accounts (tenant_id, account_id)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'acct_owner_insert');
  exception when others then blocked := true; end;
  assert blocked, 'owner must NOT be able to insert connect_accounts';

  blocked := false;
  begin
    update public.connect_accounts set account_id = 'acct_owner_hijack'
      where tenant_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  exception when others then blocked := true; end;
  assert blocked, 'owner must NOT be able to update connect_accounts';

  blocked := false;
  begin
    delete from public.connect_accounts
      where tenant_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  exception when others then blocked := true; end;
  assert blocked, 'owner must NOT be able to delete connect_accounts';
end $$;
reset role;

do $$
declare dup boolean := false; id text;
begin
  select account_id into id from public.connect_accounts
    where tenant_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  assert id = 'acct_fixture_a', format('owner update must have left account_id untouched, saw %s', id);
  begin
    update public.connect_accounts set account_id = 'acct_fixture_b'
      where tenant_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  exception when unique_violation then dup := true; end;
  assert dup, 'connect_accounts.account_id must be unique';
end $$;

-- 17) A signed-in CUSTOMER cannot insert an order (even their own, in a tenant
--     where they are a customer): online orders are written server-side after
--     repricing. A tenant member still can.
select pg_temp.act_as('c0a00001-0000-0000-0000-000000000001');
do $$
declare blocked boolean := false;
begin
  begin
    insert into public.orders
      (id, tenant_id, location_id, status, channel, currency, discount_cents, totals, order_number, customer_id)
    values
      ('0ada7777-0000-0000-0000-000000000077', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
       'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1', 'placed', 'online_pickup', 'USD', 0,
       '{"total_cents":1}'::jsonb, 'CUSTHACK', 'c0a00001-0000-0000-0000-000000000001');
  exception when others then
    blocked := true;
  end;
  assert blocked, 'a signed-in customer must NOT be able to insert an order';
end $$;
reset role;

do $$
declare n int;
begin
  select count(*) into n from public.orders where order_number = 'CUSTHACK';
  assert n = 0, format('Blocked customer order insert must leave no row, found %s', n);
end $$;

select pg_temp.act_as('11111111-1111-1111-1111-111111111111');
do $$
declare n int;
begin
  insert into public.orders
    (id, tenant_id, location_id, status, channel, currency, discount_cents, totals, order_number)
  values
    ('0ada7777-0000-0000-0000-000000000078', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
     'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1', 'placed', 'in_store', 'USD', 0,
     '{"total_cents":1}'::jsonb, 'MEMBEROK');
  select count(*) into n from public.orders where order_number = 'MEMBEROK';
  assert n = 1, 'a tenant member must still be able to insert an order';
end $$;
reset role;

-- 18) Atomic refund RPCs (20261030000100): increment + id append + cap in one
--     UPDATE. Fixture payment 0aea0001 is captured, 1099 cents.
do $$
declare out jsonb; pay public.payments;
begin
  out := public.reserve_payment_refund('0aea0001-0000-0000-0000-000000000001', 500, 'r1');
  assert out->>'outcome' = 'ok', 'first refund must reserve';
  out := public.reserve_payment_refund('0aea0001-0000-0000-0000-000000000001', 500, 'r1');
  assert out->>'outcome' = 'duplicate', 'a replayed refund id must be a duplicate, not applied twice';
  out := public.reserve_payment_refund('0aea0001-0000-0000-0000-000000000001', 600, 'r2');
  assert out->>'outcome' = 'exceeds', 'an over-refund must be refused';
  out := public.reserve_payment_refund('0aea0001-0000-0000-0000-000000000001', 599, 'r3');
  assert out->>'outcome' = 'ok', 'the exact remainder must reserve';
  select * into pay from public.payments where id = '0aea0001-0000-0000-0000-000000000001';
  assert pay.refunded_cents = 1099, format('refunded_cents should be 1099, saw %s', pay.refunded_cents);
  assert pay.status = 'refunded', 'a fully refunded tender must flip to refunded';
  assert pay.refund_ids = array['r1', 'r3'], 'both applied refund ids are kept';
  perform public.release_payment_refund('0aea0001-0000-0000-0000-000000000001', 599, 'r3');
  select * into pay from public.payments where id = '0aea0001-0000-0000-0000-000000000001';
  assert pay.refunded_cents = 500 and pay.status = 'captured' and pay.refund_ids = array['r1'],
    'release must undo the reservation';
end $$;

-- ...and the RPCs are server-only: neither anon nor a signed-in user may call them.
select pg_temp.act_as('11111111-1111-1111-1111-111111111111');
do $$
declare blocked boolean := false;
begin
  begin
    perform public.reserve_payment_refund('0aea0001-0000-0000-0000-000000000001', 1, 'hack');
  exception when insufficient_privilege then blocked := true; end;
  assert blocked, 'authenticated users must NOT be able to call reserve_payment_refund';
end $$;
reset role;

-- 19) Online checkout lifecycle (20261101000000/100): the new statuses are valid,
--     and a second LIVE card tender on one order is refused by the partial unique
--     index while a canceled one frees the slot. (No new tables, so no new RLS.)
do $$
declare blocked boolean := false; n int;
begin
  insert into public.orders
    (id, tenant_id, location_id, status, channel, currency, discount_cents, totals, order_number)
  values
    ('0ada0002-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
     'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1', 'awaiting_payment', 'online_pickup', 'USD', 0,
     '{"total_cents":1099}'::jsonb, 'A-0002');
  update public.orders set status = 'abandoned' where id = '0ada0002-0000-0000-0000-000000000001';
  update public.orders set status = 'awaiting_payment' where id = '0ada0002-0000-0000-0000-000000000001';

  insert into public.payments
    (id, order_id, tenant_id, location_id, rail, status, amount_cents, currency)
  values
    ('0aea0002-0000-0000-0000-000000000001', '0ada0002-0000-0000-0000-000000000001',
     'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1',
     'stripe_online', 'requires_action', 1099, 'USD');
  begin
    insert into public.payments
      (id, order_id, tenant_id, location_id, rail, status, amount_cents, currency)
    values
      ('0aea0002-0000-0000-0000-000000000002', '0ada0002-0000-0000-0000-000000000001',
       'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1',
       'stripe_online', 'requires_action', 1099, 'USD');
  exception when unique_violation then blocked := true; end;
  assert blocked, 'a second live stripe_online tender on one order must be refused';

  -- A different rail on the same order is fine.
  insert into public.payments
    (id, order_id, tenant_id, location_id, rail, status, amount_cents, currency)
  values
    ('0aea0002-0000-0000-0000-000000000003', '0ada0002-0000-0000-0000-000000000001',
     'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1',
     'crypto_onchain_usdc', 'pending', 1099, 'USD');

  -- Canceling the first frees the slot for a new one.
  update public.payments set status = 'canceled' where id = '0aea0002-0000-0000-0000-000000000001';
  insert into public.payments
    (id, order_id, tenant_id, location_id, rail, status, amount_cents, currency)
  values
    ('0aea0002-0000-0000-0000-000000000002', '0ada0002-0000-0000-0000-000000000001',
     'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1',
     'stripe_online', 'requires_action', 1099, 'USD');
  select count(*) into n from public.payments
    where order_id = '0ada0002-0000-0000-0000-000000000001' and rail = 'stripe_online';
  assert n = 2, 'one canceled + one live stripe_online tender expected';
end $$;

-- 20) Audit actions (20261101000200): the late-payment actions and the Phase 7
--     values the app already writes are valid enum members.
insert into public.audit_log (actor_user_id, actor_label, action, tenant_id, detail) values
  ('00000000-0000-0000-0000-000000000000', 'system', 'late_payment_flagged', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 't'),
  ('00000000-0000-0000-0000-000000000000', 'system', 'late_payment_accepted', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 't'),
  ('00000000-0000-0000-0000-000000000000', 'system', 'late_payment_refunded', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 't'),
  ('00000000-0000-0000-0000-000000000000', 'system', 'payment_refund', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 't'),
  ('00000000-0000-0000-0000-000000000000', 'system', 'payment_void', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 't');

-- 21) Late-payment / idempotency migration (20261101000300): settled tenders do not
--     hold the open-tender slot, one delivery per order, and the atomic
--     fulfillment RPCs (claim is exclusive).
do $$
declare blocked boolean := false; n int; claimed int;
begin
  -- captured + a new open card tender is allowed; two OPEN ones are not.
  insert into public.payments
    (id, order_id, tenant_id, location_id, rail, status, amount_cents, currency)
  values
    ('0aea0099-0000-0000-0000-000000000001', '0ada0002-0000-0000-0000-000000000001',
     'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1',
     'crypto_coinbase', 'captured', 1099, 'USD'),
    ('0aea0099-0000-0000-0000-000000000002', '0ada0002-0000-0000-0000-000000000001',
     'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1',
     'crypto_coinbase', 'pending', 1099, 'USD');
  begin
    insert into public.payments
      (id, order_id, tenant_id, location_id, rail, status, amount_cents, currency)
    values
      ('0aea0099-0000-0000-0000-000000000003', '0ada0002-0000-0000-0000-000000000001',
       'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1',
       'crypto_coinbase', 'pending', 1099, 'USD');
  exception when unique_violation then blocked := true; end;
  assert blocked, 'two OPEN coinbase tenders on one order must be refused';

  select count(*) into n from pg_indexes
   where indexname = 'deliveries_order_id_uidx';
  assert n = 1, 'one delivery per order index must exist';

  -- Atomic fulfillment helpers.
  update public.orders
     set fulfillment = '{"type":"pickup","late_payment":{"payment_id":"p","amount_cents":5,"flagged_at":"x"}}'::jsonb
   where id = '0ada0002-0000-0000-0000-000000000001';
  select count(*) into claimed from public.claim_late_payment(
    '0ada0002-0000-0000-0000-000000000001', 'refunding', now() - interval '10 minutes');
  assert claimed = 1, 'first claim must win';
  select count(*) into claimed from public.claim_late_payment(
    '0ada0002-0000-0000-0000-000000000001', 'accepting', now() - interval '10 minutes');
  assert claimed = 0, 'a second concurrent claim must lose';
  perform public.update_late_payment('0ada0002-0000-0000-0000-000000000001',
    '{"resolved":"refund_owed_manual","claim":null,"claim_at":null}'::jsonb);
  assert (select fulfillment -> 'late_payment' ->> 'claim' from public.orders
           where id = '0ada0002-0000-0000-0000-000000000001') is null,
    'releasing the claim removes it';
  select count(*) into claimed from public.claim_late_payment(
    '0ada0002-0000-0000-0000-000000000001', 'marking_refunded', now() - interval '10 minutes');
  assert claimed = 1, 'a refund-owed item can be claimed again (mark refunded)';
  perform public.merge_order_fulfillment('0ada0002-0000-0000-0000-000000000001',
    '{"finalized_at":"t"}'::jsonb);
  assert (select fulfillment ->> 'finalized_at' from public.orders
           where id = '0ada0002-0000-0000-0000-000000000001') = 't', 'merge sets a key';
  assert (select fulfillment -> 'late_payment' ->> 'amount_cents' from public.orders
           where id = '0ada0002-0000-0000-0000-000000000001') = '5', 'merge keeps other keys';
end $$;

-- ...and they are server-only.
select pg_temp.act_as('11111111-1111-1111-1111-111111111111');
do $$
declare blocked boolean := false;
begin
  begin
    perform public.claim_late_payment('0ada0002-0000-0000-0000-000000000001', 'accepting', now());
  exception when insufficient_privilege then blocked := true; end;
  assert blocked, 'authenticated users must NOT be able to call claim_late_payment';
end $$;
reset role;

-- 22) Terminal readers/locations (20261103000000): a tenant member reads ONLY their
--     own tenant's rows; nobody on the user path (owner included) can write them
--     (they route card-present money; the service-role server writes them); both
--     tables are FORCE RLS; and only ONE open card-present tender may exist per
--     order (a settled/canceled one frees the slot).
set session_replication_role = replica;
insert into public.terminal_locations (location_id, tenant_id, connect_account_id, stripe_location_id, livemode)
values
  ('a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'acct_fixture_a', 'tml_a', false),
  ('b1b1b1b1-b1b1-b1b1-b1b1-b1b1b1b1b1b1', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'acct_fixture_b', 'tml_b', false);
insert into public.terminal_readers (id, tenant_id, location_id, connect_account_id, label)
values
  ('tmr_a', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1', 'acct_fixture_a', 'A reader'),
  ('tmr_b', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'b1b1b1b1-b1b1-b1b1-b1b1-b1b1b1b1b1b1', 'acct_fixture_b', 'B reader');
set session_replication_role = origin;

select pg_temp.act_as('11111111-1111-1111-1111-111111111111');
do $$
declare n int; m int; blocked boolean;
begin
  select count(*) into n from public.terminal_readers;
  select count(*) into m from public.terminal_locations;
  assert n = 1, format('owner A must see only tenant A readers, saw %s', n);
  assert m = 1, format('owner A must see only tenant A terminal locations, saw %s', m);

  blocked := false;
  begin
    insert into public.terminal_readers (id, tenant_id, location_id, connect_account_id)
    values ('tmr_evil', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1', 'acct_evil');
  exception when others then blocked := true; end;
  assert blocked, 'owner must NOT insert terminal_readers (service-role only)';

  blocked := false;
  begin
    update public.terminal_locations set connect_account_id = 'acct_evil';
  exception when others then blocked := true; end;
  assert blocked, 'owner must NOT update terminal_locations (service-role only)';

  blocked := false;
  begin
    delete from public.terminal_readers;
  exception when others then blocked := true; end;
  assert blocked, 'owner must NOT delete terminal_readers (service-role only)';
end $$;
reset role;

select pg_temp.act_as('22222222-2222-2222-2222-222222222222');
do $$
declare n int;
begin
  select count(*) into n from public.terminal_readers where id = 'tmr_a';
  assert n = 0, 'a user of tenant B must not see tenant A readers';
end $$;
reset role;

do $$
declare blocked boolean := false; n int;
begin
  assert (select count(*) from public.terminal_readers) = 2, 'service path still holds both readers';
  assert (select c.relforcerowsecurity from pg_class c where c.oid = 'public.terminal_readers'::regclass),
    'terminal_readers must be FORCE RLS';
  assert (select c.relforcerowsecurity from pg_class c where c.oid = 'public.terminal_locations'::regclass),
    'terminal_locations must be FORCE RLS';

  -- One open card-present tender per order (order from fixture 19).
  insert into public.payments
    (id, order_id, tenant_id, location_id, rail, status, amount_cents, currency)
  values
    ('0aea0077-0000-0000-0000-000000000001', '0ada0002-0000-0000-0000-000000000001',
     'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1',
     'stripe_terminal', 'requires_action', 500, 'USD');
  begin
    insert into public.payments
      (id, order_id, tenant_id, location_id, rail, status, amount_cents, currency)
    values
      ('0aea0077-0000-0000-0000-000000000002', '0ada0002-0000-0000-0000-000000000001',
       'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1',
       'stripe_terminal', 'pending', 500, 'USD');
  exception when unique_violation then blocked := true; end;
  assert blocked, 'a second open stripe_terminal tender on one order must be refused';

  -- A settled terminal tender does not hold the slot.
  update public.payments set status = 'captured' where id = '0aea0077-0000-0000-0000-000000000001';
  insert into public.payments
    (id, order_id, tenant_id, location_id, rail, status, amount_cents, currency)
  values
    ('0aea0077-0000-0000-0000-000000000002', '0ada0002-0000-0000-0000-000000000001',
     'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1',
     'stripe_terminal', 'requires_action', 500, 'USD');
  select count(*) into n from public.payments
    where order_id = '0ada0002-0000-0000-0000-000000000001' and rail = 'stripe_terminal';
  assert n = 2, 'one captured + one open stripe_terminal tender expected';
end $$;

-- 23) merge_order_fulfillment (20261103000100) also works on an IN-STORE order
--     with no fulfillment blob (a duplicate-payment flag creates it).
do $$
begin
  insert into public.orders
    (id, tenant_id, location_id, status, channel, currency, discount_cents, totals, order_number)
  values
    ('0ada0077-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
     'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1', 'paid', 'in_store', 'USD', 0,
     '{"total_cents":1000}'::jsonb, 'A-0077');
  assert (select fulfillment from public.orders where id = '0ada0077-0000-0000-0000-000000000001') is null,
    'an in-store order starts with no fulfillment';
  perform public.merge_order_fulfillment('0ada0077-0000-0000-0000-000000000001',
    '{"late_payment":{"kind":"duplicate","payment_id":"p","amount_cents":1000,"flagged_at":"t"}}'::jsonb);
  assert (select fulfillment -> 'late_payment' ->> 'kind' from public.orders
           where id = '0ada0077-0000-0000-0000-000000000001') = 'duplicate',
    'merge creates the blob on an in-store order';
  perform public.update_late_payment('0ada0077-0000-0000-0000-000000000001', '{"amount_cents":500}'::jsonb);
  assert (select fulfillment -> 'late_payment' ->> 'amount_cents' from public.orders
           where id = '0ada0077-0000-0000-0000-000000000001') = '500',
    'update_late_payment works on the created marker';
end $$;
reset role;

-- PR #20 (20261102000100/000200): subscriptions, tenant status and the
-- platform-suspension flag are server-write-only; terminal staff sessions and
-- the PIN-lockout function are service_role only.
select pg_temp.act_as('11111111-1111-1111-1111-111111111111');
do $$
declare blocked boolean;
begin
  blocked := false;
  begin
    insert into public.subscriptions (tenant_id, tier, status)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'pro', 'active');
  exception when others then blocked := true; end;
  assert blocked, 'owner must NOT be able to insert subscriptions';

  blocked := false;
  begin
    update public.subscriptions set tier = 'multi'
      where tenant_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  exception when insufficient_privilege then blocked := true; end;
  assert blocked, 'owner must NOT be able to update subscriptions (tier bypass)';

  blocked := false;
  begin
    update public.tenants set status = 'active'
      where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  exception when insufficient_privilege then blocked := true; end;
  assert blocked, 'owner must NOT be able to change tenants.status';

  blocked := false;
  begin
    update public.tenants set suspended_by_platform = false
      where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  exception when insufficient_privilege then blocked := true; end;
  assert blocked, 'owner must NOT be able to clear tenants.suspended_by_platform';

  -- The display name stays owner-editable.
  update public.tenants set name = name
    where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

  blocked := false;
  begin
    perform count(*) from public.terminal_staff_sessions;
  exception when insufficient_privilege then blocked := true; end;
  assert blocked, 'authenticated users must NOT read terminal_staff_sessions';

  blocked := false;
  begin
    perform public.record_pin_failure('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      '57a00001-0000-0000-0000-000000000001');
  exception when insufficient_privilege then blocked := true; end;
  assert blocked, 'authenticated users must NOT call record_pin_failure';
end $$;
reset role;

-- record_pin_failure locks after 5 failures (server path).
do $$
declare r jsonb; i int;
begin
  for i in 1..4 loop
    r := public.record_pin_failure('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      (select id from public.staff where tenant_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' limit 1));
    assert (r ->> 'locked_until') is null, format('no lock after %s failures', i);
  end loop;
  r := public.record_pin_failure('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    (select id from public.staff where tenant_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' limit 1));
  assert (r ->> 'locked_until') is not null, 'the 5th failure locks the PIN';
end $$;

select 'RLS isolation test PASSED' as result;

rollback;
