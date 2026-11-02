-- ============================================================================
-- security_client_writes checks (migration 20261112000000; audit H1, H2, M2).
-- Run by scripts/pglite-migrate.mjs after the migrations + seed. Rolled back.
--
--   * an authenticated tenant member (owner AND kitchen) can no longer insert or
--     update payments / orders / order_items / deliveries / shift_cash_events,
--     but can still SELECT them (realtime + tracking keep working)
--   * a signed-in non-member cannot insert a customers row "as self" binding
--     another email at a tenant, nor edit one planted for them
--   * a user cannot change their own public.users.email
--   * the service role / table owner (the app's driver) is unaffected
-- ============================================================================
begin;
set client_min_messages = warning;

insert into public.users (id, email) values
  ('5ec00000-0000-4000-8000-000000000001', 'sec-owner@x.example'),
  ('5ec00000-0000-4000-8000-000000000002', 'sec-kitchen@x.example'),
  ('5ec00000-0000-4000-8000-000000000003', 'sec-stranger@x.example');
insert into public.memberships (user_id, tenant_id, role) values
  ('5ec00000-0000-4000-8000-000000000001', '10000000-0000-0000-0000-000000000001', 'owner'),
  ('5ec00000-0000-4000-8000-000000000002', '10000000-0000-0000-0000-000000000001', 'kitchen');

insert into public.orders
  (id, tenant_id, location_id, status, channel, currency, discount_cents, totals, order_number)
values
  ('5ec0000a-0000-4000-8000-000000000001', '10000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000101', 'placed', 'in_store', 'USD', 0,
   '{"total_cents":1000}'::jsonb, 'SEC-1');
insert into public.payments
  (id, order_id, tenant_id, location_id, rail, status, amount_cents, currency)
values
  ('5ec0000b-0000-4000-8000-000000000001', '5ec0000a-0000-4000-8000-000000000001',
   '10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000101',
   'cash', 'pending', 1000, 'USD');

-- Runs p_sql as user p_uid (role authenticated) and reports whether it was
-- refused with insufficient_privilege (42501: no grant, or an RLS check).
create or replace function pg_temp.denied(p_uid text, p_sql text) returns boolean
language plpgsql as $$
declare v_denied boolean := false;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid)::text, true);
  begin
    execute 'set local role authenticated';
    execute p_sql;
  exception when insufficient_privilege then
    v_denied := true;
  end;
  execute 'reset role';
  perform set_config('request.jwt.claims', '{}', true);
  return v_denied;
end;
$$;

do $$
declare
  owner_u   constant text := '5ec00000-0000-4000-8000-000000000001';
  kitchen_u constant text := '5ec00000-0000-4000-8000-000000000002';
  stranger  constant text := '5ec00000-0000-4000-8000-000000000003';
  t         constant text := '10000000-0000-0000-0000-000000000001';
  l         constant text := '10000000-0000-0000-0000-000000000101';
  o         constant text := '5ec0000a-0000-4000-8000-000000000001';
  p         constant text := '5ec0000b-0000-4000-8000-000000000001';
  u text;
  tbl text;
  priv text;
  n int;
begin
  -- ---- H1: grants are gone for both client roles ----------------------------
  foreach tbl in array array['orders','order_items','payments','deliveries','shift_cash_events'] loop
    foreach priv in array array['INSERT','UPDATE','DELETE'] loop
      if has_table_privilege('authenticated', 'public.' || tbl, priv) then
        raise exception 'authenticated still has % on %', priv, tbl;
      end if;
      if has_table_privilege('anon', 'public.' || tbl, priv) then
        raise exception 'anon still has % on %', priv, tbl;
      end if;
    end loop;
    if not has_table_privilege('authenticated', 'public.' || tbl, 'SELECT') then
      raise exception 'authenticated lost SELECT on % (realtime/tracking need it)', tbl;
    end if;
  end loop;
  select count(*) into n from pg_policies
   where schemaname = 'public'
     and policyname in ('orders_insert','orders_update','orders_delete','order_items_write',
                        'payments_write','deliveries_write','shift_cash_events_write');
  if n <> 0 then raise exception '% write policies remain', n; end if;

  -- ---- H1: a tenant member (owner and kitchen) cannot write money rows ------
  foreach u in array array[owner_u, kitchen_u] loop
    if not pg_temp.denied(u, format(
      'insert into public.payments (id, order_id, tenant_id, location_id, rail, status, amount_cents, currency)
       values (gen_random_uuid(), %L, %L, %L, %L, %L, 5000, %L)', o, t, l, 'cash', 'captured', 'USD')) then
      raise exception 'member % inserted a captured payment', u;
    end if;
    if not pg_temp.denied(u, format(
      'update public.payments set status = %L, refunded_cents = 0 where id = %L', 'captured', p)) then
      raise exception 'member % updated a payment', u;
    end if;
    if not pg_temp.denied(u, format(
      'insert into public.orders (id, tenant_id, location_id, status, channel, currency, discount_cents, totals, order_number)
       values (gen_random_uuid(), %L, %L, %L, %L, %L, 0, %L::jsonb, %L)',
      t, l, 'paid', 'in_store', 'USD', '{"total_cents":1}', 'SEC-HACK')) then
      raise exception 'member % inserted an order', u;
    end if;
    if not pg_temp.denied(u, format(
      'update public.orders set discount_cents = 1000, status = %L where id = %L', 'paid', o)) then
      raise exception 'member % updated an order', u;
    end if;
    if not pg_temp.denied(u, format('delete from public.orders where id = %L', o)) then
      raise exception 'member % deleted an order', u;
    end if;
    if not pg_temp.denied(u, format(
      'insert into public.order_items (id, order_id, item_id, item_name) values (gen_random_uuid(), %L, gen_random_uuid(), %L)',
      o, 'free pizza')) then
      raise exception 'member % inserted an order item', u;
    end if;
    if not pg_temp.denied(u, format(
      'update public.deliveries set fee_cents = 0 where order_id = %L', o)) then
      raise exception 'member % updated deliveries', u;
    end if;
    if not pg_temp.denied(u, format(
      'delete from public.shift_cash_events where tenant_id = %L', t)) then
      raise exception 'member % deleted cash events', u;
    end if;
  end loop;

  -- Nothing changed.
  if (select status from public.payments where id = p::uuid) <> 'pending' then
    raise exception 'payment status changed';
  end if;
  if (select discount_cents from public.orders where id = o::uuid) <> 0 then
    raise exception 'order discount changed';
  end if;
  if exists (select 1 from public.orders where order_number = 'SEC-HACK') then
    raise exception 'forged order exists';
  end if;
  if (select count(*) from public.payments where order_id = o::uuid) <> 1 then
    raise exception 'forged payment exists';
  end if;

  -- SELECT still works for the member (and is tenant-scoped).
  perform set_config('request.jwt.claims', json_build_object('sub', kitchen_u)::text, true);
  execute 'set local role authenticated';
  select count(*) into n from public.orders where id = o::uuid;
  execute 'reset role';
  perform set_config('request.jwt.claims', '{}', true);
  if n <> 1 then raise exception 'member can no longer read its order (%)', n; end if;

  -- ---- H2: no self customer rows binding someone else's email ---------------
  if not pg_temp.denied(stranger, format(
    'insert into public.customers (id, tenant_id, email) values (%L, %L, %L)',
    stranger, t, 'victim@x.example')) then
    raise exception 'stranger inserted a self customer row';
  end if;
  if exists (select 1 from public.customers where id = stranger::uuid) then
    raise exception 'planted customer row exists';
  end if;
  -- A row with the stranger's uid planted before the fix cannot be edited by them.
  insert into public.customers (id, tenant_id, email)
    values (stranger::uuid, t::uuid, 'planted@x.example');
  perform pg_temp.denied(stranger, format(
    'update public.customers set email = %L where id = %L', 'victim@x.example', stranger));
  if (select email from public.customers where id = stranger::uuid) <> 'planted@x.example' then
    raise exception 'stranger edited their self customer row';
  end if;
  -- ...but can still READ their own row (customers_select is unchanged).
  perform set_config('request.jwt.claims', json_build_object('sub', stranger)::text, true);
  execute 'set local role authenticated';
  select count(*) into n from public.customers where id = stranger::uuid;
  execute 'reset role';
  perform set_config('request.jwt.claims', '{}', true);
  if n <> 1 then raise exception 'self customer read broke (%)', n; end if;

  -- ---- M2: users.email is not client-updatable -----------------------------
  if has_column_privilege('authenticated', 'public.users', 'email', 'UPDATE') then
    raise exception 'authenticated can still UPDATE users.email';
  end if;
  if not pg_temp.denied(stranger, format(
    'update public.users set email = %L where id = %L', 'newowner@pizzeria.example', stranger)) then
    raise exception 'user changed their own email';
  end if;
  if (select email from public.users where id = stranger::uuid) <> 'sec-stranger@x.example' then
    raise exception 'users.email changed';
  end if;

  -- ---- The server path (table owner / service role) is unaffected -----------
  update public.payments set status = 'captured' where id = p::uuid;
  insert into public.customers (id, tenant_id, email)
    values (gen_random_uuid(), t::uuid, 'server-made@x.example');
end
$$;

rollback;
