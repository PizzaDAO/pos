-- ============================================================================
-- Migration: core_v1_hardening  (follow-up to 20260620000000_core_v1)
--
--   * Outbox enqueues only while a hub is configured (core_config.outbox_enabled,
--     flipped by the delivery cron), so an unconfigured POS never accumulates a
--     backlog.
--   * claim() counts the attempt, so a worker that dies/times out still walks
--     the row toward the dead-letter state.
--   * Retention: core_outbox_prune() deletes old delivered/dead rows, expires
--     stale pending rows and scrubs snapshots.
--   * Snapshots are MINIMAL (ids/status only): no customer/staff/address PII is
--     stored in the outbox; payloads are hydrated at delivery time.
--   * order.placed on leaving a hold (no status_changed); a never-announced hold
--     that is canceled emits nothing.
--   * menu.updated coalesces into an UNCLAIMED pending row (all changed item ids
--     are kept; edits made while a row is claimed get a new row).
--   * Dedupe/lookup index; explicit grants.
--
-- SEQUENCE LOCK: core_emit upserts core_outbox_seq(tenant_id) and holds that row
-- lock until the surrounding transaction ends, serializing concurrent writers of
-- ONE tenant on the sequence allocation. Triggers therefore emit as the LAST
-- thing a statement does; application transactions that touch several rows
-- should keep the transaction short and write the business rows first.
-- ============================================================================

-- ---- config flag -----------------------------------------------------------
create table if not exists public.core_config (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);
alter table public.core_config enable row level security;
alter table public.core_config force row level security;

create or replace function public.core_set_outbox_enabled(p_enabled boolean)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.core_config (key, value, updated_at)
  values ('outbox_enabled', case when p_enabled then 'true' else 'false' end, now())
  on conflict (key) do update set value = excluded.value, updated_at = now();
$$;

create or replace function public.core_outbox_enabled()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select value = 'true' from public.core_config where key = 'outbox_enabled'), false);
$$;

-- ---- emitter honours the flag ----------------------------------------------
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
  if not public.core_outbox_enabled() then
    return;
  end if;

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

-- ---- claim counts the attempt ----------------------------------------------
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
     set next_attempt_at = now() + make_interval(secs => p_lease_seconds),
         attempts = o.attempts + 1
    from due
   where o.id = due.id
  returning o.*;
$$;

-- ---- retention ---------------------------------------------------------------
create or replace function public.core_outbox_prune()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.core_outbox
   where (status = 'delivered' and delivered_at < now() - interval '7 days')
      or (status = 'dead' and occurred_at < now() - interval '30 days');
  update public.core_outbox
     set status = 'dead', last_error = 'expired'
   where status = 'pending' and occurred_at < now() - interval '3 days';
  update public.core_outbox
     set row_snapshot = null
   where status in ('delivered', 'dead') and row_snapshot is not null;
end;
$$;

-- ---- index for coalescing / lookups ------------------------------------------
create index if not exists core_outbox_pending_subject_idx
  on public.core_outbox (tenant_id, event_type, subject_id)
  where status = 'pending';

-- ---- orders: draft semantics + minimal snapshot --------------------------------
create or replace function public.core_trg_orders()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row jsonb := jsonb_build_object('id', new.id, 'status', new.status);
  v_changes jsonb;
begin
  if tg_op = 'INSERT' then
    if new.status not in ('draft', 'voided') then
      perform public.core_emit(new.tenant_id, new.location_id, 'order.placed',
        'order', new.id, new.version, null, v_row);
    end if;
    return new;
  end if;

  if new.status is distinct from old.status then
    v_changes := jsonb_build_object('status', jsonb_build_array(old.status, new.status));
    if old.status = 'draft' then
      -- Leaving a hold: announce the order once, as placed. A canceled hold was
      -- never announced, so it emits nothing.
      if new.status <> 'voided' then
        perform public.core_emit(new.tenant_id, new.location_id, 'order.placed',
          'order', new.id, new.version, v_changes, v_row);
      end if;
      return new;
    end if;
    perform public.core_emit(new.tenant_id, new.location_id, 'order.status_changed',
      'order', new.id, new.version, v_changes, v_row);
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
  elsif new.status <> 'draft' and (
        new.totals is distinct from old.totals
     or new.notes is distinct from old.notes
     or new.fulfillment is distinct from old.fulfillment
     or new.discount_cents is distinct from old.discount_cents
     or new.customer_id is distinct from old.customer_id) then
    perform public.core_emit(new.tenant_id, new.location_id, 'order.updated',
      'order', new.id, new.version, null, v_row);
  end if;
  return new;
end;
$$;

-- ---- payments --------------------------------------------------------------------
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
      'payment', new.id, null, v_changes,
      jsonb_build_object('id', new.id, 'status', new.status));
  end if;
  return new;
end;
$$;

-- ---- menu overrides ------------------------------------------------------------------
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
  v_snap jsonb;
begin
  if tg_op = 'DELETE' then
    v_row := old;
    v_old_avail := old.available; v_new_avail := null;
    v_old_price := old.price_cents; v_new_price := null;
  elsif tg_op = 'INSERT' then
    v_row := new;
    v_old_avail := null; v_new_avail := new.available;
    v_old_price := null; v_new_price := new.price_cents;
  else
    v_row := new;
    v_old_avail := old.available; v_new_avail := new.available;
    v_old_price := old.price_cents; v_new_price := new.price_cents;
  end if;

  v_snap := jsonb_build_object(
    'target_type', v_row.target_type,
    'target_id', v_row.target_id,
    'location_id', v_row.location_id);

  if (coalesce(v_old_avail, true)) is distinct from (coalesce(v_new_avail, true)) then
    perform public.core_emit(v_row.tenant_id, v_row.location_id,
      case when coalesce(v_new_avail, true) then 'menu.item.available'
           else 'menu.item.unavailable' end,
      'menu_item', v_row.target_id, null,
      jsonb_build_object('available', jsonb_build_array(coalesce(v_old_avail, true), coalesce(v_new_avail, true))),
      v_snap);
  end if;

  if v_old_price is distinct from v_new_price then
    perform public.core_emit(v_row.tenant_id, v_row.location_id, 'menu.updated',
      'menu', v_row.location_id, null, null,
      jsonb_build_object('changed_item_ids',
        case when v_row.target_type = 'item'
             then jsonb_build_array(v_row.target_id) else '[]'::jsonb end));
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

-- ---- menu structure: coalesce into an UNCLAIMED pending row ----------------------
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
  v_id uuid;
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

  if v_tenant is not null and public.core_outbox_enabled() then
    -- attempts = 0 means no worker has claimed it yet: safe to extend.
    select id into v_id from public.core_outbox
     where tenant_id = v_tenant and event_type = 'menu.updated'
       and subject_type = 'menu' and subject_id = v_tenant
       and status = 'pending' and attempts = 0
     order by sequence desc
     limit 1
     for update skip locked;
    if v_id is not null then
      if v_item is not null then
        update public.core_outbox
           set row_snapshot = jsonb_build_object('changed_item_ids',
             (select coalesce(jsonb_agg(distinct x), '[]'::jsonb)
                from jsonb_array_elements_text(
                  coalesce(row_snapshot -> 'changed_item_ids', '[]'::jsonb)
                  || jsonb_build_array(v_item)) x))
         where id = v_id;
      end if;
    else
      perform public.core_emit(v_tenant, null, 'menu.updated', 'menu', v_tenant, null, null,
        jsonb_build_object('changed_item_ids',
          case when v_item is null then '[]'::jsonb else jsonb_build_array(v_item) end));
    end if;
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

-- ---- locations / settings / customers / staff / shifts / days / deliveries ---------
create or replace function public.core_trg_locations()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if to_jsonb(new) is distinct from to_jsonb(old) then
    perform public.core_emit(new.tenant_id, new.id, 'location.updated',
      'location', new.id, null, null, jsonb_build_object('id', new.id));
  end if;
  return new;
end;
$$;

create or replace function public.core_trg_store_settings()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' or to_jsonb(new) is distinct from to_jsonb(old) then
    perform public.core_emit(new.tenant_id, new.location_id, 'location.updated',
      'location', new.location_id, null, null,
      jsonb_build_object('id', new.location_id));
  end if;
  return new;
end;
$$;

create or replace function public.core_trg_customers()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- ids only: no name/email/phone ever lands in the outbox
  perform public.core_emit(new.tenant_id, null,
    case when tg_op = 'INSERT' then 'customer.created' else 'customer.updated' end,
    'customer', new.id, null, null, jsonb_build_object('id', new.id));
  return new;
end;
$$;

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
  perform public.core_emit(new.tenant_id, null, v_type, 'staff', new.id, null, null,
    jsonb_build_object('id', new.id));
  return new;
end;
$$;

create or replace function public.core_trg_shifts()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    perform public.core_emit(new.tenant_id, new.location_id, 'drawer_session.opened',
      'drawer_session', new.id, null, null, jsonb_build_object('id', new.id));
  elsif old.status = 'open' and new.status = 'closed' then
    perform public.core_emit(new.tenant_id, new.location_id, 'drawer_session.closed',
      'drawer_session', new.id, null,
      jsonb_build_object('status', jsonb_build_array(old.status, new.status)),
      jsonb_build_object('id', new.id));
  end if;
  return new;
end;
$$;

create or replace function public.core_trg_business_day_closes()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.core_emit(new.tenant_id, new.location_id, 'business_day.closed',
    'business_day', new.id, null, null,
    jsonb_build_object('location_id', new.location_id, 'business_date', new.business_date));
  return new;
end;
$$;

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
      jsonb_build_object('id', new.id));
  end if;
  return new;
end;
$$;

-- Scrub snapshots already queued by the previous (PII-bearing) triggers.
update public.core_outbox
   set row_snapshot = case
     when event_type like 'customer.%' or event_type like 'staff.%'
          or event_type = 'location.updated' or event_type like 'order.%'
          or event_type like 'payment.%' or event_type = 'delivery.status_changed'
          or event_type like 'drawer_session.%'
       then jsonb_build_object('id', subject_id)
     else row_snapshot end
 where status = 'pending';

-- ---- grants -------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['tenant_settings', 'core_outbox', 'core_outbox_seq', 'core_config']
  loop
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on public.%I from anon', t);
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format('revoke all on public.%I from authenticated', t);
    end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('grant select, insert, update, delete on public.%I to service_role', t);
    end if;
  end loop;

  foreach t in array array[
    'core_set_outbox_enabled(boolean)', 'core_outbox_enabled()',
    'core_outbox_prune()', 'core_outbox_claim(integer, integer)'
  ]
  loop
    execute format('revoke all on function public.%s from public', t);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on function public.%s from anon', t);
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format('revoke all on function public.%s from authenticated', t);
    end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('grant execute on function public.%s to service_role', t);
    end if;
  end loop;
end
$$;
