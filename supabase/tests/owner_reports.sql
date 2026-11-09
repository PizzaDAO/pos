-- ============================================================================
-- Owner report checks: report_sales_bundle business-day bucketing (DST + cutoff),
-- money math, voids, unpaid exclusion and tenant scoping. Run by
-- scripts/pglite-migrate.mjs after the migrations + seed; rolled back at end.
-- ============================================================================
begin;

do $$
declare
  t uuid := '10000000-0000-0000-0000-000000000001';
  loc uuid := '10000000-0000-0000-0000-000000000101';
  staff1 uuid := '80000000-0000-0000-0000-000000000003';
  item uuid := '30000000-0000-0000-0000-000000000001';
  oa uuid := gen_random_uuid();
  ob uuid := gen_random_uuid();
  oc uuid := gen_random_uuid();
  ov uuid := gen_random_uuid();
  ou uuid := gen_random_uuid();
  r jsonb;
  n int;
begin
  update public.locations set timezone = 'America/New_York', business_day_cutoff_minutes = 240 where id = loc;

  -- NY spring-forward day is 2026-03-08 (02:00 EST -> 03:00 EDT at 07:00Z).
  insert into public.orders (id, tenant_id, location_id, status, channel, currency, totals, order_number, staff_id, created_at, source) values
   (oa, t, loc, 'completed', 'in_store', 'USD', '{"discount_cents":100,"tax_cents":80,"tip_cents":0,"total_cents":1000}', 'R1', staff1, '2026-03-08T06:30:00Z', null),
   (ob, t, loc, 'completed', 'online_delivery', 'USD', '{"discount_cents":0,"tax_cents":160,"tip_cents":200,"total_cents":2360}', 'R2', null, '2026-03-08T08:00:00Z', null),
   (oc, t, loc, 'refunded', 'in_store', 'USD', '{"discount_cents":0,"tax_cents":40,"tip_cents":0,"total_cents":540}', 'R3', staff1, '2026-03-09T03:30:00Z', '{"type":"kiosk","channel":"kiosk"}'),
   (ov, t, loc, 'voided', 'in_store', 'USD', '{"total_cents":700}', 'R4', staff1, '2026-03-08T09:00:00Z', null),
   (ou, t, loc, 'awaiting_payment', 'online_pickup', 'USD', '{"total_cents":900}', 'R5', null, '2026-03-08T10:00:00Z', null);

  insert into public.order_items (id, order_id, item_id, item_name, quantity, unit_price_cents, line_total_cents) values
   (gen_random_uuid(), oa, item, 'Margherita', 1, 1100, 1100),
   (gen_random_uuid(), ob, item, 'Margherita', 2, 1000, 2000),
   (gen_random_uuid(), oc, item, 'Margherita', 1, 500, 500),
   (gen_random_uuid(), ov, item, 'Margherita', 1, 700, 700);
  insert into public.order_items (id, order_id, item_id, item_name, quantity, unit_price_cents, line_total_cents, voided) values
   (gen_random_uuid(), ob, item, 'Margherita', 1, 9999, 9999, true);

  insert into public.payments (id, order_id, tenant_id, location_id, rail, status, amount_cents, tip_cents, refunded_cents, simulated) values
   (gen_random_uuid(), oa, t, loc, 'cash', 'captured', 1080, 0, 0, false),
   (gen_random_uuid(), ob, t, loc, 'stripe_online', 'captured', 2160, 200, 0, false),
   (gen_random_uuid(), oc, t, loc, 'external', 'refunded', 540, 50, 540, false),
   (gen_random_uuid(), ou, t, loc, 'stripe_online', 'pending', 900, 0, 0, false);
  update public.payments set method = 'card', processor = 'kiosk_reader' where order_id = oc;

  -- ---- Mar 8 business day: B (04:00 EDT) and C (23:30 EDT on the 8th) -----
  r := public.report_sales_bundle(t, null, '2026-03-08', '2026-03-08', 50);
  select (d ->> 'orders')::int into n from jsonb_array_elements(r -> 'daily') d;
  if n <> 2 then raise exception 'Mar 8 orders expected 2, got %', n; end if;
  if (r -> 'daily' -> 0 ->> 'gross_cents')::int <> 2500 then raise exception 'gross %', r -> 'daily' -> 0; end if;  -- 2000 + 500, voided line excluded
  if (r -> 'daily' -> 0 ->> 'refund_cents')::int <> 540 then raise exception 'refund %', r -> 'daily' -> 0; end if;
  if (r -> 'daily' -> 0 ->> 'tip_cents')::int <> 250 then raise exception 'tips %', r -> 'daily' -> 0; end if;  -- 200 order-level + 50 tender
  if (r -> 'daily' -> 0 ->> 'tax_cents')::int <> 200 then raise exception 'tax %', r -> 'daily' -> 0; end if;
  if (r -> 'daily' -> 0 ->> 'void_count')::int <> 1 or (r -> 'daily' -> 0 ->> 'void_cents')::int <> 700 then
    raise exception 'voids %', r -> 'daily' -> 0;
  end if;
  if (r -> 'daily' -> 0 ->> 'card_cents')::int <> 2700 then raise exception 'card tender %', r -> 'daily' -> 0; end if;  -- online card + kiosk external card

  -- channels: delivery (B) and kiosk (C); unpaid pickup excluded
  if jsonb_array_length(r -> 'channels') <> 2 then raise exception 'channels %', r -> 'channels'; end if;
  if not exists (select 1 from jsonb_array_elements(r -> 'channels') c where c ->> 'channel' = 'kiosk') then
    raise exception 'kiosk channel missing: %', r -> 'channels';
  end if;

  -- hourly: B at hour 4 (EDT), C at hour 23
  if not exists (select 1 from jsonb_array_elements(r -> 'hourly') h where (h ->> 'hour')::int = 4 and (h ->> 'dow')::int = 0) then
    raise exception 'hourly %', r -> 'hourly';
  end if;
  if not exists (select 1 from jsonb_array_elements(r -> 'hourly') h where (h ->> 'hour')::int = 23) then
    raise exception 'hourly %', r -> 'hourly';
  end if;

  -- items / categories / staff
  if (r -> 'items' -> 0 ->> 'qty')::int <> 3 or (r -> 'items' -> 0 ->> 'revenue_cents')::int <> 2500 then
    raise exception 'items %', r -> 'items';
  end if;
  if r -> 'categories' -> 0 ->> 'name' <> 'Pizzas' then raise exception 'categories %', r -> 'categories'; end if;
  if (r ->> 'item_total_cents')::int <> 2500 then raise exception 'item total %', r ->> 'item_total_cents'; end if;
  if not exists (select 1 from jsonb_array_elements(r -> 'staff') s
                 where s ->> 'name' = 'Christopher M.' and (s ->> 'orders')::int = 1 and (s ->> 'void_count')::int = 1) then
    raise exception 'staff %', r -> 'staff';
  end if;

  -- ---- Mar 7 business day holds A (01:30 EST, before the 04:00 cutoff) ----
  r := public.report_sales_bundle(t, loc, '2026-03-07', '2026-03-07', 50);
  if (r -> 'daily' -> 0 ->> 'orders')::int <> 1 or (r -> 'daily' -> 0 ->> 'gross_cents')::int <> 1100 then
    raise exception 'Mar 7 %', r -> 'daily';
  end if;
  -- Mar 7 is a Saturday (dow 6); the sale is at local hour 1.
  if not exists (select 1 from jsonb_array_elements(r -> 'hourly') h where (h ->> 'hour')::int = 1 and (h ->> 'dow')::int = 6) then
    raise exception 'Mar 7 hourly %', r -> 'hourly';
  end if;

  -- ---- tenant scoping --------------------------------------------------------
  r := public.report_sales_bundle(gen_random_uuid(), null, '2026-03-01', '2026-03-31', 50);
  if jsonb_array_length(r -> 'daily') <> 0 then raise exception 'cross-tenant leak'; end if;

  -- ---- top_n limit -------------------------------------------------------------
  r := public.report_sales_bundle(t, null, '2026-03-01', '2026-03-31', 1);
  if jsonb_array_length(r -> 'items') <> 1 then raise exception 'top_n not applied'; end if;

  -- cutoff constraint
  begin
    update public.locations set business_day_cutoff_minutes = 2000 where id = loc;
    raise exception 'cutoff constraint did not fire';
  exception when check_violation then null;
  end;
end;
$$;

rollback;
