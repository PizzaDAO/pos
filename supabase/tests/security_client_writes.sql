-- ============================================================================
-- security_client_writes checks (migration 20261112000000; audit H1, H2, M2).
-- Run by scripts/pglite-migrate.mjs after the migrations + seed. Rolled back.
--
--   * an authenticated tenant member (owner AND kitchen) can no longer insert or
--     update payments / orders / order_items / order_item_modifiers / deliveries
--     / shift_cash_events / shifts / inventory_movements / staff / customers,
--     but can still SELECT them (realtime + tracking keep working)
--   * magic_link_tokens: no client role can read, mint or un-consume a token
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

-- A legacy shop magic-link token (server-minted) for a demo-tenant customer.
insert into public.customers (id, tenant_id, email) values
  ('5ec0000c-0000-4000-8000-000000000001', '10000000-0000-0000-0000-000000000001',
   'mlt@x.example');
insert into public.magic_link_tokens (token, tenant_id, email, customer_id, expires_at, consumed)
values ('sectoken0001', '10000000-0000-0000-0000-000000000001', 'mlt@x.example',
        '5ec0000c-0000-4000-8000-000000000001', now() - interval '1 hour', true);

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
  foreach tbl in array array['orders','order_items','order_item_modifiers','payments','deliveries',
                             'shift_cash_events','shifts','inventory_movements','staff',
                             'customers','magic_link_tokens'] loop
    foreach priv in array array['INSERT','UPDATE','DELETE'] loop
      if has_table_privilege('authenticated', 'public.' || tbl, priv) then
        raise exception 'authenticated still has % on %', priv, tbl;
      end if;
      if has_table_privilege('anon', 'public.' || tbl, priv) then
        raise exception 'anon still has % on %', priv, tbl;
      end if;
    end loop;
    if tbl <> 'magic_link_tokens'
       and not has_any_column_privilege('authenticated', 'public.' || tbl, 'SELECT') then
      raise exception 'authenticated lost SELECT on % (realtime/tracking need it)', tbl;
    end if;
  end loop;
  if has_table_privilege('authenticated', 'public.magic_link_tokens', 'SELECT')
     or has_table_privilege('anon', 'public.magic_link_tokens', 'SELECT') then
    raise exception 'a client role can still read magic_link_tokens';
  end if;
  select count(*) into n from pg_policies
   where schemaname = 'public'
     and tablename in ('orders','order_items','order_item_modifiers','payments','deliveries',
                       'shift_cash_events','shifts','inventory_movements','staff',
                       'customers','magic_link_tokens')
     and cmd <> 'SELECT';
  if n <> 0 then raise exception '% write policies remain', n; end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'magic_link_tokens') then
    raise exception 'a magic_link_tokens policy remains';
  end if;

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
    if not pg_temp.denied(u, format(
      'insert into public.order_item_modifiers (id, order_item_id, group_id, group_name, modifier_id, modifier_name, price_cents)
       select gen_random_uuid(), oi.id, gen_random_uuid(), %L, gen_random_uuid(), %L, -500 from public.order_items oi limit 1',
      'g', 'discount')) then
      raise exception 'member % inserted an order item modifier', u;
    end if;
    if not pg_temp.denied(u, format(
      'insert into public.shifts (tenant_id, location_id, staff_id) values (%L, %L, %L)',
      t, l, '80000000-0000-0000-0000-000000000004')) then
      raise exception 'member % opened a shift', u;
    end if;
    if not pg_temp.denied(u, format(
      'update public.shifts set opening_float_cents = 0 where tenant_id = %L', t)) then
      raise exception 'member % updated shifts', u;
    end if;
    if not pg_temp.denied(u, format(
      'insert into public.inventory_movements (tenant_id, location_id, inventory_item_id, reason, delta, resulting_on_hand)
       select %L, %L, id, (enum_range(null::public.movement_reason))[1], 1000, 1000
         from public.inventory_items limit 1', t, l)) then
      raise exception 'member % inserted an inventory movement', u;
    end if;
    -- L4: a known pin_hash onto the owner's staff row, or a new staff row.
    if not pg_temp.denied(u, format(
      'update public.staff set pin_hash = %L where id = %L', 'scrypt$known', '80000000-0000-0000-0000-000000000001')) then
      raise exception 'member % set a staff pin_hash', u;
    end if;
    if not pg_temp.denied(u, format(
      'insert into public.staff (tenant_id, name, role) values (%L, %L, %L)', t, 'Ghost', 'owner')) then
      raise exception 'member % inserted a staff row', u;
    end if;
    -- customers: no member write branch either.
    if not pg_temp.denied(u, format(
      'insert into public.customers (id, tenant_id, email) values (gen_random_uuid(), %L, %L)', t, 'crm@x.example')) then
      raise exception 'member % inserted a customer', u;
    end if;
    if not pg_temp.denied(u, format(
      'update public.customers set email = %L where id = %L', 'moved@x.example', '5ec0000c-0000-4000-8000-000000000001')) then
      raise exception 'member % updated a customer', u;
    end if;
    -- magic_link_tokens: cannot mint, revive (un-consume / extend) or read one.
    if not pg_temp.denied(u, format(
      'insert into public.magic_link_tokens (token, tenant_id, email, customer_id, expires_at)
       values (%L, %L, %L, %L, now() + interval %L)',
      'minted-' || u, t, 'mlt@x.example', '5ec0000c-0000-4000-8000-000000000001', '1 day')) then
      raise exception 'member % minted a magic-link token', u;
    end if;
    if not pg_temp.denied(u, format(
      'update public.magic_link_tokens set consumed = false, expires_at = now() + interval %L where token = %L',
      '1 day', 'sectoken0001')) then
      raise exception 'member % revived a magic-link token', u;
    end if;
    if not pg_temp.denied(u, 'select token from public.magic_link_tokens') then
      raise exception 'member % read magic-link tokens', u;
    end if;
  end loop;

  -- The stranger (signed in, no membership) cannot mint or read tokens either.
  if not pg_temp.denied(stranger, format(
    'insert into public.magic_link_tokens (token, tenant_id, email, customer_id, expires_at)
     values (%L, %L, %L, %L, now() + interval %L)',
    'minted-stranger', t, 'mlt@x.example', '5ec0000c-0000-4000-8000-000000000001', '1 day')) then
    raise exception 'stranger minted a magic-link token';
  end if;
  if (select count(*) from public.magic_link_tokens where token like 'minted-%') <> 0 then
    raise exception 'a client-minted token exists';
  end if;
  if (select consumed from public.magic_link_tokens where token = 'sectoken0001') is not true then
    raise exception 'a consumed token was revived';
  end if;
  if exists (select 1 from public.staff where pin_hash = 'scrypt$known' or name = 'Ghost') then
    raise exception 'staff row forged';
  end if;
  if (select email from public.customers where id = '5ec0000c-0000-4000-8000-000000000001') <> 'mlt@x.example' then
    raise exception 'customer email changed';
  end if;

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
  update public.staff set pin_hash = null where id = '80000000-0000-0000-0000-000000000004';
  update public.magic_link_tokens set consumed = true where token = 'sectoken0001';
  insert into public.customers (id, tenant_id, email)
    values (gen_random_uuid(), t::uuid, 'server-made@x.example');
end
$$;

rollback;
