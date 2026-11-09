-- ============================================================================
-- Migration: owner_reports_refunds
--
-- report_sales_bundle (from the 20261113000920 version; everything else,
-- including the stored_value section, is unchanged) learns about the till's
-- refunds, voids and comps (20261113001000):
--   * refunds are DATED BY WHEN THEY HAPPENED: each confirmed payments.refunds[]
--     entry lands on its own business day (location timezone + cutoff), so a
--     refund on Tuesday of Monday's order comes off Tuesday's columns; an
--     unrecorded older remainder keeps the order's day. Pending card / stored-
--     value reservations are not refunds yet.
--   * each refund's tip part is the one it recorded (refunds[].tip_cents, =
--     payments.tip_refunded_cents) instead of guessing; entries without one keep
--     the old tip-last-per-tender rule (what tip_refunded_cents was backfilled
--     with). The order's refunds are split cumulatively in time order with the
--     same rule as before (report_refund_split) and differenced, so the parts of
--     all refunds equal the order-level split: refund = sales + tax + fees + tip.
--   * comps come from orders.adjustments (type comp): new daily comp_cents /
--     comp_count (still part of discount_cents).
--   * channels, staff and tender refunded_cents follow the dated refunds.
-- Mirrored in src/lib/owner-reports.ts (refundEvents, splitParts).
-- DEPLOY ORDER: after 20261113001000. Same signature: create or replace only.
-- ============================================================================

begin;
set local lock_timeout = '3s';

-- The split rule of an order's (cumulative) refunds (see the header of
-- 20261113000600): the tip part capped at the tip; the rest pro-rata across
-- tax and fees (each capped), sales the remainder capped at what was sold; any
-- overflow is tip.
create or replace function public.report_refund_split(
  p_total bigint,
  p_tip_raw bigint,
  p_sales bigint,
  p_tax bigint,
  p_fees bigint,
  p_tip bigint,
  out ref_tip bigint,
  out ref_tax bigint,
  out ref_fees bigint,
  out ref_sales bigint
)
language sql
immutable
set search_path = public, pg_temp
as $$
  with a as (
    select least(p_tip_raw, p_tip) as tip0,
           p_total - least(p_tip_raw, p_tip) as rest,
           greatest(p_sales, 0) + p_tax + p_fees as base
  ),
  b as (
    select a.*,
           least(p_tax, coalesce(round(a.rest * p_tax::numeric / nullif(a.base, 0)), 0))::bigint as tx,
           least(p_fees, coalesce(round(a.rest * p_fees::numeric / nullif(a.base, 0)), 0))::bigint as fe
      from a
  )
  select (b.tip0 + (b.rest - b.tx - b.fe - least(b.rest - b.tx - b.fe, greatest(p_sales, 0))))::bigint,
         b.tx, b.fe,
         least(b.rest - b.tx - b.fe, greatest(p_sales, 0))::bigint
    from b
$$;

revoke all on function public.report_refund_split(bigint, bigint, bigint, bigint, bigint, bigint) from public;

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
    coalesce(pay.amt, 0) as amt,
    case when ob.order_tip > 0 then ob.order_tip else coalesce(pay.tip, 0) end as tip,
    -- Comps (orders.adjustments, type comp): part of the discount, shown apart.
    coalesce(cp.comp, 0) as comp,
    coalesce(cp.comp_n, 0) as comp_n,
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
      sum(p.amount_cents) as amt,
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
  left join lateral (
    select sum(public.report_cents(a -> 'amount_cents')) as comp, count(*) as comp_n
      from public.orders ord2,
           jsonb_array_elements(case when jsonb_typeof(ord2.adjustments) = 'array'
                                     then ord2.adjustments else '[]'::jsonb end) a
     where ord2.id = ob.id and a ->> 'type' = 'comp'
  ) cp on true
),
f as (select * from f0),
-- ---- refunds, DATED BY WHEN THEY HAPPENED ----------------------------------
-- Confirmed refunds of SALE orders (pending card / stored-value reservations
-- are not refunds yet; voided orders count as voids, stored-value sales are a
-- liability). A refund's day is its refunds[] entry's `at` in the location's
-- business day; an unrecorded older remainder keeps the order's day. The order
-- may be from any earlier day: the payment's updated_at bounds the scan.
rpay as (
  select p.id as payment_id, p.order_id, p.amount_cents, p.tip_cents, p.refunded_cents,
         p.refunds, p.created_at as p_created, p.rail, p.method, p.processor,
         ord.location_id, l.name as location_name, l.tz, l.cutoff, ord.staff_id,
         ((ord.created_at at time zone l.tz) - make_interval(mins => l.cutoff))::date as order_bd,
         case
           when ord.source ->> 'channel' in ('kiosk', 'catering', 'marketplace', 'phone', 'agent')
             then ord.source ->> 'channel'
           when ord.channel::text = 'online_delivery' then 'delivery'
           when ord.channel::text = 'online_pickup' then 'online'
           else 'terminal'
         end as channel
  from public.payments p
  join public.orders ord on ord.id = p.order_id and ord.tenant_id = p_tenant_id
  join locs l on l.id = ord.location_id
  where p.tenant_id = p_tenant_id
    and (p_location_id is null or ord.location_id = p_location_id)
    and p.status::text in ('captured', 'refunded')
    and p.refunded_cents > 0
    and p.updated_at >= (p_from::timestamp at time zone 'UTC') - interval '2 days'
    and ord.status::text not in ('draft', 'awaiting_payment', 'abandoned', 'voided')
    and not coalesce(ord.core_ext ? 'stored_value', false)
),
-- Each tender's refund steps: the unrecorded remainder first, then each entry.
rsteps as (
  select rp.payment_id, rp.order_id, 0::bigint as n, null::timestamptz as at,
         (rp.refunded_cents - coalesce(kn.known, 0))::bigint as amt, null::bigint as tip_x
    from rpay rp
    left join lateral (
      select sum(public.report_cents(x -> 'amount_cents')) as known
        from jsonb_array_elements(case when jsonb_typeof(rp.refunds) = 'array'
                                       then rp.refunds else '[]'::jsonb end) x
       where coalesce(x ->> 'state', '') <> 'pending'
    ) kn on true
   where rp.refunded_cents - coalesce(kn.known, 0) > 0
  union all
  select rp.payment_id, rp.order_id, t.n, (t.x ->> 'at')::timestamptz,
         public.report_cents(t.x -> 'amount_cents'),
         case when (t.x ->> 'tip_cents') ~ '^[0-9]{1,12}$' then (t.x ->> 'tip_cents')::bigint end
    from rpay rp,
         jsonb_array_elements(case when jsonb_typeof(rp.refunds) = 'array'
                                   then rp.refunds else '[]'::jsonb end) with ordinality as t(x, n)
   where coalesce(t.x ->> 'state', '') <> 'pending'
),
-- A step's tip part: what it recorded, else tip last within its tender.
rtip as (
  select s.*, rp.amount_cents, rp.tip_cents, rp.p_created,
         sum(s.amt) over (partition by s.payment_id order by s.n) as run
    from rsteps s join rpay rp on rp.payment_id = s.payment_id
),
rtip2 as (
  select r.*,
         case when r.tip_x is not null then r.tip_x
              else least(r.tip_cents, greatest(0, r.run - r.amount_cents))
                 - least(r.tip_cents, greatest(0, r.run - r.amt - r.amount_cents)) end as tip_raw
    from rtip r
),
-- The order's split basis (as for a sale above; for orders of any day).
rbasis as (
  select ord.id as order_id,
         coalesce(li.gross, 0) as gross,
         public.report_cents(ord.totals -> 'discount_cents') as discount,
         public.report_cents(ord.totals -> 'tax_cents') as tax,
         greatest(0, public.report_cents(ord.totals -> 'total_cents')
                     - public.report_cents(ord.totals -> 'tip_cents')
                     - public.report_cents(ord.totals -> 'tax_cents')
                     - (coalesce(li.gross, 0) - public.report_cents(ord.totals -> 'discount_cents'))) as fees,
         case when public.report_cents(ord.totals -> 'tip_cents') > 0
              then public.report_cents(ord.totals -> 'tip_cents')
              else coalesce(tp.tip, 0) end as tip
    from (select distinct order_id from rpay) ro
    join public.orders ord on ord.id = ro.order_id
    left join lateral (
      select sum(oi.unit_price_cents::bigint * oi.quantity) filter (where not oi.voided) as gross
        from public.order_items oi where oi.order_id = ord.id
    ) li on true
    left join lateral (
      select sum(p.tip_cents) as tip from public.payments p
       where p.order_id = ord.id and p.tenant_id = p_tenant_id
         and p.status::text in ('captured', 'refunded')
    ) tp on true
),
-- Cumulative per order in time order (remainders first), split, differenced.
rcum as (
  select r.*, b.gross, b.discount, b.tax, b.fees, b.tip,
         sum(r.amt) over w as c_total,
         sum(r.tip_raw) over w as c_tip
    from rtip2 r join rbasis b on b.order_id = r.order_id
  window w as (partition by r.order_id
               order by (r.at is not null), r.at, r.p_created, r.payment_id, r.n
               rows between unbounded preceding and current row)
),
rsplit as (
  select c.*, sp.ref_tip, sp.ref_tax, sp.ref_fees, sp.ref_sales
    from rcum c
   cross join lateral public.report_refund_split(
     c.c_total::bigint, c.c_tip::bigint, greatest(c.gross - c.discount, 0)::bigint,
     c.tax::bigint, c.fees::bigint, c.tip::bigint) sp
),
rf as (
  select s.order_id, s.payment_id, rp.location_id, rp.location_name, rp.channel, rp.staff_id,
         rp.rail, rp.method, rp.processor,
         case when s.at is null then rp.order_bd
              else ((s.at at time zone rp.tz) - make_interval(mins => rp.cutoff))::date end as bd,
         s.amt as refunded,
         (s.ref_tip - coalesce(lag(s.ref_tip) over w, 0)) as ref_tip_c,
         (s.ref_tax - coalesce(lag(s.ref_tax) over w, 0)) as ref_tax_c,
         (s.ref_fees - coalesce(lag(s.ref_fees) over w, 0)) as ref_fees_c,
         (s.ref_sales - coalesce(lag(s.ref_sales) over w, 0)) as ref_sales_c
    from rsplit s join rpay rp on rp.payment_id = s.payment_id
  window w as (partition by s.order_id
               order by (s.at is not null), s.at, s.p_created, s.payment_id, s.n)
),
rf_in as (select * from rf where bd between p_from and p_to),
sales as (select * from f where is_sale),
daily_sales as (
  select
    location_id, location_name, bd as business_date,
    count(*) filter (where is_sale) as orders,
    coalesce(sum(gross) filter (where is_sale), 0) as gross_cents,
    coalesce(sum(discount) filter (where is_sale), 0) as discount_cents,
    coalesce(sum(fees) filter (where is_sale), 0) as fees_gross,
    coalesce(sum(tax) filter (where is_sale), 0) as tax_gross,
    coalesce(sum(tip) filter (where is_sale), 0) as tip_gross,
    count(*) filter (where is_void) as void_count,
    coalesce(sum(total) filter (where is_void), 0) as void_cents,
    coalesce(sum(comp) filter (where is_sale), 0) as comp_cents,
    coalesce(sum(comp_n) filter (where is_sale), 0) as comp_count,
    coalesce(sum(t_cash) filter (where is_sale), 0) as cash_cents,
    coalesce(sum(t_card) filter (where is_sale), 0) as card_cents,
    coalesce(sum(t_crypto) filter (where is_sale), 0) as crypto_cents,
    coalesce(sum(t_gift_card) filter (where is_sale), 0) as gift_card_cents,
    coalesce(sum(t_store_credit) filter (where is_sale), 0) as store_credit_cents,
    coalesce(sum(t_other) filter (where is_sale), 0) as other_cents
  from f
  group by location_id, location_name, bd
),
daily_ref as (
  select location_id, max(location_name) as location_name, bd as business_date,
         sum(refunded) as refund_cents, sum(ref_sales_c) as refund_sales_cents,
         sum(ref_tax_c) as refund_tax_cents, sum(ref_fees_c) as refund_fees_cents,
         sum(ref_tip_c) as refund_tip_cents
  from rf_in group by location_id, bd
),
daily as (
  select
    coalesce(s.location_id, r.location_id) as location_id,
    coalesce(s.location_name, r.location_name) as location_name,
    coalesce(s.business_date, r.business_date) as business_date,
    coalesce(s.orders, 0) as orders,
    coalesce(s.gross_cents, 0) as gross_cents,
    coalesce(s.discount_cents, 0) as discount_cents,
    coalesce(r.refund_cents, 0) as refund_cents,
    coalesce(r.refund_sales_cents, 0) as refund_sales_cents,
    coalesce(r.refund_tax_cents, 0) as refund_tax_cents,
    coalesce(r.refund_fees_cents, 0) as refund_fees_cents,
    coalesce(s.fees_gross, 0) - coalesce(r.refund_fees_cents, 0) as fees_cents,
    coalesce(r.refund_tip_cents, 0) as refund_tip_cents,
    coalesce(s.tax_gross, 0) - coalesce(r.refund_tax_cents, 0) as tax_cents,
    coalesce(s.tip_gross, 0) - coalesce(r.refund_tip_cents, 0) as tip_cents,
    coalesce(s.void_count, 0) as void_count,
    coalesce(s.void_cents, 0) as void_cents,
    coalesce(s.comp_cents, 0) as comp_cents,
    coalesce(s.comp_count, 0) as comp_count,
    coalesce(s.cash_cents, 0) as cash_cents,
    coalesce(s.card_cents, 0) as card_cents,
    coalesce(s.crypto_cents, 0) as crypto_cents,
    coalesce(s.gift_card_cents, 0) as gift_card_cents,
    coalesce(s.store_credit_cents, 0) as store_credit_cents,
    coalesce(s.other_cents, 0) as other_cents
  from daily_sales s
  full outer join daily_ref r
    on r.location_id = s.location_id and r.business_date = s.business_date
),
channels as (
  select coalesce(s.channel, r.channel) as channel,
         coalesce(s.orders, 0) as orders,
         coalesce(s.gross_cents, 0) as gross_cents,
         coalesce(s.discount_cents, 0) as discount_cents,
         coalesce(r.refund_cents, 0) as refund_cents,
         coalesce(r.refund_sales_cents, 0) as refund_sales_cents,
         coalesce(r.refund_fees_cents, 0) as refund_fees_cents,
         coalesce(s.fees_gross, 0) - coalesce(r.refund_fees_cents, 0) as fees_cents
  from (select channel, count(*) as orders, sum(gross) as gross_cents,
               sum(discount) as discount_cents, sum(fees) as fees_gross
          from sales group by channel) s
  full outer join (
    select channel, sum(refunded) as refund_cents, sum(ref_sales_c) as refund_sales_cents,
           sum(ref_fees_c) as refund_fees_cents
      from rf_in group by channel) r on r.channel = s.channel
),
tender_keys as (
  select p.*,
         case when p.rail::text = 'external'
           then 'external:' || coalesce(nullif(regexp_replace(p.method, '[:\s]', '_', 'g'), ''), 'other')
                || ':' || coalesce(regexp_replace(p.processor, '[:\s]', '_', 'g'), '')
           else p.rail::text end as key
  from sales s
  join public.payments p on p.order_id = s.id and p.tenant_id = p_tenant_id
  where p.status::text in ('captured', 'refunded')
),
tenders as (
  select coalesce(a.key, r.key) as key,
         coalesce(a.count, 0) as count,
         coalesce(a.amount_cents, 0) as amount_cents,
         coalesce(a.tip_cents, 0) as tip_cents,
         coalesce(r.refunded_cents, 0) as refunded_cents
  from (select key, count(*) as count, sum(amount_cents) as amount_cents, sum(tip_cents) as tip_cents
          from tender_keys group by key) a
  full outer join (
    select case when rail::text = 'external'
             then 'external:' || coalesce(nullif(regexp_replace(method, '[:\s]', '_', 'g'), ''), 'other')
                  || ':' || coalesce(regexp_replace(processor, '[:\s]', '_', 'g'), '')
             else rail::text end as key,
           sum(refunded) as refunded_cents
      from rf_in group by 1) r on r.key = a.key
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
  select coalesce(sa.staff_id, rr.staff_id) as staff_id,
         coalesce(max(st.name), 'Unattributed') as name,
         coalesce(max(sa.orders), 0) as orders,
         coalesce(max(sa.sales_gross), 0) - coalesce(max(rr.ref_sales), 0) as sales_cents,
         coalesce(max(sa.tip_gross), 0) - coalesce(max(rr.ref_tip), 0) as tip_cents,
         coalesce(max(rr.refunded), 0) as refund_cents,
         coalesce(max(sa.void_count), 0) as void_count
  from (
    select f.staff_id,
           count(*) filter (where f.is_sale) as orders,
           coalesce(sum(f.gross - f.discount) filter (where f.is_sale), 0) as sales_gross,
           coalesce(sum(f.tip) filter (where f.is_sale), 0) as tip_gross,
           count(*) filter (where f.is_void) + coalesce(sum(f.voided_lines) filter (where f.is_sale), 0) as void_count
    from f group by f.staff_id
  ) sa
  full outer join (
    select staff_id, sum(ref_sales_c) as ref_sales, sum(ref_tip_c) as ref_tip, sum(refunded) as refunded
      from rf_in group by staff_id
  ) rr on coalesce(rr.staff_id::text, '') = coalesce(sa.staff_id::text, '')
  left join public.staff st on st.id = coalesce(sa.staff_id, rr.staff_id) and st.tenant_id = p_tenant_id
  group by coalesce(sa.staff_id, rr.staff_id)
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

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.report_refund_split(bigint, bigint, bigint, bigint, bigint, bigint) to service_role;
  end if;
end
$$;

commit;

notify pgrst, 'reload schema';
