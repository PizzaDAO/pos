-- ============================================================================
-- Migration: owner_reports_stored_value
--
-- report_sales_bundle (20261113000600, already applied) learns about gift cards
-- and store credit (20261113000910):
--   * gift card SALE / RELOAD orders (orders.core_ext ? 'stored_value') are a
--     liability, not revenue: excluded from orders, gross, fees, tax, tenders,
--     channels, hourly, items and staff;
--   * gift_card / store_credit tenders get their own daily columns
--     (gift_card_cents, store_credit_cents) instead of falling into `other`
--     (the tender list already keys them by rail);
--   * a `stored_value` section: sold (count, money, refunded), redeemed (gift
--     card / store credit on sales in range, NET of value refunded back to the
--     cards) and the current outstanding liability.
-- Mirrored in src/lib/owner-reports.ts. Same signature: create or replace only.
-- Needs 20261113000910 (stored_value_accounts) first.
-- ============================================================================

begin;
set local lock_timeout = '3s';

create or replace function public.report_sales_bundle(
  p_tenant_id uuid,
  p_location_id uuid,
  p_from date,
  p_to date,
  p_top_n integer default 50
)
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
with
params as (
  select least(greatest(coalesce(p_top_n, 50), 1), 200) as top_n
),
-- Locations of this tenant; an unknown timezone reads as UTC.
locs as (
  select l.id, l.name, l.business_day_cutoff_minutes as cutoff,
         coalesce((select z.name from pg_timezone_names z
                    where lower(z.name) = lower(l.timezone) limit 1), 'UTC') as tz
  from public.locations l
  where l.tenant_id = p_tenant_id
),
-- Two branches so a single-location report can use orders_created_at_idx
-- (tenant_id, location_id, created_at); the other branch is pruned at run time.
ord_raw as (
  select ord.* from public.orders ord
  where p_location_id is not null
    and ord.tenant_id = p_tenant_id and ord.location_id = p_location_id
    -- coarse index-friendly window; the exact business-day filter is below
    and ord.created_at >= (p_from::timestamp at time zone 'UTC') - interval '2 days'
    and ord.created_at <  (p_to::timestamp at time zone 'UTC') + interval '4 days'
  union all
  select ord.* from public.orders ord
  where p_location_id is null
    and ord.tenant_id = p_tenant_id
    and ord.created_at >= (p_from::timestamp at time zone 'UTC') - interval '2 days'
    and ord.created_at <  (p_to::timestamp at time zone 'UTC') + interval '4 days'
),
-- One row per order in range, bucketed by its own location's business day.
o as (
  select
    ord.id,
    ord.location_id,
    l.name as location_name,
    ord.status::text as status,
    ord.staff_id,
    ((ord.created_at at time zone l.tz)
       - make_interval(mins => l.cutoff))::date as bd,
    extract(hour from (ord.created_at at time zone l.tz))::int as hr,
    case
      when ord.source ->> 'channel' in ('kiosk', 'catering', 'marketplace', 'phone', 'agent')
        then ord.source ->> 'channel'
      when ord.channel::text = 'online_delivery' then 'delivery'
      when ord.channel::text = 'online_pickup' then 'online'
      else 'terminal'
    end as channel,
    (ord.status::text not in ('draft', 'awaiting_payment', 'abandoned', 'voided')) as is_sale,
    (ord.status::text = 'voided') as is_void,
    -- A gift card sale / reload order: a liability, never a sale (src/lib/giftcards).
    coalesce(ord.core_ext ? 'stored_value', false) as is_sv,
    public.report_cents(ord.totals -> 'discount_cents') as discount,
    public.report_cents(ord.totals -> 'tax_cents') as tax,
    public.report_cents(ord.totals -> 'tip_cents') as order_tip,
    public.report_cents(ord.totals -> 'total_cents') as total
  from ord_raw ord
  join locs l on l.id = ord.location_id
),
ob as (select * from o where bd between p_from and p_to and (is_sale or is_void) and not is_sv),
-- Money per order: lines + tenders.
f0 as (
  select
    ob.*,
    coalesce(li.gross, 0) as gross,
    greatest(0, ob.total - ob.order_tip - ob.tax - (coalesce(li.gross, 0) - ob.discount)) as fees,
    coalesce(li.voided_lines, 0) as voided_lines,
    coalesce(pay.refunded, 0) as refunded,
    coalesce(pay.amt, 0) as amt,
    coalesce(pay.tip_ref_raw, 0) as tip_ref_raw,
    case when ob.order_tip > 0 then ob.order_tip else coalesce(pay.tip, 0) end as tip,
    coalesce(pay.cash, 0) as t_cash,
    coalesce(pay.card, 0) as t_card,
    coalesce(pay.crypto, 0) as t_crypto,
    coalesce(pay.gift_card, 0) as t_gift_card,
    coalesce(pay.store_credit, 0) as t_store_credit,
    coalesce(pay.other, 0) as t_other
  from ob
  left join lateral (
    select
      sum(oi.unit_price_cents::bigint * oi.quantity) filter (where not oi.voided) as gross,
      count(*) filter (where oi.voided) as voided_lines
    from public.order_items oi
    where oi.order_id = ob.id
  ) li on true
  left join lateral (
    select
      sum(p.refunded_cents) as refunded,
      sum(p.amount_cents) as amt,
      -- per tender: only the part of a refund beyond that tender's own non-tip amount is tip
      sum(greatest(p.refunded_cents - p.amount_cents, 0)) as tip_ref_raw,
      sum(p.tip_cents) as tip,
      sum(p.amount_cents) filter (where p.rail::text = 'cash' or (p.rail::text = 'external' and p.method = 'cash')) as cash,
      sum(p.amount_cents) filter (where p.rail::text in ('stripe_terminal', 'stripe_online') or (p.rail::text = 'external' and p.method = 'card')) as card,
      sum(p.amount_cents) filter (where p.rail::text like 'crypto%' or (p.rail::text = 'external' and p.method = 'crypto')) as crypto,
      sum(p.amount_cents) filter (where p.rail::text = 'gift_card') as gift_card,
      sum(p.amount_cents) filter (where p.rail::text = 'store_credit') as store_credit,
      sum(p.amount_cents) filter (where not (
            p.rail::text in ('cash', 'stripe_terminal', 'stripe_online', 'gift_card', 'store_credit')
         or p.rail::text like 'crypto%'
         or (p.rail::text = 'external' and coalesce(p.method, '') in ('cash', 'card', 'crypto')))) as other
    from public.payments p
    where p.order_id = ob.id and p.tenant_id = p_tenant_id
      and p.status::text in ('captured', 'refunded')
  ) pay on true
),
-- Split each order's refunds, tip last PER TENDER (see header). Refunded sales
-- are capped at gross - discount; any overflow goes to the tip part, so
-- refunded = ref_sales + ref_tax + ref_fees + ref_tip always holds.
f as (
  select f0.*,
         (r1.ref_tip + r4.overflow)::bigint as ref_tip_c,
         r3.ref_tax as ref_tax_c, r3.ref_fees as ref_fees_c, r4.sales as ref_sales_c
  from f0
  cross join lateral (
    select least(f0.tip_ref_raw, f0.tip)::bigint as ref_tip,
           (f0.refunded - least(f0.tip_ref_raw, f0.tip))::bigint as rest
  ) r1
  cross join lateral (
    select greatest(f0.gross - f0.discount, 0) + f0.tax + f0.fees as base
  ) r2
  cross join lateral (
    select least(f0.tax, coalesce(round(r1.rest * f0.tax::numeric / nullif(r2.base, 0)), 0))::bigint as ref_tax,
           least(f0.fees, coalesce(round(r1.rest * f0.fees::numeric / nullif(r2.base, 0)), 0))::bigint as ref_fees
  ) r3
  cross join lateral (
    select least(r1.rest - r3.ref_tax - r3.ref_fees, greatest(f0.gross - f0.discount, 0))::bigint as sales,
           (r1.rest - r3.ref_tax - r3.ref_fees
             - least(r1.rest - r3.ref_tax - r3.ref_fees, greatest(f0.gross - f0.discount, 0)))::bigint as overflow
  ) r4
),
sales as (select * from f where is_sale),
daily as (
  select
    location_id, location_name, bd as business_date,
    count(*) filter (where is_sale) as orders,
    coalesce(sum(gross) filter (where is_sale), 0) as gross_cents,
    coalesce(sum(discount) filter (where is_sale), 0) as discount_cents,
    coalesce(sum(refunded) filter (where is_sale), 0) as refund_cents,
    coalesce(sum(ref_sales_c) filter (where is_sale), 0) as refund_sales_cents,
    coalesce(sum(ref_tax_c) filter (where is_sale), 0) as refund_tax_cents,
    coalesce(sum(ref_fees_c) filter (where is_sale), 0) as refund_fees_cents,
    coalesce(sum(fees - ref_fees_c) filter (where is_sale), 0) as fees_cents,
    coalesce(sum(ref_tip_c) filter (where is_sale), 0) as refund_tip_cents,
    coalesce(sum(tax - ref_tax_c) filter (where is_sale), 0) as tax_cents,
    coalesce(sum(tip - ref_tip_c) filter (where is_sale), 0) as tip_cents,
    count(*) filter (where is_void) as void_count,
    coalesce(sum(total) filter (where is_void), 0) as void_cents,
    coalesce(sum(t_cash) filter (where is_sale), 0) as cash_cents,
    coalesce(sum(t_card) filter (where is_sale), 0) as card_cents,
    coalesce(sum(t_crypto) filter (where is_sale), 0) as crypto_cents,
    coalesce(sum(t_gift_card) filter (where is_sale), 0) as gift_card_cents,
    coalesce(sum(t_store_credit) filter (where is_sale), 0) as store_credit_cents,
    coalesce(sum(t_other) filter (where is_sale), 0) as other_cents
  from f
  group by location_id, location_name, bd
),
channels as (
  select channel, count(*) as orders,
         sum(gross) as gross_cents, sum(discount) as discount_cents, sum(refunded) as refund_cents,
         sum(ref_sales_c) as refund_sales_cents, sum(ref_fees_c) as refund_fees_cents,
         sum(fees - ref_fees_c) as fees_cents
  from sales group by channel
),
tenders as (
  select
    case when p.rail::text = 'external'
      then 'external:' || coalesce(nullif(regexp_replace(p.method, '[:\s]', '_', 'g'), ''), 'other')
           || ':' || coalesce(regexp_replace(p.processor, '[:\s]', '_', 'g'), '')
      else p.rail::text end as key,
    count(*) as count,
    sum(p.amount_cents) as amount_cents,
    sum(p.tip_cents) as tip_cents,
    sum(p.refunded_cents) as refunded_cents
  from sales s
  join public.payments p on p.order_id = s.id and p.tenant_id = p_tenant_id
  where p.status::text in ('captured', 'refunded')
  group by 1
),
-- Gift card sales / reloads in range (business-day bucketed like sales).
sv_sold as (
  select count(distinct o.id) as sold_count,
         coalesce(sum(p.amount_cents), 0) as sold_cents,
         coalesce(sum(least(p.refunded_cents, p.amount_cents + p.tip_cents)), 0) as sold_refunded_cents
  from o
  join public.payments p on p.order_id = o.id and p.tenant_id = p_tenant_id
  where o.is_sv and o.is_sale and o.bd between p_from and p_to
    and p.status::text in ('captured', 'refunded')
),
hourly as (
  -- weekday of the BUSINESS day (a 01:00 Saturday sale on a 04:00 cutoff is Friday)
  select extract(dow from bd)::int as dow, hr as hour,
         count(*) as orders, sum(gross - discount) as sales_cents
  from sales group by 1, 2
),
lines as (
  select oi.item_id, oi.item_name, oi.quantity,
         oi.unit_price_cents::bigint * oi.quantity as revenue,
         mc.id as category_id, mc.name as category_name
  from sales s
  join public.order_items oi on oi.order_id = s.id and not oi.voided
  left join public.menu_items mi on mi.id = oi.item_id and mi.tenant_id = p_tenant_id
  left join public.menu_categories mc on mc.id = mi.category_id and mc.tenant_id = p_tenant_id
),
items as (
  select item_id, max(item_name) as name, max(category_name) as category,
         sum(quantity) as qty, sum(revenue) as revenue_cents
  from lines group by item_id
  order by sum(revenue) desc, max(item_name)
  limit (select top_n from params)
),
cats as (
  select coalesce(category_id::text, 'uncategorized') as key,
         coalesce(max(category_name), 'Uncategorized') as name,
         sum(quantity) as qty, sum(revenue) as revenue_cents
  from lines group by 1
  order by sum(revenue) desc
  limit 200
),
staff_rows as (
  select f.staff_id, coalesce(max(st.name), 'Unattributed') as name,
         count(*) filter (where f.is_sale) as orders,
         coalesce(sum(f.gross - f.discount - f.ref_sales_c) filter (where f.is_sale), 0) as sales_cents,
         coalesce(sum(f.tip - f.ref_tip_c) filter (where f.is_sale), 0) as tip_cents,
         coalesce(sum(f.refunded) filter (where f.is_sale), 0) as refund_cents,
         count(*) filter (where f.is_void) + coalesce(sum(f.voided_lines) filter (where f.is_sale), 0) as void_count
  from f
  left join public.staff st on st.id = f.staff_id and st.tenant_id = p_tenant_id
  group by f.staff_id
  order by 4 desc
  limit 200
)
select jsonb_build_object(
  'daily',    coalesce((select jsonb_agg(to_jsonb(d) order by d.business_date, d.location_name) from daily d), '[]'::jsonb),
  'channels', coalesce((select jsonb_agg(to_jsonb(c) order by c.gross_cents desc) from channels c), '[]'::jsonb),
  'tenders',  coalesce((select jsonb_agg(to_jsonb(t) order by t.amount_cents desc) from tenders t), '[]'::jsonb),
  'hourly',   coalesce((select jsonb_agg(to_jsonb(h) order by h.dow, h.hour) from hourly h), '[]'::jsonb),
  'items',    coalesce((select jsonb_agg(to_jsonb(i) order by i.revenue_cents desc, i.name) from items i), '[]'::jsonb),
  'categories', coalesce((select jsonb_agg(to_jsonb(c) order by c.revenue_cents desc) from cats c), '[]'::jsonb),
  'item_total_cents', coalesce((select sum(revenue) from lines), 0),
  'staff',    coalesce((select jsonb_agg(to_jsonb(s) order by s.sales_cents desc) from staff_rows s), '[]'::jsonb),
  'stored_value', (select jsonb_build_object(
      'sold_count', sv.sold_count,
      'sold_cents', sv.sold_cents,
      'sold_refunded_cents', sv.sold_refunded_cents,
      -- Net of value returned to the cards (refunds of those tenders).
      'redeemed_gift_card_cents', coalesce((
        select sum(p.amount_cents - least(p.refunded_cents, p.amount_cents))
          from sales sl join public.payments p on p.order_id = sl.id and p.tenant_id = p_tenant_id
         where p.rail::text = 'gift_card' and p.status::text in ('captured', 'refunded')), 0),
      'redeemed_store_credit_cents', coalesce((
        select sum(p.amount_cents - least(p.refunded_cents, p.amount_cents))
          from sales sl join public.payments p on p.order_id = sl.id and p.tenant_id = p_tenant_id
         where p.rail::text = 'store_credit' and p.status::text in ('captured', 'refunded')), 0),
      -- Current (not range-bound) liability across the tenant.
      'outstanding_cents', coalesce((select sum(a.balance_cents) from public.stored_value_accounts a
                                      where a.tenant_id = p_tenant_id and a.status = 'active'), 0))
    from sv_sold sv)
)
$$;

revoke all on function public.report_sales_bundle(uuid, uuid, date, date, integer) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.report_sales_bundle(uuid, uuid, date, date, integer) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.report_sales_bundle(uuid, uuid, date, date, integer) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.report_sales_bundle(uuid, uuid, date, date, integer) to service_role;
  end if;
end
$$;

commit;
