-- ============================================================================
-- Owner report checks for 20261113001010: refunds dated by when they happened,
-- the recorded tip part, pending reservations ignored, comps from
-- orders.adjustments. Rolled back at the end.
-- ============================================================================
begin;

do $$
declare
  t uuid := '10000000-0000-0000-0000-000000000001';
  loc uuid := '10000000-0000-0000-0000-000000000101';
  item uuid := '30000000-0000-0000-0000-000000000001';
  o1 uuid := gen_random_uuid();
  p1 uuid := gen_random_uuid();
  r jsonb;
  d jsonb;
begin
  update public.locations set timezone = 'America/New_York', business_day_cutoff_minutes = 0 where id = loc;

  -- May 1: a $20 pizza + $1.65 tax, $3 tip on the card; $2 comp.
  insert into public.orders (id, tenant_id, location_id, status, channel, currency, totals, order_number, created_at, adjustments) values
   (o1, t, loc, 'completed', 'in_store', 'USD',
    '{"subtotal_cents":2200,"discount_cents":200,"taxable_cents":2000,"tax_cents":165,"tip_cents":0,"total_cents":2165}',
    'RR1', '2026-05-01T16:00:00Z',
    '[{"id":"c1","type":"comp","source":"pos.manual","label":"Comp","amount_cents":200,"line_ids":null}]');
  insert into public.order_items (id, order_id, item_id, item_name, quantity, unit_price_cents, line_total_cents) values
   (gen_random_uuid(), o1, item, 'Margherita', 1, 2200, 2200);
  -- Refunds: May 3 food 500 (tip 0) and tip 100; a pending 300 (not a refund yet).
  insert into public.payments (id, order_id, tenant_id, location_id, rail, status, amount_cents, tip_cents,
                               refunded_cents, tip_refunded_cents, refund_reserved_cents, refunds, refund_ids, simulated) values
   (p1, o1, t, loc, 'stripe_terminal', 'captured', 2165, 300, 600, 100, 300,
    jsonb_build_array(
      jsonb_build_object('id','e1','amount_cents',500,'tip_cents',0,'at','2026-05-03T15:00:00Z','request_id','x1','state','succeeded'),
      jsonb_build_object('id','e2','amount_cents',100,'tip_cents',100,'at','2026-05-03T16:00:00Z','request_id','x2','state','succeeded'),
      jsonb_build_object('id','e3','amount_cents',300,'tip_cents',0,'at','2026-05-03T17:00:00Z','request_id','x3','state','pending')),
    array['x1','x2','x3'], false);

  -- May 1: the sale and the comp, no refund.
  r := public.report_sales_bundle(t, loc, '2026-05-01', '2026-05-01', 50);
  d := r -> 'daily' -> 0;
  if (d ->> 'orders')::int <> 1 or (d ->> 'refund_cents')::int <> 0 or (d ->> 'comp_cents')::int <> 200
     or (d ->> 'comp_count')::int <> 1 or (d ->> 'tip_cents')::int <> 300 or (d ->> 'discount_cents')::int <> 200 then
    raise exception 'May 1 day %', d;
  end if;

  -- May 3: no sale, the refunds (600, pending excluded), tip part exactly 100.
  r := public.report_sales_bundle(t, loc, '2026-05-03', '2026-05-03', 50);
  d := r -> 'daily' -> 0;
  if d is null or (d ->> 'orders')::int <> 0 or (d ->> 'refund_cents')::int <> 600
     or (d ->> 'refund_tip_cents')::int <> 100 or (d ->> 'tip_cents')::int <> -100
     or (d ->> 'refund_sales_cents')::int + (d ->> 'refund_tax_cents')::int + (d ->> 'refund_fees_cents')::int <> 500 then
    raise exception 'May 3 day %', d;
  end if;
  if (r -> 'tenders' -> 0 ->> 'refunded_cents')::int <> 600 or (r -> 'tenders' -> 0 ->> 'amount_cents')::int <> 0 then
    raise exception 'May 3 tenders %', r -> 'tenders';
  end if;
  if (r -> 'channels' -> 0 ->> 'refund_cents')::int <> 600 or (r -> 'staff' -> 0 ->> 'refund_cents')::int <> 600 then
    raise exception 'May 3 channels/staff % %', r -> 'channels', r -> 'staff';
  end if;

  -- The whole range: one order, its refunds, net = gross - discount - refunded sales.
  r := public.report_sales_bundle(t, loc, '2026-05-01', '2026-05-03', 50);
  if (select sum((x ->> 'refund_cents')::int) from jsonb_array_elements(r -> 'daily') x) <> 600
     or (select sum((x ->> 'orders')::int) from jsonb_array_elements(r -> 'daily') x) <> 1 then
    raise exception 'range %', r -> 'daily';
  end if;

  -- An unrecorded older remainder keeps the order's day.
  update public.payments set refunded_cents = 700, tip_refunded_cents = 100 where id = p1;
  r := public.report_sales_bundle(t, loc, '2026-05-01', '2026-05-01', 50);
  if (r -> 'daily' -> 0 ->> 'refund_cents')::int <> 100 then
    raise exception 'remainder day %', r -> 'daily';
  end if;
end
$$;

rollback;
