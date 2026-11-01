-- ============================================================================
-- Phase 3 checks: tip.recorded / tip.adjusted from core_trg_payments (run by
-- scripts/pglite-migrate.mjs after the migrations + seed). Raises on the first
-- failed expectation; everything is rolled back at the end.
-- ============================================================================
begin;

do $$
declare
  t uuid := '10000000-0000-0000-0000-000000000001';
  loc uuid;
  o1 uuid := gen_random_uuid();  -- tender tips
  o2 uuid := gen_random_uuid();  -- online order tip
  o3 uuid := gen_random_uuid();  -- not announced: suppressed
  o4 uuid := gen_random_uuid();  -- held /v1 order (draft + hold)
  p1 uuid := gen_random_uuid();
  p1b uuid := gen_random_uuid();
  p2 uuid := gen_random_uuid();
  p2b uuid := gen_random_uuid();
  p3 uuid := gen_random_uuid();
  p4 uuid := gen_random_uuid();
  n int;
  f text;
begin
  perform public.core_set_outbox_enabled(true);
  select id into loc from public.locations where tenant_id = t limit 1;

  insert into public.orders (id, tenant_id, location_id, status, currency, totals, order_number, core_announced)
  values (o1, t, loc, 'placed', 'USD', '{"total_cents":3000,"tip_cents":0}'::jsonb, 'T3-1', true),
         (o2, t, loc, 'placed', 'USD', '{"total_cents":3000,"tip_cents":500}'::jsonb, 'T3-2', true),
         (o3, t, loc, 'awaiting_payment', 'USD', '{"total_cents":3000,"tip_cents":500}'::jsonb, 'T3-3', false);
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

  -- a second tipped tender is its own fact
  insert into public.payments (id, order_id, tenant_id, location_id, rail, status, amount_cents, tip_cents, currency, simulated)
  values (p1b, o1, t, loc, 'cash', 'captured', 500, 100, 'USD', false);
  select count(*) into n from public.core_outbox where event_type = 'tip.recorded' and subject_id = p1b;
  if n <> 1 then raise exception 'INSERT as captured emitted % tip.recorded', n; end if;

  -- ---- refunds come off the tip first ------------------------------------
  update public.payments set refunded_cents = 100 where id = p1;           -- tip part 100
  update public.payments set refunded_cents = 300 where id = p1;           -- cum 300 (100 more.. total 300)
  update public.payments set refunded_cents = 800 where id = p1;           -- 500 into base: no tip part
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
  -- refunding base only (second tender: 100 tip, refund 50) is a tip part
  update public.payments set refunded_cents = 50 where id = p1b;
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
  -- a second tip-less tender does not emit another
  insert into public.payments (id, order_id, tenant_id, location_id, rail, status, amount_cents, tip_cents, currency, simulated)
  values (p2b, o2, t, loc, 'cash', 'captured', 1500, 0, 'USD', false);
  select count(*) into n from public.core_outbox
   where event_type = 'tip.recorded' and row_snapshot ->> 'fact_id' = 'tip_online_' || o2::text;
  if n <> 1 then raise exception 'online fact duplicated by a second tender (%)', n; end if;
  -- a replay of the first tender's capture
  update public.payments set status = 'captured' where id = p2;
  select count(*) into n from public.core_outbox where event_type like 'tip.%' and subject_id in (p2, p2b);
  if n <> 1 then raise exception 'replay changed the online count (%)', n; end if;
  -- refunds: base is 2500; only what is BEYOND the base hits the tip
  update public.payments set refunded_cents = 1000 where id = p2;   -- run 1000 < base
  update public.payments set refunded_cents = 1500 where id = p2b;  -- run 2500 = base: none
  select count(*) into n from public.core_outbox where event_type = 'tip.adjusted' and subject_id in (p2, p2b);
  if n <> 0 then raise exception 'refund within the base adjusted the online tip (%)', n; end if;
  update public.payments set refunded_cents = 1000, status = 'refunded' where id = p2b;   -- lower: no event
  update public.payments set refunded_cents = 1500 where id = p2b;
  update public.payments set refunded_cents = 1500, status = 'captured' where id = p2;     -- run 3000: 500 over
  select count(*) into n from public.core_outbox where event_type = 'tip.adjusted'
     and row_snapshot ->> 'fact_id' = 'tipadj_online_' || o2::text || '_c500';
  if n <> 1 then raise exception 'expected one online adjustment c500, got %', n; end if;

  -- ---- suppression --------------------------------------------------------
  insert into public.payments (id, order_id, tenant_id, location_id, rail, status, amount_cents, tip_cents, currency, simulated)
  values (p3, o3, t, loc, 'cash', 'captured', 1000, 200, 'USD', false);
  select count(*) into n from public.core_outbox where subject_id = p3;
  if n <> 0 then raise exception 'un-announced order emitted % events', n; end if;
  -- held /v1 order: payment (and its tip) goes out before the release
  insert into public.payments (id, order_id, tenant_id, location_id, rail, status, amount_cents, tip_cents, currency, simulated)
  values (p4, o4, t, loc, 'cash', 'captured', 1000, 200, 'USD', false);
  select count(*) into n from public.core_outbox where subject_id = p4 and event_type = 'tip.recorded';
  if n <> 1 then raise exception 'held order tip.recorded: %', n; end if;
  select count(*) into n from public.core_outbox where subject_id = p4 and event_type = 'payment.captured';
  if n <> 1 then raise exception 'held order payment.captured regressed: %', n; end if;

  -- sequences stay gap-free and unique per tenant
  select count(*) - count(distinct sequence) into n from public.core_outbox where tenant_id = t;
  if n <> 0 then raise exception 'duplicate outbox sequence'; end if;
end
$$;

rollback;
