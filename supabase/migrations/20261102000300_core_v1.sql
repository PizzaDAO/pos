-- ============================================================================
-- (PR #21 rebased: was 20260620000000_core_v1, renumbered after main's
-- 20261101000300 and PR #20's 20261102000200. Online orders that are still
-- `awaiting_payment` / were `abandoned` (main's checkout lifecycle) are treated
-- like a terminal hold: not announced until paid.)
-- Migration: core_v1
-- Open Pizza core contract support (@openpizza/core 0.1.0), POS-1/2/7:
--   1. tenant_settings          (inventory_owner: who depletes inventory)
--   2. staff.user_id/location_ids (identity link for workforce, POS-7)
--   3. orders.source/hold/version (order origin, held orders, change counter)
--   4. locations structured address + lat/lng
--   5. core_outbox + core_outbox_seq + AFTER triggers that write contract
--      events IN THE SAME TRANSACTION as the change (transactional outbox)
--
-- The outbox row stores a thin reference (event type, subject, changes, a
-- row snapshot). The delivery worker (src/lib/core/outbox.ts) hydrates the
-- full contract payload from the current POS state, signs it (Standard
-- Webhooks) and POSTs it to the hub ingest URL with retries.
--
-- POS does NOT alter tenants/locations ownership beyond additive nullable
-- columns on `locations` that the contract needs (geo + structured address).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. tenant_settings
-- ----------------------------------------------------------------------------
create table if not exists public.tenant_settings (
  tenant_id uuid primary key references public.tenants (id) on delete cascade,
  inventory_owner text not null default 'pos_basic'
    check (inventory_owner in ('pos_basic', 'backofhouse')),
  updated_at timestamptz not null default now()
);

alter table public.tenant_settings enable row level security;
alter table public.tenant_settings force row level security;

drop policy if exists tenant_settings_select on public.tenant_settings;
create policy tenant_settings_select on public.tenant_settings
  for select
  using (public.is_platform_admin() or public.is_tenant_member(tenant_id));
drop policy if exists tenant_settings_write on public.tenant_settings;
create policy tenant_settings_write on public.tenant_settings
  for all
  using (
    public.is_platform_admin()
    or public.has_tenant_role(tenant_id, array['owner']::public.membership_role[])
  )
  with check (
    public.is_platform_admin()
    or public.has_tenant_role(tenant_id, array['owner']::public.membership_role[])
  );

-- ----------------------------------------------------------------------------
-- 2. staff identity link (POS-7)
-- ----------------------------------------------------------------------------
alter table public.staff
  add column if not exists user_id uuid,
  add column if not exists location_ids uuid[] not null default '{}';

create index if not exists staff_user_id_idx on public.staff (user_id);

-- ----------------------------------------------------------------------------
-- 3. orders: source, hold, version
-- ----------------------------------------------------------------------------
alter table public.orders
  add column if not exists source jsonb,
  add column if not exists hold jsonb,
  add column if not exists version integer not null default 1;

create or replace function public.core_bump_order_version()
returns trigger
language plpgsql
as $$
begin
  new.version := coalesce(old.version, 1) + 1;
  return new;
end;
$$;

drop trigger if exists orders_core_version on public.orders;
create trigger orders_core_version
  before update on public.orders
  for each row execute function public.core_bump_order_version();

-- ----------------------------------------------------------------------------
-- 4. locations: structured address + geo (nullable; `address` stays the
--    display line)
-- ----------------------------------------------------------------------------
alter table public.locations
  add column if not exists address_line1 text,
  add column if not exists address_line2 text,
  add column if not exists city text,
  add column if not exists region text,
  add column if not exists postal_code text,
  add column if not exists country text,
  add column if not exists lat double precision,
  add column if not exists lng double precision;

-- ----------------------------------------------------------------------------
-- 5. Transactional outbox
-- ----------------------------------------------------------------------------
create table if not exists public.core_outbox_seq (
  tenant_id uuid primary key references public.tenants (id) on delete cascade,
  last_sequence bigint not null default 0
);

create table if not exists public.core_outbox (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  location_id uuid,
  event_type text not null,
  subject_type text not null,
  subject_id uuid not null,
  subject_version integer,
  -- per-tenant monotonic (gap-free: allocated in the same transaction).
  sequence bigint not null,
  -- field -> [old, new] in POS vocabulary (the worker maps to contract fields).
  changes jsonb,
  -- snapshot of the changed row at emit time (secrets stripped).
  row_snapshot jsonb,
  occurred_at timestamptz not null default now(),
  status text not null default 'pending'
    check (status in ('pending', 'delivered', 'dead')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error text,
  delivered_at timestamptz,
  unique (tenant_id, sequence)
);

create index if not exists core_outbox_due_idx
  on public.core_outbox (next_attempt_at)
  where status = 'pending';
create index if not exists core_outbox_tenant_seq_idx
  on public.core_outbox (tenant_id, sequence);

-- Server-only: service role bypasses RLS; nobody else gets a policy.
alter table public.core_outbox enable row level security;
alter table public.core_outbox force row level security;
alter table public.core_outbox_seq enable row level security;
alter table public.core_outbox_seq force row level security;
revoke all on public.core_outbox from anon, authenticated;
revoke all on public.core_outbox_seq from anon, authenticated;

-- Core emitter: allocates the next per-tenant sequence (row-locked, so two
-- concurrent transactions for one tenant serialize) and appends the event.
create or replace function public.core_emit(
  p_tenant uuid,
  p_location uuid,
  p_type text,
  p_subject_type text,
  p_subject_id uuid,
  p_version integer,
  p_changes jsonb,
  p_row jsonb
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_seq bigint;
begin
  insert into public.core_outbox_seq as s (tenant_id, last_sequence)
  values (p_tenant, 1)
  on conflict (tenant_id) do update
    set last_sequence = s.last_sequence + 1
  returning last_sequence into v_seq;

  insert into public.core_outbox (
    tenant_id, location_id, event_type, subject_type, subject_id,
    subject_version, sequence, changes, row_snapshot
  ) values (
    p_tenant, p_location, p_type, p_subject_type, p_subject_id,
    p_version, v_seq, p_changes, p_row
  );
end;
$$;

revoke all on function public.core_emit(uuid, uuid, text, text, uuid, integer, jsonb, jsonb)
  from public, anon, authenticated;

-- ---- orders ----------------------------------------------------------------
create or replace function public.core_trg_orders()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row jsonb := to_jsonb(new);
  v_changes jsonb;
begin
  if tg_op = 'INSERT' then
    -- held (draft) orders and unpaid online checkouts are invisible until
    -- released / paid; voided and abandoned inserts never existed for the
    -- kitchen.
    if new.status not in ('draft', 'awaiting_payment', 'voided', 'abandoned') then
      perform public.core_emit(new.tenant_id, new.location_id, 'order.placed',
        'order', new.id, new.version, null, v_row);
    end if;
    return new;
  end if;

  if new.status is distinct from old.status then
    v_changes := jsonb_build_object('status', jsonb_build_array(old.status, new.status));
    perform public.core_emit(new.tenant_id, new.location_id, 'order.status_changed',
      'order', new.id, new.version, v_changes, v_row);
    if old.status in ('draft', 'awaiting_payment')
       and new.status not in ('draft', 'awaiting_payment', 'voided', 'abandoned') then
      perform public.core_emit(new.tenant_id, new.location_id, 'order.placed',
        'order', new.id, new.version, v_changes, v_row);
    end if;
    if new.status = 'ready' then
      perform public.core_emit(new.tenant_id, new.location_id, 'order.ready',
        'order', new.id, new.version, v_changes, v_row);
    elsif new.status = 'completed' then
      perform public.core_emit(new.tenant_id, new.location_id, 'order.completed',
        'order', new.id, new.version, v_changes, v_row);
    elsif new.status = 'voided' then
      perform public.core_emit(new.tenant_id, new.location_id, 'order.canceled',
        'order', new.id, new.version, v_changes, v_row);
    end if;
  elsif new.totals is distinct from old.totals
     or new.notes is distinct from old.notes
     or new.fulfillment is distinct from old.fulfillment
     or new.discount_cents is distinct from old.discount_cents
     or new.customer_id is distinct from old.customer_id then
    perform public.core_emit(new.tenant_id, new.location_id, 'order.updated',
      'order', new.id, new.version, null, v_row);
  end if;
  return new;
end;
$$;

drop trigger if exists orders_core_outbox on public.orders;
create trigger orders_core_outbox
  after insert or update on public.orders
  for each row execute function public.core_trg_orders();

-- ---- payments --------------------------------------------------------------
create or replace function public.core_trg_payments()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_type text;
  v_changes jsonb;
begin
  if tg_op = 'INSERT' then
    v_type := case new.status::text
      when 'authorized' then 'payment.authorized'
      when 'captured' then 'payment.captured'
      when 'failed' then 'payment.failed'
      when 'refunded' then 'payment.refunded'
      else null end;
  elsif new.status is distinct from old.status then
    v_changes := jsonb_build_object('status', jsonb_build_array(old.status, new.status));
    v_type := case new.status::text
      when 'authorized' then 'payment.authorized'
      when 'captured' then 'payment.captured'
      when 'failed' then 'payment.failed'
      when 'refunded' then 'payment.refunded'
      else null end;
  elsif new.refunded_cents > old.refunded_cents then
    v_changes := jsonb_build_object('refunded_cents',
      jsonb_build_array(old.refunded_cents, new.refunded_cents));
    v_type := 'payment.refunded';
  end if;

  if v_type is not null then
    perform public.core_emit(new.tenant_id, new.location_id, v_type,
      'payment', new.id, null, v_changes, to_jsonb(new) - 'raw');
  end if;
  return new;
end;
$$;

drop trigger if exists payments_core_outbox on public.payments;
create trigger payments_core_outbox
  after insert or update on public.payments
  for each row execute function public.core_trg_payments();

-- ---- menu availability / price overrides ----------------------------------
create or replace function public.core_trg_menu_overrides()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old_avail boolean;
  v_new_avail boolean;
  v_old_price integer;
  v_new_price integer;
  v_row public.location_menu_overrides;
begin
  if tg_op = 'DELETE' then
    v_row := old;
    v_old_avail := old.available;
    v_new_avail := null;
    v_old_price := old.price_cents;
    v_new_price := null;
  elsif tg_op = 'INSERT' then
    v_row := new;
    v_old_avail := null;
    v_new_avail := new.available;
    v_old_price := null;
    v_new_price := new.price_cents;
  else
    v_row := new;
    v_old_avail := old.available;
    v_new_avail := new.available;
    v_old_price := old.price_cents;
    v_new_price := new.price_cents;
  end if;

  -- "available is not false" == orderable.
  if (coalesce(v_old_avail, true)) is distinct from (coalesce(v_new_avail, true)) then
    perform public.core_emit(v_row.tenant_id, v_row.location_id,
      case when coalesce(v_new_avail, true) then 'menu.item.available'
           else 'menu.item.unavailable' end,
      'menu_item', v_row.target_id, null,
      jsonb_build_object('available', jsonb_build_array(coalesce(v_old_avail, true), coalesce(v_new_avail, true))),
      to_jsonb(v_row));
  end if;

  if v_old_price is distinct from v_new_price then
    perform public.core_emit(v_row.tenant_id, v_row.location_id, 'menu.updated',
      'menu', v_row.location_id, null, null, to_jsonb(v_row));
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists location_menu_overrides_core_outbox on public.location_menu_overrides;
create trigger location_menu_overrides_core_outbox
  after insert or update or delete on public.location_menu_overrides
  for each row execute function public.core_trg_menu_overrides();

-- ---- menu structure (thin menu.updated, debounced 1/min/tenant) ------------
create or replace function public.core_trg_menu_structure()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row jsonb;
  v_tenant uuid;
  v_item uuid;
begin
  v_row := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;

  if tg_table_name = 'item_sizes' then
    v_item := (v_row ->> 'item_id')::uuid;
    select tenant_id into v_tenant from public.menu_items where id = v_item;
  elsif tg_table_name = 'modifiers' then
    select tenant_id into v_tenant from public.modifier_groups
      where id = (v_row ->> 'group_id')::uuid;
  else
    v_tenant := (v_row ->> 'tenant_id')::uuid;
    if tg_table_name = 'menu_items' then v_item := (v_row ->> 'id')::uuid; end if;
  end if;

  if v_tenant is not null
     and not exists (
       select 1 from public.core_outbox
        where tenant_id = v_tenant and event_type = 'menu.updated'
          and subject_type = 'menu' and subject_id = v_tenant
          and status = 'pending' and occurred_at > now() - interval '1 minute'
     ) then
    perform public.core_emit(v_tenant, null, 'menu.updated', 'menu', v_tenant, null,
      null, jsonb_build_object('changed_item_id', v_item, 'table', tg_table_name));
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

do $$
declare t text;
begin
  foreach t in array array['menu_categories','menu_items','item_sizes','modifier_groups','modifiers']
  loop
    execute format('drop trigger if exists %I on public.%I', t || '_core_outbox', t);
    execute format(
      'create trigger %I after insert or update or delete on public.%I
         for each row execute function public.core_trg_menu_structure()',
      t || '_core_outbox', t);
  end loop;
end
$$;

-- ---- locations + store settings -> location.updated ------------------------
create or replace function public.core_trg_locations()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if to_jsonb(new) is distinct from to_jsonb(old) then
    perform public.core_emit(new.tenant_id, new.id, 'location.updated',
      'location', new.id, null, null, to_jsonb(new));
  end if;
  return new;
end;
$$;

drop trigger if exists locations_core_outbox on public.locations;
create trigger locations_core_outbox
  after update on public.locations
  for each row execute function public.core_trg_locations();

create or replace function public.core_trg_store_settings()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' or to_jsonb(new) is distinct from to_jsonb(old) then
    perform public.core_emit(new.tenant_id, new.location_id, 'location.updated',
      'location', new.location_id, null, null, to_jsonb(new));
  end if;
  return new;
end;
$$;

drop trigger if exists store_settings_core_outbox on public.store_settings;
create trigger store_settings_core_outbox
  after insert or update on public.store_settings
  for each row execute function public.core_trg_store_settings();

-- ---- customers -------------------------------------------------------------
create or replace function public.core_trg_customers()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.core_emit(new.tenant_id, null,
    case when tg_op = 'INSERT' then 'customer.created' else 'customer.updated' end,
    'customer', new.id, null, null, to_jsonb(new));
  return new;
end;
$$;

drop trigger if exists customers_core_outbox on public.customers;
create trigger customers_core_outbox
  after insert or update on public.customers
  for each row execute function public.core_trg_customers();

-- ---- staff -----------------------------------------------------------------
create or replace function public.core_trg_staff()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_type text;
begin
  if tg_op = 'INSERT' then
    v_type := 'staff.created';
  elsif old.active and not new.active then
    v_type := 'staff.deactivated';
  else
    v_type := 'staff.updated';
  end if;
  -- never put the PIN hash in the outbox
  perform public.core_emit(new.tenant_id, null, v_type, 'staff', new.id, null, null,
    to_jsonb(new) - 'pin_hash');
  return new;
end;
$$;

drop trigger if exists staff_core_outbox on public.staff;
create trigger staff_core_outbox
  after insert or update on public.staff
  for each row execute function public.core_trg_staff();

-- ---- shifts (cash drawer sessions) -----------------------------------------
create or replace function public.core_trg_shifts()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    perform public.core_emit(new.tenant_id, new.location_id, 'drawer_session.opened',
      'drawer_session', new.id, null, null, to_jsonb(new));
  elsif old.status = 'open' and new.status = 'closed' then
    perform public.core_emit(new.tenant_id, new.location_id, 'drawer_session.closed',
      'drawer_session', new.id, null,
      jsonb_build_object('status', jsonb_build_array(old.status, new.status)),
      to_jsonb(new));
  end if;
  return new;
end;
$$;

drop trigger if exists shifts_core_outbox on public.shifts;
create trigger shifts_core_outbox
  after insert or update on public.shifts
  for each row execute function public.core_trg_shifts();

-- ---- business day closes ---------------------------------------------------
create or replace function public.core_trg_business_day_closes()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.core_emit(new.tenant_id, new.location_id, 'business_day.closed',
    'business_day', new.id, null, null, to_jsonb(new));
  return new;
end;
$$;

drop trigger if exists business_day_closes_core_outbox on public.business_day_closes;
create trigger business_day_closes_core_outbox
  after insert on public.business_day_closes
  for each row execute function public.core_trg_business_day_closes();

-- ---- deliveries ------------------------------------------------------------
create or replace function public.core_trg_deliveries()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' or new.status is distinct from old.status then
    perform public.core_emit(new.tenant_id, new.location_id, 'delivery.status_changed',
      'delivery', new.id, null,
      case when tg_op = 'UPDATE'
        then jsonb_build_object('status', jsonb_build_array(old.status, new.status))
        else null end,
      to_jsonb(new));
  end if;
  return new;
end;
$$;

drop trigger if exists deliveries_core_outbox on public.deliveries;
create trigger deliveries_core_outbox
  after insert or update on public.deliveries
  for each row execute function public.core_trg_deliveries();

-- Claim due outbox rows for the delivery worker: SKIP LOCKED so two cron
-- invocations never deliver the same row, and push next_attempt_at out as a
-- visibility timeout in case the worker dies mid-flight.
create or replace function public.core_outbox_claim(p_limit integer, p_lease_seconds integer default 120)
returns setof public.core_outbox
language sql
security definer
set search_path = public
as $$
  with due as (
    select id from public.core_outbox
     where status = 'pending' and next_attempt_at <= now()
     order by tenant_id, sequence
     limit greatest(p_limit, 1)
     for update skip locked
  )
  update public.core_outbox o
     set next_attempt_at = now() + make_interval(secs => p_lease_seconds)
    from due
   where o.id = due.id
  returning o.*;
$$;

revoke all on function public.core_outbox_claim(integer, integer) from public, anon, authenticated;
grant execute on function public.core_outbox_claim(integer, integer) to service_role;
