-- ============================================================================
-- Migration: owner_reports
--
-- Owner/manager reports aggregated IN SQL (nothing pulls orders into JS):
--
--   * locations.business_day_cutoff_minutes: minutes after local midnight at
--     which a location's business day starts (0 = midnight; 240 = 04:00, so a
--     01:30 sale on Saturday night still belongs to Friday's business day).
--   * report_sales_bundle(tenant, location|null, from, to, top_n): ONE call that
--     returns daily rows, channel, tender, weekday x hour, item, category and
--     staff slices as jsonb. `from`/`to` are inclusive BUSINESS dates. Every
--     order is bucketed in its own location's timezone (DST-safe: the wall clock
--     comes from `at time zone <iana>`), so a tenant rollup across timezones
--     is correct.
--
-- Definitions (mirrored in src/lib/owner-reports.ts, which the mock driver and
-- the unit tests use):
--   sale     = order status not in (draft, awaiting_payment, abandoned, voided)
--   gross    = sum(unit_price_cents * quantity) of non-voided lines
--   discount = orders.totals.discount_cents
--   refunds  = sum(payments.refunded_cents) on the order's tenders
--   net      = gross - discount - refunds
--   tips     = order-level tip, else the tenders' tips (never both)
--   tenders  = payments in status captured | refunded
--   channel  = orders.source.channel when it is kiosk/catering/marketplace/
--              phone/agent, else online_delivery -> delivery, online_pickup ->
--              online, in_store -> terminal
--
-- Additive: one column with a default, two functions. Callable by the service
-- role only (the API route does the owner/manager + tenant check first).
-- ============================================================================

begin;
set local lock_timeout = '3s';

alter table public.locations
  add column if not exists business_day_cutoff_minutes integer not null default 0;
alter table public.locations
  drop constraint if exists locations_business_day_cutoff_chk;
alter table public.locations
  add constraint locations_business_day_cutoff_chk
  check (business_day_cutoff_minutes between 0 and 719);

-- Tolerant numeric read from a totals jsonb (a malformed value counts as 0).
create or replace function public.report_cents(p jsonb)
returns integer
language sql
immutable
set search_path = public, pg_temp
as $$
  select case when jsonb_typeof(p) = 'number' then round((p #>> '{}')::numeric)::integer else 0 end
$$;

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
-- One row per order in range, bucketed by its own location's business day.
o as (
  select
    ord.id,
    ord.location_id,
    l.name as location_name,
    ord.status::text as status,
    ord.staff_id,
    ((ord.created_at at time zone l.timezone)
       - make_interval(mins => l.business_day_cutoff_minutes))::date as bd,
    extract(hour from (ord.created_at at time zone l.timezone))::int as hr,
    case
      when ord.source ->> 'channel' in ('kiosk', 'catering', 'marketplace', 'phone', 'agent')
        then ord.source ->> 'channel'
      when ord.channel::text = 'online_delivery' then 'delivery'
      when ord.channel::text = 'online_pickup' then 'online'
      else 'terminal'
    end as channel,
    (ord.status::text not in ('draft', 'awaiting_payment', 'abandoned', 'voided')) as is_sale,
    (ord.status::text = 'voided') as is_void,
    public.report_cents(ord.totals -> 'discount_cents') as discount,
    public.report_cents(ord.totals -> 'tax_cents') as tax,
    public.report_cents(ord.totals -> 'tip_cents') as order_tip,
    public.report_cents(ord.totals -> 'total_cents') as total
  from public.orders ord
  join public.locations l on l.id = ord.location_id and l.tenant_id = ord.tenant_id
  where ord.tenant_id = p_tenant_id
    and (p_location_id is null or ord.location_id = p_location_id)
    -- coarse index-friendly window; the exact business-day filter is below
    and ord.created_at >= (p_from::timestamp at time zone 'UTC') - interval '2 days'
    and ord.created_at <  (p_to::timestamp at time zone 'UTC') + interval '4 days'
),
ob as (select * from o where bd between p_from and p_to and (is_sale or is_void)),
-- Money per order: lines + tenders.
f as (
  select
    ob.*,
    coalesce(li.gross, 0) as gross,
    coalesce(li.voided_lines, 0) as voided_lines,
    coalesce(pay.refunded, 0) as refunded,
    case when ob.order_tip > 0 then ob.order_tip else coalesce(pay.tip, 0) end as tip,
    coalesce(pay.cash, 0) as t_cash,
    coalesce(pay.card, 0) as t_card,
    coalesce(pay.crypto, 0) as t_crypto,
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
      sum(p.tip_cents) as tip,
      sum(p.amount_cents) filter (where p.rail::text = 'cash' or (p.rail::text = 'external' and p.method = 'cash')) as cash,
      sum(p.amount_cents) filter (where p.rail::text in ('stripe_terminal', 'stripe_online') or (p.rail::text = 'external' and p.method = 'card')) as card,
      sum(p.amount_cents) filter (where p.rail::text like 'crypto%' or (p.rail::text = 'external' and p.method = 'crypto')) as crypto,
      sum(p.amount_cents) filter (where not (
            p.rail::text in ('cash', 'stripe_terminal', 'stripe_online')
         or p.rail::text like 'crypto%'
         or (p.rail::text = 'external' and p.method in ('cash', 'card', 'crypto')))) as other
    from public.payments p
    where p.order_id = ob.id and p.tenant_id = p_tenant_id
      and p.status::text in ('captured', 'refunded')
  ) pay on true
),
sales as (select * from f where is_sale),
daily as (
  select
    location_id, location_name, bd as business_date,
    count(*) filter (where is_sale) as orders,
    coalesce(sum(gross) filter (where is_sale), 0) as gross_cents,
    coalesce(sum(discount) filter (where is_sale), 0) as discount_cents,
    coalesce(sum(refunded) filter (where is_sale), 0) as refund_cents,
    coalesce(sum(tax) filter (where is_sale), 0) as tax_cents,
    coalesce(sum(tip) filter (where is_sale), 0) as tip_cents,
    count(*) filter (where is_void) as void_count,
    coalesce(sum(total) filter (where is_void), 0) as void_cents,
    coalesce(sum(t_cash) filter (where is_sale), 0) as cash_cents,
    coalesce(sum(t_card) filter (where is_sale), 0) as card_cents,
    coalesce(sum(t_crypto) filter (where is_sale), 0) as crypto_cents,
    coalesce(sum(t_other) filter (where is_sale), 0) as other_cents
  from f
  group by location_id, location_name, bd
),
channels as (
  select channel, count(*) as orders,
         sum(gross) as gross_cents, sum(discount) as discount_cents, sum(refunded) as refund_cents
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
         coalesce(sum(f.gross - f.discount) filter (where f.is_sale), 0) as sales_cents,
         coalesce(sum(f.tip) filter (where f.is_sale), 0) as tip_cents,
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
  'staff',    coalesce((select jsonb_agg(to_jsonb(s) order by s.sales_cents desc) from staff_rows s), '[]'::jsonb)
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
