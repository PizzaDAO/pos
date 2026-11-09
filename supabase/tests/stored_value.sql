-- ============================================================================
-- Stored value (gift cards + store credit) checks for 20261113000910 (run by
-- scripts/pglite-migrate.mjs after the migrations + seed). Raises on the first
-- failed expectation; rolled back at the end.
-- ============================================================================
begin;

do $$
declare
  t uuid := '10000000-0000-0000-0000-000000000001';
  loc uuid;
  sale uuid := gen_random_uuid();   -- the gift card sale order ($50, no tax)
  food uuid := gen_random_uuid();   -- a $30 food order paid with the card
  cash uuid := gen_random_uuid();
  acct uuid := gen_random_uuid();
  acct2 uuid := gen_random_uuid();
  acct3 uuid := gen_random_uuid();
  i int;
  p1 uuid := gen_random_uuid();
  p2 uuid := gen_random_uuid();
  r jsonb;
  n int;
  bal int;
begin
  select id into loc from public.locations where tenant_id = t limit 1;

  insert into public.orders (id, tenant_id, location_id, status, currency, totals, order_number, core_ext)
  values (sale, t, loc, 'draft', 'USD',
          '{"subtotal_cents":0,"discount_cents":0,"taxable_cents":0,"tax_cents":0,"tip_cents":0,"total_cents":5000}'::jsonb,
          'GC-1', jsonb_build_object('stored_value', jsonb_build_object('op','sell','account_id',acct,'amount_cents',5000,'code_last4','ABCD'))),
         (food, t, loc, 'placed', 'USD',
          '{"subtotal_cents":2800,"discount_cents":0,"taxable_cents":2800,"tax_cents":200,"tip_cents":0,"total_cents":3000}'::jsonb,
          'GC-2', null);

  insert into public.stored_value_accounts (id, tenant_id, kind, status, currency, code_hash, code_last4, source)
  values (acct, t, 'gift_card', 'pending', 'USD', 'hash-1', 'ABCD', 'till');

  -- the same code twice for one tenant is refused
  begin
    insert into public.stored_value_accounts (id, tenant_id, kind, status, currency, code_hash, code_last4, source)
    values (gen_random_uuid(), t, 'gift_card', 'pending', 'USD', 'hash-1', 'ABCD', 'till');
    raise exception 'duplicate code hash accepted';
  exception when unique_violation then null;
  end;

  -- ---- activation needs a SETTLED sale order -----------------------------------
  r := public.sv_credit(t, acct, loc, 'issue', 5000, 'sale:' || sale, sale, null, null, null, null, true, sale, 100000);
  if r ->> 'outcome' <> 'not_settled' then raise exception 'unpaid sale activated: %', r; end if;

  insert into public.payments (id, order_id, tenant_id, location_id, rail, status, amount_cents, tip_cents, currency, simulated)
  values (cash, sale, t, loc, 'cash', 'captured', 5000, 0, 'USD', false);

  r := public.sv_credit(t, acct, loc, 'issue', 5000, 'sale:' || sale, sale, null, null, null, null, true, sale, 100000);
  if r ->> 'outcome' <> 'ok' or (r -> 'account' ->> 'status') <> 'active'
     or (r -> 'account' ->> 'balance_cents')::int <> 5000 then
    raise exception 'activation: %', r;
  end if;
  -- replay: nothing new
  r := public.sv_credit(t, acct, loc, 'issue', 5000, 'sale:' || sale, sale, null, null, null, null, true, sale, 100000);
  if (r ->> 'replayed')::boolean is not true then raise exception 'activation replay: %', r; end if;
  select count(*) into n from public.stored_value_ledger where account_id = acct;
  if n <> 1 then raise exception 'replay wrote % rows', n; end if;

  -- max balance cap on loads
  r := public.sv_credit(t, acct, loc, 'load', 96000, 'load-big', null, null, null, null, null, false, null, 100000);
  if r ->> 'outcome' <> 'exceeds_max' then raise exception 'cap: %', r; end if;

  -- ---- redemption ---------------------------------------------------------------
  r := public.sv_redeem(t, acct, sale, p1, 100);
  if r ->> 'outcome' <> 'order_not_payable' then raise exception 'paid a gift card with a gift card: %', r; end if;
  r := public.sv_redeem(t, acct, food, p1, 3500);
  if r ->> 'outcome' <> 'exceeds_due' then raise exception 'overpay: %', r; end if;
  r := public.sv_redeem(t, acct, food, p1, 0);
  if r ->> 'outcome' <> 'bad_amount' then raise exception 'zero: %', r; end if;
  r := public.sv_redeem(t, acct, food, p1, 2000);
  if r ->> 'outcome' <> 'ok' or (r -> 'account' ->> 'balance_cents')::int <> 3000 then
    raise exception 'redeem: %', r;
  end if;
  select count(*) into n from public.payments
   where id = p1 and rail = 'gift_card' and status = 'captured' and amount_cents = 2000 and order_id = food;
  if n <> 1 then raise exception 'tender not written'; end if;
  -- replay of the same tender: nothing new
  r := public.sv_redeem(t, acct, food, p1, 2000);
  if (r ->> 'replayed')::boolean is not true then raise exception 'redeem replay: %', r; end if;
  select balance_cents into bal from public.stored_value_accounts where id = acct;
  if bal <> 3000 then raise exception 'replay moved money: %', bal; end if;
  -- the same tender id on another order is a conflict
  r := public.sv_redeem(t, acct, sale, p1, 100);
  if r ->> 'outcome' <> 'conflict' then raise exception 'id reuse: %', r; end if;
  -- only $10 is still owed on the food order
  r := public.sv_redeem(t, acct, food, p2, 1500);
  if r ->> 'outcome' <> 'exceeds_due' then raise exception 'second tender overpays: %', r; end if;

  -- ---- refund to card + void rules ----------------------------------------------
  r := public.sv_credit(t, acct, loc, 'refund', 2000, 'refund_' || p1, food, p1);
  if (r -> 'account' ->> 'balance_cents')::int <> 5000 then raise exception 'refund: %', r; end if;
  r := public.sv_void(t, acct, loc, 'void-1', 'customer changed mind', 'staff');
  if r ->> 'outcome' <> 'has_activity' then raise exception 'voided a redeemed card: %', r; end if;

  insert into public.stored_value_accounts (id, tenant_id, kind, status, currency, code_hash, code_last4, source)
  values (acct2, t, 'store_credit', 'active', 'USD', 'hash-2', 'WXYZ', 'issued');
  r := public.sv_credit(t, acct2, loc, 'issue', 1200, 'issue-1', null, null, 'late order', 'staff', 'mgr');
  r := public.sv_void(t, acct2, loc, 'void-2', 'issued by mistake', 'mgr');
  if r ->> 'outcome' <> 'ok' or (r -> 'account' ->> 'status') <> 'voided'
     or (r -> 'entry' ->> 'amount_cents')::int <> -1200 then
    raise exception 'void: %', r;
  end if;
  r := public.sv_redeem(t, acct2, food, p2, 100);
  if r ->> 'outcome' <> 'inactive' then raise exception 'redeemed a voided card: %', r; end if;

  -- ---- ledger integrity: the cached balance equals the ledger sum ----------------
  select balance_cents into bal from public.stored_value_accounts where id = acct;
  select sum(amount_cents) into n from public.stored_value_ledger where account_id = acct;
  if bal <> n then raise exception 'cache % <> ledger %', bal, n; end if;

  -- ---- owner reports (20261113000920): the sale is a liability, not a sale ------
  update public.orders set status = 'completed' where id = sale;
  r := public.report_sales_bundle(t, loc, current_date - 2, current_date + 2);
  select coalesce(sum((d ->> 'orders')::int), 0) into n from jsonb_array_elements(r -> 'daily') d;
  if n <> 1 then raise exception 'report counted % orders (sale must be excluded): %', n, r -> 'daily'; end if;
  select coalesce(sum((d ->> 'cash_cents')::int), 0) into n from jsonb_array_elements(r -> 'daily') d;
  if n <> 0 then raise exception 'gift card sale cash counted as sales tender: %', n; end if;
  select coalesce(sum((d ->> 'gift_card_cents')::int), 0) into n from jsonb_array_elements(r -> 'daily') d;
  if n <> 2000 then raise exception 'gift_card tender line: %', n; end if;
  select coalesce(sum((d ->> 'other_cents')::int), 0) into n from jsonb_array_elements(r -> 'daily') d;
  if n <> 0 then raise exception 'gift card fell into other: %', n; end if;
  if (r -> 'stored_value' ->> 'sold_cents')::int <> 5000
     or (r -> 'stored_value' ->> 'redeemed_gift_card_cents')::int <> 2000
     or (r -> 'stored_value' ->> 'outstanding_cents')::int <> 5000 then
    raise exception 'stored_value section: %', r -> 'stored_value';
  end if;
  if exists (select 1 from jsonb_array_elements(r -> 'tenders') x where x ->> 'key' = 'cash') then
    raise exception 'sale tender in the tender list: %', r -> 'tenders';
  end if;
  -- redeemed is NET of value refunded back to the card
  update public.payments set refunded_cents = 500 where id = p1;
  r := public.report_sales_bundle(t, loc, current_date - 2, current_date + 2);
  if (r -> 'stored_value' ->> 'redeemed_gift_card_cents')::int <> 1500 then
    raise exception 'redeemed not net of refunds: %', r -> 'stored_value';
  end if;
  update public.payments set refunded_cents = 0 where id = p1;

  -- ---- one-time reveal, guard, atomic store credit ------------------------------
  update public.stored_value_accounts set source = 'online' where id = acct;
  if not public.sv_mark_revealed(t, acct) then raise exception 'first reveal refused'; end if;
  if public.sv_mark_revealed(t, acct) then raise exception 'second reveal allowed'; end if;

  for i in 1..3 loop perform public.sv_guard_fail(array['k1', 'k2'], 2, 900); end loop;
  if public.sv_guard_check(array['k1']) <= 0 then raise exception 'guard did not lock'; end if;
  if public.sv_guard_check(array['k3']) <> 0 then raise exception 'guard locked an unrelated key'; end if;

  r := public.sv_issue_store_credit(t, acct3, loc, 'USD', 'hash-3', 'AAAA', null, 6000, 'late', 'cashier1', false, 10000);
  if r ->> 'outcome' <> 'ok' or (r -> 'account' ->> 'balance_cents')::int <> 6000 then raise exception 'issue: %', r; end if;
  r := public.sv_issue_store_credit(t, acct3, loc, 'USD', 'hash-3', 'AAAA', null, 6000, 'late', 'cashier1', false, 10000);
  if r ->> 'outcome' <> 'replayed' then raise exception 'issue replay: %', r; end if;
  r := public.sv_issue_store_credit(t, gen_random_uuid(), loc, 'USD', 'hash-4', 'BBBB', null, 5000, 'late', 'cashier1', false, 10000);
  if r ->> 'outcome' <> 'approval_required' then raise exception 'daily cap: %', r; end if;
  r := public.sv_issue_store_credit(t, gen_random_uuid(), loc, 'USD', 'hash-4', 'BBBB', null, 5000, 'late', 'mgr1', true, 10000);
  if r ->> 'outcome' <> 'ok' or (r -> 'entry' ->> 'approved_by') <> 'mgr1' then raise exception 'manager issue: %', r; end if;

  -- refund-to-card is capped at what the tender redeemed
  r := public.sv_credit(t, acct, loc, 'refund', 1, 'refund-extra', food, p1);
  if r ->> 'outcome' <> 'exceeds_max' then raise exception 'refund over the redemption: %', r; end if;

  -- ---- set_payment_refund_ref (20261113000930) ------------------------------------
  update public.payments
     set refunds = '[{"id":"e0","request_id":"r0","processor_ref":"re_0","amount_cents":1},
                     {"id":"e1","request_id":"r1","processor_ref":null,"amount_cents":1}]'::jsonb
   where id = cash;
  if not public.set_payment_refund_ref(cash, 'r1', 're_1') then raise exception 'ref not set'; end if;
  if public.set_payment_refund_ref(cash, 'r1', 're_other') then raise exception 'ref overwritten'; end if;
  if public.set_payment_refund_ref(cash, 'r0', 're_other') then raise exception 'existing ref overwritten'; end if;
  if (select refunds -> 1 ->> 'processor_ref' from public.payments where id = cash) <> 're_1'
     or (select refunds -> 0 ->> 'processor_ref' from public.payments where id = cash) <> 're_0'
     or (select jsonb_array_length(refunds) from public.payments where id = cash) <> 2 then
    raise exception 'refunds after ref fill: %', (select refunds from public.payments where id = cash);
  end if;

  -- ---- release sweep target set ---------------------------------------------------
  select count(*) into n from public.sv_unreleased_orders(100) where order_id = food;
  if n <> 0 then raise exception 'a live order listed as unreleased'; end if;
  update public.orders set status = 'abandoned' where id = food;
  select count(*) into n from public.sv_unreleased_orders(100) where order_id = food;
  if n <> 1 then raise exception 'abandoned order holding a gift card tender not listed'; end if;
  update public.payments set refunded_cents = amount_cents, status = 'refunded' where id = p1;
  select count(*) into n from public.sv_unreleased_orders(100) where order_id = food;
  if n <> 0 then raise exception 'a released order still listed'; end if;

  -- ---- append-only + sign rules --------------------------------------------------
  begin
    update public.stored_value_ledger set amount_cents = 1 where account_id = acct;
    raise exception 'ledger update allowed';
  exception when raise_exception then
    if sqlerrm not like '%append-only%' then raise; end if;
  end;
  begin
    delete from public.stored_value_ledger where account_id = acct;
    raise exception 'ledger delete allowed';
  exception when raise_exception then
    if sqlerrm not like '%append-only%' then raise; end if;
  end;
  begin
    insert into public.stored_value_ledger (account_id, tenant_id, kind, amount_cents, balance_after_cents, idempotency_key)
    values (acct, t, 'redeem', 500, 0, 'bad-sign');
    raise exception 'positive redeem accepted';
  exception when check_violation then null;
  end;
end
$$;

rollback;
