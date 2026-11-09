-- ============================================================================
-- Checks for 20261114000500_money_followups (run by scripts/pglite-migrate.mjs
-- after the migrations + seed): a part-refunded sale never activates its card
-- for the full amount, and finish_order_adjustment can keep a live claim.
-- Raises on the first failed expectation; rolled back at the end.
-- ============================================================================
begin;

do $$
declare
  t uuid := '10000000-0000-0000-0000-000000000001';
  loc uuid;
  sale uuid := gen_random_uuid();
  acct uuid := gen_random_uuid();
  pa uuid := gen_random_uuid();
  pb uuid := gen_random_uuid();
  o1 uuid := gen_random_uuid();
  r jsonb;
  v_until timestamptz := now() + interval '2 minutes';
  v_claim timestamptz;
  pc uuid := gen_random_uuid();
  ok boolean;
begin
  select id into loc from public.locations where tenant_id = t limit 1;

  -- ---- a $50 sale: A $30 (then $10 of it refunded) + B $20 --------------------
  insert into public.orders (id, tenant_id, location_id, status, currency, totals, order_number, core_ext)
  values (sale, t, loc, 'draft', 'USD',
          '{"subtotal_cents":0,"discount_cents":0,"taxable_cents":0,"tax_cents":0,"tip_cents":0,"total_cents":5000}'::jsonb,
          'MF-1', jsonb_build_object('stored_value', jsonb_build_object('op','sell','account_id',acct,'amount_cents',5000,'code_last4','WXYZ')));
  insert into public.stored_value_accounts (id, tenant_id, kind, status, currency, code_hash, code_last4, source)
  values (acct, t, 'gift_card', 'pending', 'USD', 'hash-mf-1', 'WXYZ', 'till');
  insert into public.payments (id, order_id, tenant_id, location_id, rail, status, amount_cents, tip_cents, currency, simulated)
  values (pa, sale, t, loc, 'cash', 'captured', 3000, 0, 'USD', false),
         (pb, sale, t, loc, 'cash', 'captured', 2000, 0, 'USD', false);
  r := public.reserve_payment_refund(pa, 1000, 'mf-part-back', null, null, 0, false, false);
  if (r ->> 'outcome') <> 'ok' then raise exception 'part refund refused: %', r; end if;

  if public.sv_order_settled_cents((select o from public.orders o where id = sale)) <> 4000 then
    raise exception 'settled net: %', public.sv_order_settled_cents((select o from public.orders o where id = sale));
  end if;
  -- What the order owes is not netted (sv_order_sum unchanged).
  if public.sv_order_sum((select o from public.orders o where id = sale), array['captured', 'authorized']) <> 5000 then
    raise exception 'sv_order_sum changed';
  end if;
  r := public.sv_credit(t, acct, loc, 'issue', 5000, 'sale:' || sale, sale, null, null, null, null, true, sale, 100000);
  if r ->> 'outcome' <> 'not_settled' then raise exception 'part-refunded sale activated: %', r; end if;
  if (select status from public.stored_value_accounts where id = acct) <> 'pending' then
    raise exception 'card activated';
  end if;

  -- Another $10 tender: 2000 + 2000 + 1000 = 5000 held, but a PENDING refund
  -- reservation on B (held room, not yet refunded) also stops counting.
  insert into public.payments (id, order_id, tenant_id, location_id, rail, status, amount_cents, tip_cents, currency, simulated)
  values (gen_random_uuid(), sale, t, loc, 'cash', 'captured', 1000, 0, 'USD', false);
  update public.payments set refund_reserved_cents = 500 where id = pb;
  r := public.sv_credit(t, acct, loc, 'issue', 5000, 'sale:' || sale, sale, null, null, null, null, true, sale, 100000);
  if r ->> 'outcome' <> 'not_settled' then raise exception 'pending reservation counted as held: %', r; end if;
  update public.payments set refund_reserved_cents = 0 where id = pb;
  -- 5000 held: settles
  r := public.sv_credit(t, acct, loc, 'issue', 5000, 'sale:' || sale, sale, null, null, null, null, true, sale, 100000);
  if r ->> 'outcome' <> 'ok' or (r -> 'account' ->> 'status') <> 'active' then
    raise exception 'covered sale not activated: %', r;
  end if;

  -- ---- finish_order_adjustment keeps a live claim on request -------------------
  insert into public.orders (id, tenant_id, location_id, status, currency, totals, order_number)
  values (o1, t, loc, 'paid', 'USD', '{"subtotal_cents":1000,"discount_cents":0,"taxable_cents":1000,"tax_cents":0,"tip_cents":0,"total_cents":1000}'::jsonb, 'MF-2');
  r := public.begin_order_refund(jsonb_build_object(
    'id', 'mf-req-0001', 'order_id', o1, 'tenant_id', t, 'location_id', loc,
    'kind', 'refund', 'amount_cents', 500, 'tip_cents', 0, 'lines', '[]'::jsonb,
    'reason_code', 'quality', 'actor_user_id', 'u1'));
  if r ->> 'outcome' <> 'ok' then raise exception 'begin refused: %', r; end if;
  if not public.claim_order_adjustment(o1, 'mf-req-0001', v_until) then raise exception 'claim refused'; end if;

  r := public.finish_order_adjustment(o1, 'mf-req-0001', 'failed', '[]'::jsonb, '{"refund_failed":"re_x"}'::jsonb, true);
  select claimed_until into v_claim from public.order_adjustments where order_id = o1 and id = 'mf-req-0001';
  if r ->> 'status' <> 'failed' or v_claim is distinct from v_until then
    raise exception 'keep_claim lost the claim: % %', r, v_claim;
  end if;
  if public.claim_order_adjustment(o1, 'mf-req-0001', v_until) then
    raise exception 'second claim granted while held';
  end if;
  -- The 5-argument call (every existing caller) still releases it.
  r := public.finish_order_adjustment(o1, 'mf-req-0001', 'failed', '[]'::jsonb, null);
  select claimed_until into v_claim from public.order_adjustments where order_id = o1 and id = 'mf-req-0001';
  if v_claim is not null then raise exception 'claim not released'; end if;

  -- ---- compare-and-set release + the per-tender refund lock ------------------
  insert into public.payments (id, order_id, tenant_id, location_id, rail, status, amount_cents, tip_cents, currency, simulated)
  values (pc, o1, t, loc, 'stripe_terminal', 'captured', 1000, 0, 'USD', false);
  r := public.reserve_payment_refund(pc, 400, 'mf-card-0001', null, null, 0, true, true);
  if (r ->> 'outcome') <> 'ok' then raise exception 'pending reserve: %', r; end if;
  -- confirmed meanwhile: the CAS release refuses and changes nothing
  perform public.confirm_payment_refund(pc, 'mf-card-0001', 're_mf');
  ok := public.release_pending_payment_refund(pc, 'mf-card-0001', true);
  if ok then raise exception 'released a confirmed refund'; end if;
  if (select refunded_cents from public.payments where id = pc) <> 400 then
    raise exception 'confirmed refund undone';
  end if;
  -- still pending: released (tombstoned)
  r := public.reserve_payment_refund(pc, 300, 'mf-card-0002', null, null, 0, true, true);
  ok := public.release_pending_payment_refund(pc, 'mf-card-0002', true);
  if not ok then raise exception 'pending refund not released'; end if;
  if (select refund_reserved_cents from public.payments where id = pc) <> 0
     or not ('mf-card-0002' = any (select unnest(refund_ids) from public.payments where id = pc)) then
    raise exception 'release did not give the room back / tombstone';
  end if;
  if public.release_pending_payment_refund(pc, 'mf-card-0002', true) then
    raise exception 'released twice';
  end if;
  -- lock: exclusive between owners, re-entrant, released by its owner only
  if not public.take_payment_refund_lock(pc, 'resolver', now() + interval '1 minute') then
    raise exception 'lock refused';
  end if;
  if public.take_payment_refund_lock(pc, 'replay', now() + interval '1 minute') then
    raise exception 'lock taken twice';
  end if;
  if not public.take_payment_refund_lock(pc, 'resolver', now() + interval '1 minute') then
    raise exception 'lock not re-entrant';
  end if;
  perform public.release_payment_refund_lock(pc, 'replay');
  if public.take_payment_refund_lock(pc, 'replay', now() + interval '1 minute') then
    raise exception 'lock released by a non-owner';
  end if;
  perform public.release_payment_refund_lock(pc, 'resolver');
  if not public.take_payment_refund_lock(pc, 'replay', now() + interval '1 minute') then
    raise exception 'lock not released';
  end if;
  -- an expired lock is free
  update public.payments set refund_lock_until = now() - interval '1 second' where id = pc;
  if not public.take_payment_refund_lock(pc, 'resolver', now() + interval '1 minute') then
    raise exception 'expired lock still held';
  end if;
end
$$;

rollback;
