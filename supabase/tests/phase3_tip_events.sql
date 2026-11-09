-- ============================================================================
-- Phase 3 checks: tip.recorded / tip.adjusted from core_trg_payments and the
-- backfill in core_trg_orders (run by scripts/pglite-migrate.mjs after the
-- migrations + seed). Raises on the first failed expectation; rolled back at end.
-- ============================================================================
begin;

do $$
declare
  t uuid := '10000000-0000-0000-0000-000000000001';
  loc uuid;
  o1 uuid := gen_random_uuid();  -- tender tips
  o2 uuid := gen_random_uuid();  -- online order tip
  o3 uuid := gen_random_uuid();  -- shop checkout: paid before it is announced
  o4 uuid := gen_random_uuid();  -- held /v1 order (draft + hold)
  o5 uuid := gen_random_uuid();  -- malformed tip in totals
  o6 uuid := gen_random_uuid();  -- tip event path broken
  p1 uuid := gen_random_uuid();
  p1b uuid := gen_random_uuid();
  p2 uuid := gen_random_uuid();
  p2b uuid := gen_random_uuid();
  p3 uuid := gen_random_uuid();
  p3b uuid := gen_random_uuid();
  p4 uuid := gen_random_uuid();
  p5 uuid := gen_random_uuid();
  p6 uuid := gen_random_uuid();
  n int;
  f text;
begin
  perform public.core_set_outbox_enabled(true);
  select id into loc from public.locations where tenant_id = t limit 1;

  insert into public.orders (id, tenant_id, location_id, status, currency, totals, order_number, core_announced)
  values (o1, t, loc, 'placed', 'USD', '{"total_cents":3000,"tip_cents":0}'::jsonb, 'T3-1', true),
         (o2, t, loc, 'placed', 'USD', '{"total_cents":3000,"tip_cents":500}'::jsonb, 'T3-2', true),
         (o3, t, loc, 'awaiting_payment', 'USD', '{"total_cents":3000,"tip_cents":0}'::jsonb, 'T3-3', false),
         (o5, t, loc, 'placed', 'USD', '{"total_cents":3000,"tip_cents":12.5}'::jsonb, 'T3-5', true),
         (o6, t, loc, 'placed', 'USD', '{"total_cents":3000,"tip_cents":0}'::jsonb, 'T3-6', true);
  insert into public.orders (id, tenant_id, location_id, status, currency, totals, order_number, core_announced, hold)
  values (o4, t, loc, 'draft', 'USD', '{"total_cents":3000,"tip_cents":0}'::jsonb, 'T3-4', false,
          '{"reason":"payment","expires_at":"2099-01-01T00:00:00Z"}'::jsonb);

  delete from public.core_outbox where event_type like 'tip.%';

  -- ---- tender tip: recorded once on capture ------------------------------
  insert into public.payments (id, order_id, tenant_id, location_id, rail, status, amount_cents, tip_cents, currency, simulated)
  values (p1, o1, t, loc, 'cash', 'pending', 1000, 300, 'USD', false);
  select count(*) into n from public.core_outbox where event_type like 'tip.%';
  if n <> 0 then raise exception 'a pending tender emitted a tip event (%)', n; end if;

  update public.payments set status = 'captured' where id = p1;
  select count(*) into n from public.core_outbox where event_type = 'tip.recorded' and subject_id = p1;
  if n <> 1 then raise exception 'capture emitted % tip.recorded, expected 1', n; end if;
  select row_snapshot ->> 'fact_id' into f from public.core_outbox where event_type = 'tip.recorded' and subject_id = p1;
  if f <> 'tip_' || p1::text then raise exception 'fact id %', f; end if;

  -- replays: same-row update, re-capture, amount touch -> nothing new
  update public.payments set status = 'captured' where id = p1;
  update public.payments set updated_at = now() where id = p1;
  update public.payments set tip_cents = 300 where id = p1;
  select count(*) into n from public.core_outbox where event_type like 'tip.%' and subject_id = p1;
  if n <> 1 then raise exception 'replay re-emitted (% rows)', n; end if;

  insert into public.payments (id, order_id, tenant_id, location_id, rail, status, amount_cents, tip_cents, currency, simulated)
  values (p1b, o1, t, loc, 'cash', 'captured', 500, 100, 'USD', false);
  select count(*) into n from public.core_outbox where event_type = 'tip.recorded' and subject_id = p1b;
  if n <> 1 then raise exception 'INSERT as captured emitted % tip.recorded', n; end if;

  -- ---- a raw refund write: base first, only beyond the base is tip ----------
  update public.payments set refunded_cents = 800 where id = p1;           -- inside the base: no tip part
  update public.payments set refunded_cents = 1100 where id = p1;          -- base done + tip part 100
  update public.payments set refunded_cents = 1300 where id = p1;          -- cum 300
  select count(*) into n from public.core_outbox where event_type = 'tip.adjusted' and subject_id = p1;
  if n <> 2 then raise exception 'expected 2 tip.adjusted (c100, c300), got %', n; end if;
  if not exists (select 1 from public.core_outbox where event_type = 'tip.adjusted'
                  and row_snapshot ->> 'fact_id' = 'tipadj_' || p1::text || '_c100') then
    raise exception 'missing c100';
  end if;
  if not exists (select 1 from public.core_outbox where event_type = 'tip.adjusted'
                  and row_snapshot ->> 'fact_id' = 'tipadj_' || p1::text || '_c300') then
    raise exception 'missing c300';
  end if;
  update public.payments set refunded_cents = 550 where id = p1b;          -- base 500 + tip 50
  if not exists (select 1 from public.core_outbox where event_type = 'tip.adjusted'
                  and row_snapshot ->> 'fact_id' = 'tipadj_' || p1b::text || '_c50') then
    raise exception 'missing p1b c50';
  end if;

  -- ---- online order tip: first settled tender only ------------------------
  insert into public.payments (id, order_id, tenant_id, location_id, rail, status, amount_cents, tip_cents, currency, simulated)
  values (p2, o2, t, loc, 'cash', 'captured', 1000, 0, 'USD', false);
  select count(*) into n from public.core_outbox
   where event_type = 'tip.recorded' and row_snapshot ->> 'fact_id' = 'tip_online_' || o2::text;
  if n <> 1 then raise exception 'online fact emitted % times', n; end if;
  insert into public.payments (id, order_id, tenant_id, location_id, rail, status, amount_cents, tip_cents, currency, simulated)
  values (p2b, o2, t, loc, 'cash', 'captured', 1500, 0, 'USD', false);
  select count(*) into n from public.core_outbox
   where event_type = 'tip.recorded' and row_snapshot ->> 'fact_id' = 'tip_online_' || o2::text;
  if n <> 1 then raise exception 'online fact duplicated by a second tender (%)', n; end if;
  update public.payments set status = 'captured' where id = p2;   -- replay
  select count(*) into n from public.core_outbox where event_type like 'tip.%' and subject_id in (p2, p2b);
  if n <> 1 then raise exception 'replay changed the online count (%)', n; end if;
  -- partial refunds never touch an online tip; only a full reversal does, once
  update public.payments set refunded_cents = 1000, status = 'refunded' where id = p2;
  select count(*) into n from public.core_outbox where event_type = 'tip.adjusted' and subject_id in (p2, p2b);
  if n <> 0 then raise exception 'a partial reversal adjusted the online tip (%)', n; end if;
  update public.payments set refunded_cents = 1500, status = 'refunded' where id = p2b;
  select count(*) into n from public.core_outbox where event_type = 'tip.adjusted'
     and row_snapshot ->> 'fact_id' = 'tipadj_online_' || o2::text || '_full';
  if n <> 1 then raise exception 'expected one full online reversal, got %', n; end if;

  -- ---- shop checkout: paid while unannounced, announced at release -------
  insert into public.payments (id, order_id, tenant_id, location_id, rail, status, amount_cents, tip_cents, currency, simulated)
  values (p3, o3, t, loc, 'stripe_online', 'captured', 1000, 250, 'USD', false);
  select count(*) into n from public.core_outbox where subject_id = p3;
  if n <> 0 then raise exception 'un-announced order emitted % events', n; end if;
  update public.orders set status = 'paid' where id = o3;
  select count(*) into n from public.core_outbox where subject_id = p3 and event_type = 'tip.recorded'
     and row_snapshot ->> 'fact_id' = 'tip_' || p3::text;
  if n <> 1 then raise exception 'shop tip backfill emitted % times', n; end if;
  -- replays of the order write, and moving on, never re-emit
  update public.orders set status = 'paid' where id = o3;
  update public.orders set notes = 'again' where id = o3;
  update public.orders set status = 'in_kitchen' where id = o3;
  select count(*) into n from public.core_outbox where subject_id = p3 and event_type = 'tip.recorded';
  if n <> 1 then raise exception 'order replay re-emitted the tip (%)', n; end if;
  -- a later tender on the announced order goes through the payments trigger
  insert into public.payments (id, order_id, tenant_id, location_id, rail, status, amount_cents, tip_cents, currency, simulated)
  values (p3b, o3, t, loc, 'cash', 'captured', 100, 50, 'USD', false);
  select count(*) into n from public.core_outbox where subject_id = p3b and event_type = 'tip.recorded';
  if n <> 1 then raise exception 'late tender tip emitted % times', n; end if;

  -- ---- held /v1 order: payment.captured goes out, the tip waits for release
  insert into public.payments (id, order_id, tenant_id, location_id, rail, status, amount_cents, tip_cents, currency, simulated)
  values (p4, o4, t, loc, 'cash', 'captured', 1000, 200, 'USD', false);
  select count(*) into n from public.core_outbox where subject_id = p4 and event_type = 'payment.captured';
  if n <> 1 then raise exception 'held order payment.captured regressed: %', n; end if;
  select count(*) into n from public.core_outbox where subject_id = p4 and event_type like 'tip.%';
  if n <> 0 then raise exception 'held order announced its tip early (%)', n; end if;
  update public.orders set status = 'placed', hold = null where id = o4;
  select count(*) into n from public.core_outbox where subject_id = p4 and event_type = 'tip.recorded';
  if n <> 1 then raise exception 'release backfill emitted % tip.recorded', n; end if;

  -- ---- refunds that happened BEFORE the order was announced ---------------
  declare
    o7 uuid := gen_random_uuid();
    o8 uuid := gen_random_uuid();
    q1 uuid := gen_random_uuid();
    q2 uuid := gen_random_uuid();
  begin
    insert into public.orders (id, tenant_id, location_id, status, currency, totals, order_number, core_announced)
    values (o7, t, loc, 'awaiting_payment', 'USD', '{"total_cents":3000,"tip_cents":0}'::jsonb, 'T3-7', false),
           (o8, t, loc, 'awaiting_payment', 'USD', '{"total_cents":3000,"tip_cents":400}'::jsonb, 'T3-8', false);
    -- tipped tender: 120 recorded as an entry, 1080 more unrecorded (legacy remainder first)
    insert into public.payments (id, order_id, tenant_id, location_id, rail, status, amount_cents, tip_cents, currency, simulated, refunded_cents, refunds)
    values (q1, o7, t, loc, 'stripe_online', 'captured', 1000, 150, 'USD', false, 1200,
            '[{"id":"r1","amount_cents":120,"at":"2026-06-04T20:00:00Z"}]'::jsonb);
    -- online tip, fully refunded
    insert into public.payments (id, order_id, tenant_id, location_id, rail, status, amount_cents, tip_cents, currency, simulated, refunded_cents)
    values (q2, o8, t, loc, 'stripe_online', 'refunded', 1000, 0, 'USD', false, 1000);
    update public.orders set status = 'paid' where id in (o7, o8);
    -- remainder 1080 first (base 1000, tip cum 80), then the 120 entry (cum 150 = capped at the tip)
    if (select array_agg(row_snapshot ->> 'fact_id' order by sequence) from public.core_outbox
         where subject_id = q1 and event_type like 'tip.%')
       is distinct from array['tip_' || q1::text, 'tipadj_' || q1::text || '_c80', 'tipadj_' || q1::text || '_c150'] then
      raise exception 'backfill with refunds: %', (select array_agg(row_snapshot ->> 'fact_id' order by sequence) from public.core_outbox where subject_id = q1 and event_type like 'tip.%');
    end if;
    if (select array_agg(row_snapshot ->> 'fact_id' order by sequence) from public.core_outbox
         where subject_id = q2 and event_type like 'tip.%')
       is distinct from array['tip_online_' || o8::text, 'tipadj_online_' || o8::text || '_full'] then
      raise exception 'online backfill reversal: %', (select array_agg(row_snapshot ->> 'fact_id' order by sequence) from public.core_outbox where subject_id = q2 and event_type like 'tip.%');
    end if;
  end;

  -- ---- malformed numbers never fail a payment write ----------------------
  insert into public.payments (id, order_id, tenant_id, location_id, rail, status, amount_cents, tip_cents, currency, simulated)
  values (p5, o5, t, loc, 'cash', 'captured', 1000, 0, 'USD', false);      -- tip_cents 12.5
  update public.orders set totals = '{"total_cents":3000,"tip_cents":150.00}'::jsonb where id = o5;
  update public.payments set refunded_cents = 10 where id = p5;
  update public.orders set totals = '{"total_cents":3000,"tip_cents":"abc"}'::jsonb where id = o5;
  update public.payments set refunded_cents = 20 where id = p5;
  select count(*) into n from public.core_outbox where subject_id = p5 and event_type like 'tip.%';
  if n <> 0 then raise exception 'a non-integer order tip produced % tip events', n; end if;
  if (select status::text from public.payments where id = p5) <> 'captured' then raise exception 'payment write lost'; end if;

  -- ---- a broken tip path cannot fail the payment or the order -------------
  alter table public.core_outbox
    add constraint tmp_no_tip_rows check (event_type not like 'tip.%') not valid;
  insert into public.payments (id, order_id, tenant_id, location_id, rail, status, amount_cents, tip_cents, currency, simulated)
  values (p6, o6, t, loc, 'cash', 'captured', 1000, 100, 'USD', false);
  update public.payments set refunded_cents = 40 where id = p6;
  if (select refunded_cents from public.payments where id = p6) <> 40 then raise exception 'refund lost'; end if;
  select count(*) into n from public.core_outbox where subject_id = p6 and event_type = 'payment.captured';
  if n <> 1 then raise exception 'payment.captured lost with the tip path broken (%)', n; end if;
  select count(*) into n from public.core_outbox where subject_id = p6 and event_type like 'tip.%';
  if n <> 0 then raise exception 'tip rows survived the broken path'; end if;
  alter table public.core_outbox drop constraint tmp_no_tip_rows;

  -- sequences stay unique per tenant
  select count(*) - count(distinct sequence) into n from public.core_outbox where tenant_id = t;
  if n <> 0 then raise exception 'duplicate outbox sequence'; end if;
end
$$;

rollback;
