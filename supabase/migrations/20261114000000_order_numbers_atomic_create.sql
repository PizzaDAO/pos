-- ============================================================================
-- Migration: order_numbers_atomic_create
--
-- Load-test fixes (loadtest/REPORT.md, ranks 2 and 5):
--
--   1. public.order_number_counters + public.next_order_number(tenant, location):
--      the server-assigned `A-####` number now comes from ONE atomic counter row
--      per location (UPDATE ... RETURNING), not from `count(*)` of every order at
--      the location (which grew with history, and gave two concurrent tills the
--      same number). The counter is seeded on first use from the location's
--      existing orders (max of the count and the highest `A-<n>` already used),
--      so numbering continues where it left off. It does NOT reset daily: the
--      number must stay unique per location (point 2), and the format carries
--      no date.
--   2. Unique index orders_location_order_number_key on (location_id,
--      order_number). If the live table already holds duplicate pairs (the old
--      count(*) race, the compensating delete freeing a number, two tills
--      minting the same client `HHMM-NNN`), the migration must not fail: the
--      index is then PARTIAL, covering only rows created at/after this
--      migration ran (a NOTICE reports how many duplicate groups were found),
--      and a plain index on the same columns backs the lookups below. Either
--      way create_order_with_lines() also checks the whole table, so a new
--      number never repeats an old one.
--   3. public.create_order_with_lines(p_order, p_items, p_modifiers): the order
--      row, its lines and their modifiers in ONE transaction (PostgREST cannot
--      span statements), replacing insert + insert + insert + compensating
--      delete. Idempotent on the order id (an existing order is returned
--      unchanged, created = false). A client-supplied number (the till's
--      offline `HHMM-NNN`) is kept; if it is already taken at the location it
--      gets a `-2`, `-3`, ... suffix instead of colliding. Returns the stored
--      order, lines and modifiers so the driver needs no read-back.
--   4. Index orders (tenant_id, location_id, updated_at) for the kitchen poll's
--      "changed in the last 15 minutes" read.
--
-- Additive and live-safe: one new table, new functions, new indexes. The
-- index builds take a SHARE lock on orders (writes wait while they build;
-- both are small btrees). The driver falls back to its previous path while this
-- migration is not applied. Functions are callable only by service_role.
-- Re-runnable.
-- ============================================================================

begin;
set local lock_timeout = '3s';

-- ---- 1. per-location order number counter ------------------------------------
create table if not exists public.order_number_counters (
  location_id uuid primary key references public.locations (id) on delete cascade,
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  last_value bigint not null,
  updated_at timestamptz not null default now()
);

-- Server-only: RLS on (and forced) with no policies; written only by the
-- SECURITY DEFINER function below.
alter table public.order_number_counters enable row level security;
alter table public.order_number_counters force row level security;
revoke all on public.order_number_counters from public, anon, authenticated;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke insert, update, delete, truncate, trigger, references
      on public.order_number_counters from service_role;
    grant select on public.order_number_counters to service_role;
  end if;
end
$$;

create or replace function public.next_order_number(p_tenant_id uuid, p_location_id uuid)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_next bigint;
  v_seed bigint;
begin
  -- Hot path: one row lock + increment.
  update public.order_number_counters
     set last_value = last_value + 1, updated_at = now()
   where location_id = p_location_id
  returning last_value into v_next;
  if found then return v_next; end if;

  -- First number at this location since the counter existed: continue after
  -- every number already handed out (the old count(*) scheme, or higher).
  select greatest(
           count(*),
           coalesce(max(substring(o.order_number from '^A-([0-9]{1,15})$')::bigint), 0))
    into v_seed
    from public.orders o
   where o.location_id = p_location_id;

  -- A concurrent first call may have inserted the row meanwhile: then this
  -- increments it instead (still one atomic statement).
  insert into public.order_number_counters as c (location_id, tenant_id, last_value)
  values (p_location_id, p_tenant_id, v_seed + 1)
  on conflict (location_id) do update
     set last_value = c.last_value + 1, updated_at = now()
  returning last_value into v_next;
  return v_next;
end;
$$;

-- ---- 2. unique (location_id, order_number) -----------------------------------
do $$
declare
  v_dupes bigint;
  v_cut text;
begin
  if to_regclass('public.orders_location_order_number_key') is not null then
    return;
  end if;
  select count(*) into v_dupes
    from (select 1 from public.orders
           group by location_id, order_number
          having count(*) > 1) d;
  if v_dupes = 0 then
    create unique index orders_location_order_number_key
      on public.orders (location_id, order_number);
  else
    v_cut := to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
    raise notice 'orders: % duplicate (location_id, order_number) groups exist; the unique index covers rows created at/after %',
      v_dupes, v_cut;
    execute format(
      'create unique index orders_location_order_number_key on public.orders (location_id, order_number) where created_at >= %L::timestamptz',
      v_cut);
    create index if not exists orders_location_order_number_idx
      on public.orders (location_id, order_number);
  end if;
end
$$;

-- The kitchen board's "recently changed" read (listKitchenOrders) filters on
-- updated_at; without this it scans every order of the location.
create index if not exists orders_location_updated_at_idx
  on public.orders (tenant_id, location_id, updated_at desc);

-- ---- 3. order + lines + modifiers in one transaction -------------------------
-- Shape returned by create_order_with_lines (and for an existing id).
create or replace function public.order_graph_json(p_order public.orders, p_created boolean)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'created', p_created,
    'order', to_jsonb(p_order),
    'items', coalesce((
      select jsonb_agg(to_jsonb(i) order by i.sort_order, i.id)
        from public.order_items i where i.order_id = p_order.id), '[]'::jsonb),
    'modifiers', coalesce((
      select jsonb_agg(to_jsonb(m) order by m.order_item_id, m.sort_order, m.id)
        from public.order_item_modifiers m
        join public.order_items i on i.id = m.order_item_id
       where i.order_id = p_order.id), '[]'::jsonb));
$$;

create or replace function public.create_order_with_lines(
  p_order jsonb,
  p_items jsonb,
  p_modifiers jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid := (p_order ->> 'id')::uuid;
  v_tenant uuid := (p_order ->> 'tenant_id')::uuid;
  v_location uuid := (p_order ->> 'location_id')::uuid;
  v_requested text := nullif(btrim(coalesce(p_order ->> 'order_number', '')), '');
  v_number text;
  v_row public.orders;
  v_try integer := 0;
  v_items integer;
  v_mods integer;
  v_inserted integer;
begin
  if v_id is null or v_tenant is null or v_location is null then
    raise exception 'create_order_with_lines: id, tenant_id and location_id are required'
      using errcode = '22023';
  end if;

  -- Idempotent on the client order id.
  select * into v_row from public.orders where id = v_id;
  if found then
    return public.order_graph_json(v_row, false);
  end if;

  if not exists (select 1 from public.locations
                  where id = v_location and tenant_id = v_tenant) then
    raise exception 'create_order_with_lines: location is not part of the tenant'
      using errcode = '22023';
  end if;

  loop
    v_try := v_try + 1;
    if v_try > 50 then
      raise exception 'create_order_with_lines: no free order number' using errcode = '23505';
    end if;
    if v_requested is null then
      v_number := 'A-' || lpad(public.next_order_number(v_tenant, v_location)::text, 4, '0');
    elsif v_try = 1 then
      v_number := v_requested;
    else
      v_number := left(v_requested, 28) || '-' || v_try;
    end if;
    -- The whole table (a partial unique index does not cover legacy rows).
    continue when exists (
      select 1 from public.orders
       where location_id = v_location and order_number = v_number);
    begin
      insert into public.orders (
        id, tenant_id, location_id, status, channel, currency, discount_cents,
        totals, notes, order_number, customer_id, staff_id, fulfillment, source,
        hold, core_ext, adjustments, created_at, updated_at)
      values (
        v_id, v_tenant, v_location,
        coalesce((p_order ->> 'status')::public.order_status, 'placed'),
        (p_order ->> 'channel')::public.order_channel,
        coalesce(p_order ->> 'currency', 'USD'),
        coalesce((p_order ->> 'discount_cents')::integer, 0),
        p_order -> 'totals',
        p_order ->> 'notes',
        v_number,
        (p_order ->> 'customer_id')::uuid,
        (p_order ->> 'staff_id')::uuid,
        nullif(p_order -> 'fulfillment', 'null'::jsonb),
        nullif(p_order -> 'source', 'null'::jsonb),
        nullif(p_order -> 'hold', 'null'::jsonb),
        nullif(p_order -> 'core_ext', 'null'::jsonb),
        nullif(p_order -> 'adjustments', 'null'::jsonb),
        coalesce((p_order ->> 'created_at')::timestamptz, now()),
        coalesce((p_order ->> 'updated_at')::timestamptz, now()))
      on conflict (id) do nothing
      returning * into v_row;
      exit;
    exception when unique_violation then
      -- A concurrent order took this number between the check and the insert
      -- (the unique index): try the next one.
      null;
    end;
  end loop;

  if v_row.id is null then
    -- A concurrent request with the same order id won: return its order.
    select * into v_row from public.orders where id = v_id;
    return public.order_graph_json(v_row, false);
  end if;

  insert into public.order_items (
    id, order_id, item_id, item_name, station, size_id, size_name,
    base_price_cents, quantity, notes, voided, unit_price_cents,
    line_total_cents, sort_order)
  select x.id, v_id, x.item_id, x.item_name, x.station, x.size_id, x.size_name,
         coalesce(x.base_price_cents, 0), coalesce(x.quantity, 1), x.notes,
         coalesce(x.voided, false), coalesce(x.unit_price_cents, 0),
         coalesce(x.line_total_cents, 0), coalesce(x.sort_order, 0)
    from jsonb_to_recordset(coalesce(p_items, '[]'::jsonb)) as x(
      id uuid, item_id uuid, item_name text, station public.station,
      size_id uuid, size_name text, base_price_cents integer, quantity integer,
      notes text, voided boolean, unit_price_cents integer,
      line_total_cents integer, sort_order integer);
  get diagnostics v_items = row_count;

  -- Modifiers only attach to THIS order's lines.
  insert into public.order_item_modifiers (
    id, order_item_id, group_id, group_name, modifier_id, modifier_name,
    price_cents, placement, sort_order)
  select coalesce(x.id, gen_random_uuid()), x.order_item_id, x.group_id,
         x.group_name, x.modifier_id, x.modifier_name,
         coalesce(x.price_cents, 0), coalesce(x.placement, 'whole'),
         coalesce(x.sort_order, 0)
    from jsonb_to_recordset(coalesce(p_modifiers, '[]'::jsonb)) as x(
      id uuid, order_item_id uuid, group_id uuid, group_name text,
      modifier_id uuid, modifier_name text, price_cents integer,
      placement text, sort_order integer)
    join public.order_items i on i.id = x.order_item_id and i.order_id = v_id;
  get diagnostics v_inserted = row_count;
  v_mods := jsonb_array_length(coalesce(p_modifiers, '[]'::jsonb));
  if v_inserted <> v_mods then
    raise exception 'create_order_with_lines: modifier for a line not on this order'
      using errcode = '22023';
  end if;

  -- Re-read: BEFORE triggers stamp core_announced / fired_at.
  select * into v_row from public.orders where id = v_id;
  return public.order_graph_json(v_row, true);
end;
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.next_order_number(uuid, uuid)',
    'public.order_graph_json(public.orders, boolean)',
    'public.create_order_with_lines(jsonb, jsonb, jsonb)'
  ] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on function %s from anon', f);
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format('revoke all on function %s from authenticated', f);
    end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('grant execute on function %s to service_role', f);
    end if;
  end loop;
end
$$;

commit;

notify pgrst, 'reload schema';
