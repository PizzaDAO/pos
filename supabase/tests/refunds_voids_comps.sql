-- ============================================================================
-- Checks for 20261113000300_refunds_voids_comps (run by scripts/pglite-migrate.mjs
-- after the migrations + seed): the tip split in reserve/release, the item
-- refund quantity reservation, and apply_order_edit's compare-and-set + money
-- checks. Raises on the first failed expectation; rolled back at the end.
-- ============================================================================
begin;

do $$
declare
  t uuid := '10000000-0000-0000-0000-000000000001';
  loc uuid;
  o1 uuid := gen_random_uuid();   -- paid card order: refunds
  o2 uuid := gen_random_uuid();   -- unpaid order: voids / comps
  l1 uuid := gen_random_uuid();
  l2 uuid := gen_random_uuid();
  l3 uuid := gen_random_uuid();
  lnew uuid := gen_random_uuid();
  p1 uuid := gen_random_uuid();
  pc uuid := gen_random_uuid();
  out jsonb;
  pay public.payments;
  n int;
  v int;
begin
  perform public.core_set_outbox_enabled(true);
  select id into loc from public.locations where tenant_id = t limit 1;

  insert into public.orders (id, tenant_id, location_id, status, currency, totals, order_number, core_announced)
  values (o1, t, loc, 'paid', 'USD', '{"subtotal_cents":2000,"discount_cents":0,"taxable_cents":2000,"tax_cents":0,"tip_cents":0,"total_cents":2000}'::jsonb, 'RV-1', true),
         (o2, t, loc, 'placed', 'USD', '{"subtotal_cents":3000,"discount_cents":0,"taxable_cents":3000,"tax_cents":0,"tip_cents":0,"total_cents":3000}'::jsonb, 'RV-2', true);
  insert into public.order_items (id, order_id, item_id, item_name, quantity, unit_price_cents, line_total_cents, base_price_cents)
  values (l1, o1, gen_random_uuid(), 'Margherita', 2, 1000, 2000, 1000),
         (l2, o2, gen_random_uuid(), 'Pepperoni', 3, 1000, 3000, 1000);
  insert into public.payments (id, order_id, tenant_id, location_id, rail, status, amount_cents, tip_cents, currency, simulated)
  values (p1, o1, t, loc, 'stripe_terminal', 'captured', 2000, 400, 'USD', true);

  -- ---- tip split ---------------------------------------------------------------
  delete from public.core_outbox where event_type like 'tip.%';
  out := public.reserve_payment_refund(p1, 500, 'r-base-1', 're_1', 'quality', 0);
  if out ->> 'outcome' <> 'ok' then raise exception 'base refund refused: %', out; end if;
  select * into pay from public.payments where id = p1;
  if pay.refunded_cents <> 500 or pay.tip_refunded_cents <> 0 then
    raise exception 'base-only refund moved the tip (% / %)', pay.refunded_cents, pay.tip_refunded_cents;
  end if;
  select count(*) into n from public.core_outbox where event_type = 'tip.adjusted' and subject_id = p1;
  if n <> 0 then raise exception 'a food refund emitted a tip.adjusted (%)', n; end if;
  if (pay.refunds -> 0 ->> 'tip_cents')::int <> 0 then raise exception 'entry lacks tip_cents 0'; end if;

  out := public.reserve_payment_refund(p1, 150, 'r-tip-1', 're_2', 'tip', 150);
  if out ->> 'outcome' <> 'ok' then raise exception 'tip refund refused: %', out; end if;
  if not exists (select 1 from public.core_outbox where event_type = 'tip.adjusted'
                  and row_snapshot ->> 'fact_id' = 'tipadj_' || p1::text || '_c150') then
    raise exception 'tip refund did not emit tipadj c150';
  end if;

  -- caps: tip left 250, base left 1500
  out := public.reserve_payment_refund(p1, 300, 'r-tip-2', null, null, 300);
  if out ->> 'outcome' <> 'exceeds' then raise exception 'tip over-refund allowed: %', out; end if;
  out := public.reserve_payment_refund(p1, 1600, 'r-base-2', null, null, 0);
  if out ->> 'outcome' <> 'exceeds' then raise exception 'base over-refund allowed: %', out; end if;
  out := public.reserve_payment_refund(p1, 500, 'r-base-1', null, null, 0);
  if out ->> 'outcome' <> 'duplicate' then raise exception 'replay not duplicate: %', out; end if;

  -- release gives the tip part back
  perform public.release_payment_refund(p1, 150, 'r-tip-1');
  select * into pay from public.payments where id = p1;
  if pay.refunded_cents <> 500 or pay.tip_refunded_cents <> 0 then
    raise exception 'release kept the tip part (% / %)', pay.refunded_cents, pay.tip_refunded_cents;
  end if;

  -- legacy (no tip part): tip first
  out := public.reserve_payment_refund(p1, 600, 'r-legacy', null, null, null);
  select * into pay from public.payments where id = p1;
  if pay.tip_refunded_cents <> 400 or pay.refunded_cents <> 1100 then
    raise exception 'legacy split wrong (% / %)', pay.refunded_cents, pay.tip_refunded_cents;
  end if;

  -- full refund flips to refunded
  out := public.reserve_payment_refund(p1, 1300, 'r-rest', null, null, 0);
  select * into pay from public.payments where id = p1;
  if pay.status <> 'refunded' then raise exception 'not refunded after the rest: %', pay.status; end if;

  -- ---- item refund quantities --------------------------------------------------
  out := public.begin_order_refund(jsonb_build_object(
    'id', 'req-item-0001', 'order_id', o1, 'tenant_id', t, 'location_id', loc,
    'kind', 'refund', 'amount_cents', 1000, 'tip_cents', 0,
    'lines', jsonb_build_array(jsonb_build_object('line_id', l1, 'quantity', 1, 'amount_cents', 1000)),
    'reason_code', 'quality', 'actor_user_id', 'u1'));
  if out ->> 'outcome' <> 'ok' then raise exception 'item refund 1 refused: %', out; end if;
  out := public.begin_order_refund(jsonb_build_object(
    'id', 'req-item-0002', 'order_id', o1, 'tenant_id', t, 'location_id', loc,
    'kind', 'refund', 'amount_cents', 2000, 'tip_cents', 0,
    'lines', jsonb_build_array(jsonb_build_object('line_id', l1, 'quantity', 2, 'amount_cents', 2000)),
    'reason_code', 'quality', 'actor_user_id', 'u2'));
  if out ->> 'outcome' <> 'exceeds' or (out ->> 'available')::int <> 1 then
    raise exception 'second till refunded past the quantity: %', out;
  end if;
  out := public.begin_order_refund(jsonb_build_object(
    'id', 'req-item-0001', 'order_id', o1, 'tenant_id', t, 'location_id', loc,
    'kind', 'refund', 'amount_cents', 1000, 'lines', '[]'::jsonb,
    'reason_code', 'quality', 'actor_user_id', 'u1'));
  if out ->> 'outcome' <> 'duplicate' then raise exception 'retry not duplicate: %', out; end if;
  -- a failed refund gives its units back
  out := public.finish_order_adjustment(o1, 'req-item-0001', 'failed', '[]'::jsonb, '{"error":"x"}'::jsonb);
  if out ->> 'status' <> 'failed' then raise exception 'finish did not update: %', out; end if;
  out := public.begin_order_refund(jsonb_build_object(
    'id', 'req-item-0003', 'order_id', o1, 'tenant_id', t, 'location_id', loc,
    'kind', 'refund', 'amount_cents', 2000,
    'lines', jsonb_build_array(jsonb_build_object('line_id', l1, 'quantity', 2, 'amount_cents', 2000)),
    'reason_code', 'quality', 'actor_user_id', 'u2'));
  if out ->> 'outcome' <> 'ok' then raise exception 'units of a failed refund not released: %', out; end if;

  -- ---- apply_order_edit ----------------------------------------------------------
  select version into v from public.orders where id = o2;
  out := public.apply_order_edit(jsonb_build_object(
    'orderId', o2, 'tenantId', t, 'expectVersion', v - 1,
    'voidLineIds', '[]'::jsonb, 'splits', '[]'::jsonb,
    'totals', '{"total_cents":2000,"tip_cents":0}'::jsonb, 'discountCents', 0,
    'adjustments', '[]'::jsonb, 'voidOrder', false,
    'record', jsonb_build_object('id', 'edit-stale-01', 'order_id', o2, 'tenant_id', t,
      'location_id', loc, 'kind', 'void_line', 'reason_code', 'entry_error', 'actor_user_id', 'u1')));
  if out ->> 'outcome' <> 'stale' then raise exception 'stale version applied: %', out; end if;

  -- split: void 1 of 3
  out := public.apply_order_edit(jsonb_build_object(
    'orderId', o2, 'tenantId', t, 'expectVersion', v,
    'voidLineIds', '[]'::jsonb,
    'splits', jsonb_build_array(jsonb_build_object('line_id', l2, 'new_line_id', lnew,
      'keep_quantity', 2, 'void_quantity', 1)),
    'totals', '{"subtotal_cents":2000,"discount_cents":0,"taxable_cents":2000,"tax_cents":0,"tip_cents":0,"total_cents":2000}'::jsonb,
    'discountCents', 0, 'adjustments', '[]'::jsonb, 'voidOrder', false,
    'record', jsonb_build_object('id', 'edit-split-01', 'order_id', o2, 'tenant_id', t,
      'location_id', loc, 'kind', 'void_line', 'amount_cents', 1000,
      'reason_code', 'entry_error', 'actor_user_id', 'u1')));
  if out ->> 'outcome' <> 'ok' then raise exception 'split refused: %', out; end if;
  if (select quantity from public.order_items where id = l2) <> 2 then raise exception 'kept qty wrong'; end if;
  if not (select voided from public.order_items where id = lnew) then raise exception 'copy not voided'; end if;
  if (select fired_at from public.order_items where id = lnew) is distinct from
     (select fired_at from public.order_items where id = l2) then
    raise exception 'copy lost the fire time';
  end if;
  if (select (totals ->> 'total_cents')::int from public.orders where id = o2) <> 2000 then
    raise exception 'totals not written';
  end if;
  if (select version from public.orders where id = o2) <> v + 1 then raise exception 'version not bumped'; end if;
  -- replay of the same request id
  out := public.apply_order_edit(jsonb_build_object(
    'orderId', o2, 'tenantId', t, 'expectVersion', v + 1, 'voidOrder', false,
    'totals', '{"total_cents":2000,"tip_cents":0}'::jsonb,
    'record', jsonb_build_object('id', 'edit-split-01')));
  if out ->> 'outcome' <> 'duplicate' then raise exception 'edit replay not duplicate: %', out; end if;

  -- paid more than the new due -> refused
  insert into public.payments (id, order_id, tenant_id, location_id, rail, status, amount_cents, tip_cents, currency, simulated)
  values (pc, o2, t, loc, 'cash', 'captured', 1500, 0, 'USD', false);
  out := public.apply_order_edit(jsonb_build_object(
    'orderId', o2, 'tenantId', t, 'expectVersion', v + 1,
    'voidLineIds', '[]'::jsonb, 'splits', '[]'::jsonb,
    'totals', '{"total_cents":1000,"tip_cents":0}'::jsonb, 'discountCents', 1000,
    'adjustments', '[]'::jsonb, 'voidOrder', false,
    'record', jsonb_build_object('id', 'edit-disc-001', 'order_id', o2, 'tenant_id', t,
      'location_id', loc, 'kind', 'discount', 'amount_cents', 1000,
      'reason_code', 'promotion', 'actor_user_id', 'u1')));
  if out ->> 'outcome' <> 'invalid_state' or out ->> 'reason' <> 'paid_exceeds' then
    raise exception 'discount below the paid amount allowed: %', out;
  end if;
  -- void with captured money -> refused
  out := public.apply_order_edit(jsonb_build_object(
    'orderId', o2, 'tenantId', t, 'expectVersion', v + 1, 'voidOrder', true,
    'totals', '{"total_cents":2000,"tip_cents":0}'::jsonb,
    'record', jsonb_build_object('id', 'edit-void-001', 'order_id', o2, 'tenant_id', t,
      'location_id', loc, 'kind', 'void_order', 'reason_code', 'walkout', 'actor_user_id', 'u1')));
  if out ->> 'outcome' <> 'invalid_state' or out ->> 'reason' <> 'captured' then
    raise exception 'void with captured money allowed: %', out;
  end if;
  update public.payments set status = 'canceled' where id = pc;
  out := public.apply_order_edit(jsonb_build_object(
    'orderId', o2, 'tenantId', t, 'expectVersion', v + 1, 'voidOrder', true,
    'totals', '{"total_cents":2000,"tip_cents":0}'::jsonb, 'discountCents', 0,
    'record', jsonb_build_object('id', 'edit-void-002', 'order_id', o2, 'tenant_id', t,
      'location_id', loc, 'kind', 'void_order', 'amount_cents', 2000,
      'reason_code', 'walkout', 'actor_user_id', 'u1')));
  if out ->> 'outcome' <> 'ok' then raise exception 'unpaid void refused: %', out; end if;
  if (select status::text from public.orders where id = o2) <> 'voided' then raise exception 'not voided'; end if;
  if not exists (select 1 from public.core_outbox where subject_id = o2 and event_type = 'order.canceled') then
    raise exception 'order.canceled not emitted';
  end if;
  select count(*) into n from public.order_adjustments where order_id = o2;
  if n <> 2 then raise exception 'ledger rows: %', n; end if;
end
$$;

rollback;
