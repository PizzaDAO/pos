-- ============================================================================
-- Migration: refunds_voids_comps
--
-- Numbered after 20261113000800 (staff admin gate) and 000900-000940 (stored
-- value); it depends on neither.
--
-- Partial refunds (by amount or by item, across tenders), voids, comps and
-- discounts at the till, with reasons, approvals and an audit ledger.
--
--   1. audit_action: order_line_void, order_void, order_comp, order_discount,
--      adjustment_policy_change (own transaction: a new enum value cannot be
--      used in the transaction that adds it; nothing here uses them).
--   2. payments.tip_refunded_cents: the GRATUITY part of refunded_cents (tip
--      refunds are tracked separately from food refunds; who absorbs them is
--      not decided, only recorded). Backfilled TIP LAST (greatest(refunded -
--      amount, 0) capped at the tip), the rule the owner reports in production
--      already use; a writer that bypasses the reservation functions gets the
--      same rule from a BEFORE UPDATE trigger.
--      payments.refund_reserved_cents: room held by PENDING refunds (card /
--      stored value, reserved before the provider is called); not refunded
--      until confirmed.
--   3. reserve_payment_refund(.., p_tip_amount, p_pending, p_covering): the
--      tip part (NULL = tip last), a pending reservation, and whether the order
--      was paid in full when the refund was made (refunds[].covering).
--      confirm_payment_refund turns a pending reservation into a refund;
--      release_payment_refund (refund id required) undoes one, optionally
--      keeping the id as a tombstone.
--   4. orders.adjustments (comps + discounts applied, sum = discount_cents) and
--      store_settings.adjustment_policy (per-location approval thresholds).
--   5. order_adjustments: the ledger (one row per refund / void / comp /
--      discount: who, approved by whom, why, what money moved), RLS forced.
--      begin_order_refund / reopen_order_refund reserve item-refund units
--      under the ORDER row lock; claim_order_adjustment lets one request run at
--      a time; finish_order_adjustment records what a refund moved;
--      apply_order_edit voids lines (whole or split), comps, discounts or the
--      whole order as a compare-and-set on orders.version, re-checking the
--      money under the lock.
--   6. tip events (core_trg_payments, core_tip_backfill_for_order) follow the
--      recorded tip part (else tip last) and skip pending reservations,
--      matching src/lib/core/tips.ts.
--
-- DEPLOY ORDER: migration first, then code (the code calls the new functions
-- and arguments). Live-safe: additive columns with defaults, a new table,
-- replaced functions; lock_timeout bounds every lock.
-- ============================================================================

begin;
set local lock_timeout = '3s';
alter type public.audit_action add value if not exists 'order_line_void';
alter type public.audit_action add value if not exists 'order_void';
alter type public.audit_action add value if not exists 'order_comp';
alter type public.audit_action add value if not exists 'order_discount';
alter type public.audit_action add value if not exists 'adjustment_policy_change';
commit;

begin;
set local lock_timeout = '3s';

-- ---- 2. tip part of refunds; room held by pending refunds -------------------
alter table public.payments
  add column if not exists tip_refunded_cents integer not null default 0,
  -- Room held by PENDING refunds (card / stored value: reserved before the
  -- provider is called). Counts against the caps; NOT refunded yet: status,
  -- refunded_cents and every report move only when the refund is confirmed.
  add column if not exists refund_reserved_cents integer not null default 0;

-- Backfill: tip LAST (only what was refunded beyond the base is tip), the rule
-- the owner reports already in production read refunds with.
update public.payments
   set tip_refunded_cents = least(greatest(refunded_cents - amount_cents, 0), tip_cents)
 where tip_refunded_cents = 0 and refunded_cents > amount_cents and tip_cents > 0;

alter table public.payments drop constraint if exists payments_tip_refunded_bounds;
alter table public.payments add constraint payments_tip_refunded_bounds
  check (tip_refunded_cents >= 0 and tip_refunded_cents <= refunded_cents);
alter table public.payments drop constraint if exists payments_refund_reserved_bounds;
alter table public.payments add constraint payments_refund_reserved_bounds
  check (refund_reserved_cents >= 0);

-- Any writer that moves refunded_cents WITHOUT going through the reservation
-- functions below (which set the split explicitly and say so with the
-- transaction-local flag pos.refund_split) gets the same legacy rule as the
-- backfill: base first, only what is beyond the base is tip ("tip last").
create or replace function public.payments_tip_refund_split()
returns trigger
language plpgsql
as $$
declare
  v_base_left integer;
begin
  if new.refunded_cents is distinct from old.refunded_cents
     and coalesce(current_setting('pos.refund_split', true), '') <> 'explicit' then
    if new.refunded_cents > old.refunded_cents then
      v_base_left := greatest(0, new.amount_cents - (old.refunded_cents - old.tip_refunded_cents));
      new.tip_refunded_cents := least(
        new.tip_cents,
        old.tip_refunded_cents
          + greatest(0, (new.refunded_cents - old.refunded_cents) - v_base_left));
    else
      new.tip_refunded_cents := least(old.tip_refunded_cents, new.refunded_cents);
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists payments_tip_refund_split on public.payments;
create trigger payments_tip_refund_split
  before update of refunded_cents on public.payments
  for each row execute function public.payments_tip_refund_split();

-- The tip part of a tender's PENDING refunds (from refunds[]).
create or replace function public.payment_pending_refund_tip(p_refunds jsonb)
returns integer
language sql
immutable
as $$
  select coalesce(sum(case when (e ->> 'tip_cents') ~ '^[0-9]{1,9}$'
                           then (e ->> 'tip_cents')::integer else 0 end), 0)::integer
    from jsonb_array_elements(case when jsonb_typeof(p_refunds) = 'array'
                                   then p_refunds else '[]'::jsonb end) e
   where e ->> 'state' = 'pending';
$$;

-- ---- 3. refund reservation with an explicit tip part ------------------------
drop function if exists public.reserve_payment_refund(uuid, integer, text, text, text);
drop function if exists public.reserve_payment_refund(uuid, integer, text, text, text, integer);
drop function if exists public.reserve_payment_refund(uuid, integer, text, text, text, integer, boolean);
drop function if exists public.reserve_payment_refund(uuid, integer, text, text, text, integer, boolean, boolean);
drop function if exists public.release_payment_refund(uuid, integer, text);
drop function if exists public.release_payment_refund(uuid, integer, text, boolean);

-- Reserve a refund under the row lock. Caps (pending reservations included):
-- base part <= base left, tip part <= tip left, total <= amount + tip.
-- p_pending: card / stored value -- only HOLD the room (refund_reserved_cents);
-- confirm_payment_refund turns it into a refund. Otherwise it is refunded now
-- (refunded_cents + tip part; status `refunded` once fully refunded).
create or replace function public.reserve_payment_refund(
  p_payment_id uuid,
  p_amount integer,
  p_refund_id text,
  p_processor_ref text default null,
  p_reason text default null,
  p_tip_amount integer default null,
  -- Card / stored value: reserved BEFORE the provider is called, confirmed after.
  p_pending boolean default false,
  -- The order was paid in full when this refund was made (see refund-state.ts).
  p_covering boolean default null
) returns jsonb
language plpgsql
as $$
declare
  r public.payments;
  v_entry text := gen_random_uuid()::text;
  v_tip integer;
  v_pending_tip integer;
  v_base_left integer;
  v_tip_left integer;
  v_pend boolean := coalesce(p_pending, false);
begin
  select * into r from public.payments where id = p_payment_id for update;
  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;
  if p_refund_id is not null and p_refund_id = any (r.refund_ids) then
    return jsonb_build_object('outcome', 'duplicate', 'payment', to_jsonb(r));
  end if;
  v_pending_tip := public.payment_pending_refund_tip(r.refunds);
  v_base_left := greatest(0, r.amount_cents - (r.refunded_cents - r.tip_refunded_cents)
                             - (r.refund_reserved_cents - v_pending_tip));
  v_tip_left := greatest(0, r.tip_cents - r.tip_refunded_cents - v_pending_tip);
  -- Explicit tip part, else the legacy rule: base first, the rest off the tip.
  v_tip := coalesce(p_tip_amount, greatest(0, p_amount - v_base_left));
  if p_amount is null or p_amount <= 0 or v_tip < 0 or v_tip > p_amount
     or r.status not in ('captured', 'authorized')
     or v_tip > v_tip_left
     or p_amount - v_tip > v_base_left
     or r.refunded_cents + r.refund_reserved_cents + p_amount > r.amount_cents + r.tip_cents then
    return jsonb_build_object('outcome', 'exceeds', 'payment', to_jsonb(r));
  end if;

  perform set_config('pos.refund_split', 'explicit', true);
  update public.payments p
     set refunded_cents = p.refunded_cents + case when v_pend then 0 else p_amount end,
         tip_refunded_cents = p.tip_refunded_cents + case when v_pend then 0 else v_tip end,
         refund_reserved_cents = p.refund_reserved_cents + case when v_pend then p_amount else 0 end,
         refund_ids = case
           when p_refund_id is null then p.refund_ids
           else p.refund_ids || p_refund_id
         end,
         refunds = p.refunds || jsonb_build_array(jsonb_build_object(
           'id', v_entry,
           'amount_cents', p_amount,
           'tip_cents', v_tip,
           'at', to_jsonb(now()),
           'processor_ref', p_processor_ref,
           'reason', p_reason,
           'request_id', p_refund_id,
           'state', case when v_pend then 'pending' else 'succeeded' end,
           'status_before', r.status::text,
           'covering', p_covering
         )),
         status = case
           when not v_pend and p.refunded_cents + p_amount >= p.amount_cents + p.tip_cents
             then 'refunded'::public.payment_status
           else p.status
         end,
         updated_at = now()
   where p.id = p_payment_id
  returning * into r;

  return jsonb_build_object('outcome', 'ok', 'payment', to_jsonb(r),
                            'refund_entry_id', v_entry);
end;
$$;

-- The provider accepted a PENDING refund: move it from refund_reserved_cents
-- into refunded_cents (+ its tip part), flip the status when fully refunded and
-- record the provider id. Idempotent (a confirmed entry only gets its ref).
create or replace function public.confirm_payment_refund(
  p_payment_id uuid,
  p_refund_id text,
  p_processor_ref text
) returns jsonb
language plpgsql
as $$
declare
  r public.payments;
  v_idx bigint;
  v_entry jsonb;
  v_amount integer;
  v_tip integer;
  v_was_pending boolean;
begin
  select * into r from public.payments where id = p_payment_id for update;
  if not found then
    return null;
  end if;
  select t.o, t.e into v_idx, v_entry
    from jsonb_array_elements(r.refunds) with ordinality as t(e, o)
   where t.e ->> 'request_id' = p_refund_id
   limit 1;
  if v_idx is null then
    return null;
  end if;
  v_was_pending := v_entry ->> 'state' = 'pending';
  v_amount := (v_entry ->> 'amount_cents')::integer;
  v_tip := coalesce((v_entry ->> 'tip_cents')::integer, 0);

  perform set_config('pos.refund_split', 'explicit', true);
  update public.payments p
     set refunds = (
           select jsonb_agg(
                    case when t.o = v_idx
                         then t.e || jsonb_build_object(
                                'state', 'succeeded',
                                'processor_ref', coalesce(p_processor_ref, t.e ->> 'processor_ref'))
                         else t.e end
                    order by t.o)
             from jsonb_array_elements(p.refunds) with ordinality as t(e, o)),
         refunded_cents = p.refunded_cents + case when v_was_pending then v_amount else 0 end,
         tip_refunded_cents = p.tip_refunded_cents + case when v_was_pending then v_tip else 0 end,
         refund_reserved_cents = greatest(0,
           p.refund_reserved_cents - case when v_was_pending then v_amount else 0 end),
         status = case
           when v_was_pending
                and p.status in ('captured', 'authorized')
                and p.refunded_cents + v_amount >= p.amount_cents + p.tip_cents
             then 'refunded'::public.payment_status
           else p.status
         end,
         updated_at = now()
   where p.id = p_payment_id
  returning * into r;
  return to_jsonb(r);
end;
$$;

-- Undo a reservation (the rail call failed, or the provider later failed the
-- refund): drops the refunds[] entry reserved under p_refund_id (required). A
-- PENDING one only gives its held room back; a confirmed one gives its base
-- and tip part back and restores the tender status it had before.
-- p_tombstone keeps p_refund_id in refund_ids so a failed provider refund's
-- idempotency key is never reused (Stripe would replay the failed refund).
create or replace function public.release_payment_refund(
  p_payment_id uuid,
  p_amount integer,
  p_refund_id text,
  p_tombstone boolean default false
) returns void
language plpgsql
as $$
declare
  v_idx bigint;
  v_entry jsonb;
  v_amount integer;
  v_tip integer;
  v_pending boolean;
  r public.payments;
begin
  if p_refund_id is null then
    raise exception 'release_payment_refund: a refund id is required';
  end if;
  select * into r from public.payments where id = p_payment_id for update;
  if not found then
    return;
  end if;

  select t.o, t.e into v_idx, v_entry
    from jsonb_array_elements(r.refunds) with ordinality as t(e, o)
   where t.e ->> 'request_id' = p_refund_id
   order by t.o desc
   limit 1;
  if v_idx is null then
    return;
  end if;
  v_amount := coalesce((v_entry ->> 'amount_cents')::integer, p_amount);
  v_pending := v_entry ->> 'state' = 'pending';
  v_tip := case
    when (v_entry ->> 'tip_cents') ~ '^[0-9]{1,9}$' then (v_entry ->> 'tip_cents')::integer
    else least(v_amount, r.tip_refunded_cents)
  end;

  perform set_config('pos.refund_split', 'explicit', true);
  update public.payments p
     set refunded_cents = case when v_pending then p.refunded_cents
                               else greatest(0, p.refunded_cents - v_amount) end,
         tip_refunded_cents = case when v_pending then p.tip_refunded_cents
                                   else greatest(0, least(p.tip_refunded_cents - v_tip,
                                                          greatest(0, p.refunded_cents - v_amount))) end,
         refund_reserved_cents = case when v_pending
                                      then greatest(0, p.refund_reserved_cents - v_amount)
                                      else p.refund_reserved_cents end,
         refund_ids = case
           when coalesce(p_tombstone, false) then p.refund_ids
           else array_remove(p.refund_ids, p_refund_id)
         end,
         refunds = coalesce((
           select jsonb_agg(t.e order by t.o)
             from jsonb_array_elements(p.refunds) with ordinality as t(e, o)
            where t.o <> v_idx
         ), '[]'::jsonb),
         status = case
           when not v_pending and p.status = 'refunded' then
             case when v_entry ->> 'status_before' = 'authorized'
                  then 'authorized'::public.payment_status
                  else 'captured'::public.payment_status end
           else p.status
         end,
         updated_at = now()
   where p.id = p_payment_id;
end;
$$;

revoke all on function public.reserve_payment_refund(uuid, integer, text, text, text, integer, boolean, boolean)
  from public, anon, authenticated;
revoke all on function public.payment_pending_refund_tip(jsonb) from public, anon, authenticated;
revoke all on function public.confirm_payment_refund(uuid, text, text)
  from public, anon, authenticated;
revoke all on function public.release_payment_refund(uuid, integer, text, boolean)
  from public, anon, authenticated;

-- ---- 4. comps / discounts on the order; approval thresholds ------------------
alter table public.orders add column if not exists adjustments jsonb;
alter table public.store_settings add column if not exists adjustment_policy jsonb;

-- ---- 5. the ledger ------------------------------------------------------------
create table if not exists public.order_adjustments (
  -- Client-minted request id (idempotency key), unique per order.
  id text not null check (length(id) between 8 and 64),
  order_id uuid not null references public.orders (id) on delete cascade,
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  location_id uuid not null references public.locations (id) on delete cascade,
  kind text not null check (kind in ('refund', 'void_line', 'void_order', 'comp', 'discount')),
  status text not null check (status in ('pending', 'completed', 'partial', 'failed')),
  -- Base (non-tip) money of the action; tip_cents: refunds' tip part (flagged).
  amount_cents integer not null check (amount_cents >= 0),
  tip_cents integer not null default 0 check (tip_cents >= 0),
  lines jsonb not null default '[]'::jsonb,
  allocations jsonb not null default '[]'::jsonb,
  reason_code text not null,
  reason_text text,
  staff_id text,
  actor_user_id text not null,
  approved_by text,
  meta jsonb,
  -- One execution at a time per request (claim_order_adjustment).
  claimed_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (order_id, id)
);
create index if not exists order_adjustments_pending_idx
  on public.order_adjustments (updated_at) where status = 'pending';
create index if not exists order_adjustments_location_idx
  on public.order_adjustments (tenant_id, location_id, created_at desc);

alter table public.order_adjustments enable row level security;
alter table public.order_adjustments force row level security;
drop policy if exists order_adjustments_select on public.order_adjustments;
create policy order_adjustments_select on public.order_adjustments
  for select using (public.is_platform_admin() or public.is_tenant_member(tenant_id));
-- Written only by the service-role driver / the functions below.
revoke insert, update, delete on public.order_adjustments from anon, authenticated;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select, insert, update, delete on public.order_adjustments to service_role;
  end if;
end
$$;

-- Insert one ledger row from its JSON (AdjustmentRecord, snake_case).
create or replace function public.order_adjustment_insert(p jsonb, p_status text)
returns public.order_adjustments
language plpgsql
as $$
declare
  r public.order_adjustments;
begin
  insert into public.order_adjustments (
    id, order_id, tenant_id, location_id, kind, status, amount_cents, tip_cents,
    lines, allocations, reason_code, reason_text, staff_id, actor_user_id,
    approved_by, meta)
  values (
    p ->> 'id',
    (p ->> 'order_id')::uuid,
    (p ->> 'tenant_id')::uuid,
    (p ->> 'location_id')::uuid,
    p ->> 'kind',
    p_status,
    coalesce((p ->> 'amount_cents')::integer, 0),
    coalesce((p ->> 'tip_cents')::integer, 0),
    case when jsonb_typeof(p -> 'lines') = 'array' then p -> 'lines' else '[]'::jsonb end,
    case when jsonb_typeof(p -> 'allocations') = 'array' then p -> 'allocations' else '[]'::jsonb end,
    p ->> 'reason_code',
    p ->> 'reason_text',
    p ->> 'staff_id',
    p ->> 'actor_user_id',
    p ->> 'approved_by',
    case when jsonb_typeof(p -> 'meta') = 'object' then p -> 'meta' end)
  returning * into r;
  return r;
end;
$$;

-- Item-refund quantities, reserved under the order row lock.
create or replace function public.begin_order_refund(p_record jsonb)
returns jsonb
language plpgsql
as $$
declare
  v_order public.orders;
  r public.order_adjustments;
  v_line jsonb;
  v_item public.order_items;
  v_used integer;
  v_avail integer;
  v_qty integer;
begin
  select * into v_order from public.orders
   where id = (p_record ->> 'order_id')::uuid
     for update;
  if not found or v_order.tenant_id <> (p_record ->> 'tenant_id')::uuid then
    return jsonb_build_object('outcome', 'not_found');
  end if;
  select * into r from public.order_adjustments
   where order_id = v_order.id and id = p_record ->> 'id';
  if found then
    return jsonb_build_object('outcome', 'duplicate', 'record', to_jsonb(r));
  end if;

  for v_line in
    select e from jsonb_array_elements(
      case when jsonb_typeof(p_record -> 'lines') = 'array' then p_record -> 'lines'
           else '[]'::jsonb end) e
  loop
    v_qty := coalesce((v_line ->> 'quantity')::integer, 0);
    select * into v_item from public.order_items
     where order_id = v_order.id and id::text = v_line ->> 'line_id';
    if not found or v_item.voided then
      v_avail := 0;
    else
      select coalesce(sum((l ->> 'quantity')::integer), 0) into v_used
        from public.order_adjustments a,
             jsonb_array_elements(a.lines) l
       where a.order_id = v_order.id
         and a.kind = 'refund'
         and a.status <> 'failed'
         and l ->> 'line_id' = v_line ->> 'line_id';
      v_avail := greatest(0, v_item.quantity - v_used);
    end if;
    if v_qty <= 0 or v_qty > v_avail then
      return jsonb_build_object('outcome', 'exceeds',
                                'line_id', v_line ->> 'line_id',
                                'available', v_avail);
    end if;
  end loop;

  r := public.order_adjustment_insert(p_record, 'pending');
  return jsonb_build_object('outcome', 'ok', 'record', to_jsonb(r));
end;
$$;

-- One execution of a request at a time (a doubled request must not run its
-- refunds twice in parallel): claim until p_until; refused while another
-- unexpired claim holds it.
create or replace function public.claim_order_adjustment(
  p_order_id uuid,
  p_id text,
  p_until timestamptz
) returns boolean
language plpgsql
as $$
begin
  update public.order_adjustments
     set claimed_until = p_until
   where order_id = p_order_id and id = p_id
     and (claimed_until is null or claimed_until < now());
  return found;
end;
$$;

-- Resume a FAILED item refund under its own id: take its units again under the
-- order row lock (exceeds when another refund took them meanwhile).
create or replace function public.reopen_order_refund(p_order_id uuid, p_id text)
returns jsonb
language plpgsql
as $$
declare
  v_order public.orders;
  r public.order_adjustments;
  v_line jsonb;
  v_item public.order_items;
  v_used integer;
  v_avail integer;
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;
  select * into r from public.order_adjustments where order_id = p_order_id and id = p_id;
  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;
  if r.status <> 'failed' then
    return jsonb_build_object('outcome', 'duplicate', 'record', to_jsonb(r));
  end if;
  for v_line in select e from jsonb_array_elements(r.lines) e loop
    select * into v_item from public.order_items
     where order_id = p_order_id and id::text = v_line ->> 'line_id';
    if not found or v_item.voided then
      v_avail := 0;
    else
      select coalesce(sum((l ->> 'quantity')::integer), 0) into v_used
        from public.order_adjustments a, jsonb_array_elements(a.lines) l
       where a.order_id = p_order_id and a.kind = 'refund' and a.status <> 'failed'
         and l ->> 'line_id' = v_line ->> 'line_id';
      v_avail := greatest(0, v_item.quantity - v_used);
    end if;
    if (v_line ->> 'quantity')::integer > v_avail then
      return jsonb_build_object('outcome', 'exceeds', 'line_id', v_line ->> 'line_id',
                                'available', v_avail);
    end if;
  end loop;
  update public.order_adjustments
     set status = 'pending', updated_at = now()
   where order_id = p_order_id and id = p_id
  returning * into r;
  return jsonb_build_object('outcome', 'ok', 'record', to_jsonb(r));
end;
$$;

create or replace function public.finish_order_adjustment(
  p_order_id uuid,
  p_id text,
  p_status text,
  p_allocations jsonb,
  p_meta jsonb default null
) returns jsonb
language plpgsql
as $$
declare
  r public.order_adjustments;
begin
  update public.order_adjustments a
     set status = p_status,
         allocations = case when jsonb_typeof(p_allocations) = 'array'
                            then p_allocations else a.allocations end,
         meta = case when jsonb_typeof(p_meta) = 'object'
                     then coalesce(a.meta, '{}'::jsonb) || p_meta else a.meta end,
         claimed_until = null,
         updated_at = now()
   where a.order_id = p_order_id and a.id = p_id
  returning * into r;
  if not found then
    return null;
  end if;
  return to_jsonb(r);
end;
$$;

-- Voids / comps / discounts: compare-and-set on orders.version, money re-checked
-- under the order row lock, ledger row in the same transaction. p_write is the
-- OrderEditWrite JSON (src/lib/db/adjustment-types.ts).
create or replace function public.apply_order_edit(p_write jsonb)
returns jsonb
language plpgsql
as $$
declare
  v_order public.orders;
  r public.order_adjustments;
  v_rec jsonb := p_write -> 'record';
  v_void_order boolean := coalesce((p_write ->> 'voidOrder')::boolean, false);
  v_due bigint;
  v_covered bigint;
  v_split jsonb;
begin
  select * into v_order from public.orders
   where id = (p_write ->> 'orderId')::uuid
     for update;
  if not found or v_order.tenant_id <> (p_write ->> 'tenantId')::uuid then
    return jsonb_build_object('outcome', 'not_found');
  end if;
  select * into r from public.order_adjustments
   where order_id = v_order.id and id = v_rec ->> 'id';
  if found then
    return jsonb_build_object('outcome', 'duplicate', 'record', to_jsonb(r));
  end if;
  if coalesce(v_order.version, 1) <> (p_write ->> 'expectVersion')::integer then
    return jsonb_build_object('outcome', 'stale');
  end if;
  if v_order.status::text not in
     ('draft', 'placed', 'paid', 'in_kitchen', 'ready', 'recall', 'out_for_delivery', 'completed') then
    return jsonb_build_object('outcome', 'invalid_state', 'reason', 'order is ' || v_order.status::text);
  end if;

  -- Marketplace orders and stored-value (gift card) sales are not re-priced or
  -- voided here.
  if coalesce(v_order.source ->> 'channel', '') = 'marketplace'
     or coalesce(v_order.channel::text, '') = 'marketplace'
     or coalesce(v_order.core_ext ? 'stored_value', false) then
    return jsonb_build_object('outcome', 'invalid_state', 'reason', 'not_adjustable');
  end if;
  -- Once money went back, the price is settled history: no comp / discount /
  -- line void (a whole-order void is still allowed).
  if not v_void_order and exists (
       select 1 from public.payments p
        where p.order_id = v_order.id
          and (p.refunded_cents > 0 or p.refund_reserved_cents > 0)) then
    return jsonb_build_object('outcome', 'invalid_state', 'reason', 'refund_exists');
  end if;

  if v_void_order then
    if exists (
      select 1 from public.payments p
       where p.order_id = v_order.id
         and p.status::text in ('pending', 'authorized', 'requires_action')
         and not (p.rail::text = 'external' and p.status::text = 'pending')) then
      return jsonb_build_object('outcome', 'invalid_state', 'reason', 'in_flight');
    end if;
    if exists (
      select 1 from public.payments p
       where p.order_id = v_order.id and p.status::text = 'captured'
         and p.amount_cents + p.tip_cents > p.refunded_cents) then
      return jsonb_build_object('outcome', 'invalid_state', 'reason', 'captured');
    end if;
  else
    -- Tenders must still fit the new amount due (else: refund instead).
    v_due := greatest(0,
      coalesce((p_write -> 'totals' ->> 'total_cents')::bigint, 0)
      - coalesce((p_write -> 'totals' ->> 'tip_cents')::bigint, 0));
    select coalesce(sum(case
             when p.status::text = 'pending' then p.amount_cents
             else greatest(0, p.amount_cents - (p.refunded_cents - p.tip_refunded_cents))
           end), 0)
      into v_covered
      from public.payments p
     where p.order_id = v_order.id
       and upper(p.currency) = upper(v_order.currency)
       and p.status::text in ('pending', 'authorized', 'captured');
    if v_covered > v_due then
      return jsonb_build_object('outcome', 'invalid_state', 'reason', 'paid_exceeds');
    end if;
  end if;

  -- Whole lines (order_items_stamp_void stamps voided_at + status_at_void).
  update public.order_items
     set voided = true, line_total_cents = 0
   where order_id = v_order.id
     and not voided
     and id::text in (
       select jsonb_array_elements_text(
         case when jsonb_typeof(p_write -> 'voidLineIds') = 'array'
              then p_write -> 'voidLineIds' else '[]'::jsonb end));

  -- Partial voids: a voided copy carries the voided units (+ its modifiers and
  -- the original fire time, so the kitchen sees it was already sent).
  for v_split in
    select e from jsonb_array_elements(
      case when jsonb_typeof(p_write -> 'splits') = 'array' then p_write -> 'splits'
           else '[]'::jsonb end) e
  loop
    insert into public.order_items (
      id, order_id, item_id, item_name, station, size_id, size_name,
      base_price_cents, quantity, notes, voided, unit_price_cents,
      line_total_cents, sort_order)
    select (v_split ->> 'new_line_id')::uuid, s.order_id, s.item_id, s.item_name,
           s.station, s.size_id, s.size_name, s.base_price_cents,
           (v_split ->> 'void_quantity')::integer, s.notes, true, s.unit_price_cents,
           0, s.sort_order
      from public.order_items s
     where s.id = (v_split ->> 'line_id')::uuid and s.order_id = v_order.id;
    update public.order_items n
       set fired_at = s.fired_at
      from public.order_items s
     where n.id = (v_split ->> 'new_line_id')::uuid
       and s.id = (v_split ->> 'line_id')::uuid;
    insert into public.order_item_modifiers (
      order_item_id, group_id, group_name, modifier_id, modifier_name,
      price_cents, placement, sort_order)
    select (v_split ->> 'new_line_id')::uuid, m.group_id, m.group_name,
           m.modifier_id, m.modifier_name, m.price_cents, m.placement, m.sort_order
      from public.order_item_modifiers m
     where m.order_item_id = (v_split ->> 'line_id')::uuid;
    update public.order_items
       set quantity = (v_split ->> 'keep_quantity')::integer,
           line_total_cents = unit_price_cents * (v_split ->> 'keep_quantity')::integer
     where id = (v_split ->> 'line_id')::uuid and order_id = v_order.id;
  end loop;

  update public.orders o
     set totals = p_write -> 'totals',
         discount_cents = coalesce((p_write ->> 'discountCents')::integer, o.discount_cents),
         adjustments = case when jsonb_typeof(p_write -> 'adjustments') = 'array'
                            then p_write -> 'adjustments' else o.adjustments end,
         status = case when v_void_order then 'voided'::public.order_status else o.status end,
         updated_at = now()
   where o.id = v_order.id;

  r := public.order_adjustment_insert(v_rec, coalesce(v_rec ->> 'status', 'completed'));
  return jsonb_build_object('outcome', 'ok', 'record', to_jsonb(r));
end;
$$;

revoke all on function public.order_adjustment_insert(jsonb, text) from public, anon, authenticated;
revoke all on function public.begin_order_refund(jsonb) from public, anon, authenticated;
revoke all on function public.finish_order_adjustment(uuid, text, text, jsonb, jsonb)
  from public, anon, authenticated;
revoke all on function public.apply_order_edit(jsonb) from public, anon, authenticated;
revoke all on function public.reopen_order_refund(uuid, text) from public, anon, authenticated;
revoke all on function public.claim_order_adjustment(uuid, text, timestamptz) from public, anon, authenticated;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.reserve_payment_refund(uuid, integer, text, text, text, integer, boolean, boolean)
      to service_role;
    grant execute on function public.payment_pending_refund_tip(jsonb) to service_role;
    grant execute on function public.confirm_payment_refund(uuid, text, text) to service_role;
    grant execute on function public.release_payment_refund(uuid, integer, text, boolean) to service_role;
    grant execute on function public.reopen_order_refund(uuid, text) to service_role;
    grant execute on function public.claim_order_adjustment(uuid, text, timestamptz) to service_role;
    grant execute on function public.order_adjustment_insert(jsonb, text) to service_role;
    grant execute on function public.begin_order_refund(jsonb) to service_role;
    grant execute on function public.finish_order_adjustment(uuid, text, text, jsonb, jsonb)
      to service_role;
    grant execute on function public.apply_order_edit(jsonb) to service_role;
  end if;
end
$$;

-- ---- 6. tip events follow the recorded tip part ------------------------------
create or replace function public.core_tip_backfill_for_order(p_order uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  e jsonb;
  v_tip bigint;
  v_any boolean := false;
  v_first_id uuid;
  v_first_tenant uuid;
  v_first_loc uuid;
  v_known bigint;
  v_amt bigint;
  v_part bigint;
  v_prev bigint;
  v_cum bigint;
  v_run bigint;
begin
  begin
    select public.core_order_tip_cents(o.totals) into v_tip
      from public.orders o where o.id = p_order;
    for r in
      select p.id, p.tenant_id, p.location_id, p.amount_cents, p.tip_cents, p.refunded_cents, p.refunds
        from public.payments p
       where p.order_id = p_order and p.status::text in ('captured', 'refunded')
       order by p.created_at, p.id
    loop
      if v_first_id is null then
        v_first_id := r.id; v_first_tenant := r.tenant_id; v_first_loc := r.location_id;
      end if;
      if r.tip_cents > 0 then
        v_any := true;
        perform public.core_emit(r.tenant_id, r.location_id, 'tip.recorded',
          'payment', r.id, null, null,
          jsonb_build_object('fact_id', 'tip_' || r.id::text, 'order_id', p_order));
        -- Refunds that happened before the hub saw the order: one tip.adjusted per
        -- step that moved the tip, with the cumulative ids tips.ts derives
        -- (tipRefundSteps): an entry's own tip_cents, else (older entries, and an
        -- unrecorded remainder, which comes first) base first, tip last. Pending
        -- (unconfirmed) reservations are not refunds.
        if r.refunded_cents > 0 then
          v_known := coalesce((
            select sum(case when (x ->> 'amount_cents') ~ '^[0-9]{1,12}$'
                            then (x ->> 'amount_cents')::bigint else 0 end)
              from jsonb_array_elements(
                     case when jsonb_typeof(r.refunds) = 'array' then r.refunds else '[]'::jsonb end) x
             where coalesce(x ->> 'state', '') <> 'pending'), 0);
          v_cum := 0;
          v_prev := 0;
          v_run := 0;
          if r.refunded_cents > v_known then
            v_run := r.refunded_cents - v_known;
            v_cum := least(greatest(v_run - r.amount_cents, 0), r.tip_cents);
            if v_cum > v_prev then
              perform public.core_emit(r.tenant_id, r.location_id, 'tip.adjusted',
                'payment', r.id, null, null,
                jsonb_build_object('fact_id', 'tipadj_' || r.id::text || '_c' || v_cum,
                                   'order_id', p_order));
              v_prev := v_cum;
            end if;
          end if;
          for e in
            select t.x from jsonb_array_elements(
              case when jsonb_typeof(r.refunds) = 'array' then r.refunds else '[]'::jsonb end)
              with ordinality as t(x, n)
             where coalesce(t.x ->> 'state', '') <> 'pending'
             order by t.n
          loop
            v_amt := case when (e ->> 'amount_cents') ~ '^[0-9]{1,12}$'
                          then (e ->> 'amount_cents')::bigint else 0 end;
            v_run := v_run + v_amt;
            v_part := case
              when (e ->> 'tip_cents') ~ '^[0-9]{1,12}$'
                then least((e ->> 'tip_cents')::bigint, greatest(0, r.tip_cents - v_cum))
              else least(greatest(0, r.tip_cents - v_cum),
                         greatest(0, v_run - r.amount_cents - v_cum))
            end;
            v_cum := v_cum + greatest(0, v_part);
            if v_cum > v_prev then
              perform public.core_emit(r.tenant_id, r.location_id, 'tip.adjusted',
                'payment', r.id, null, null,
                jsonb_build_object('fact_id', 'tipadj_' || r.id::text || '_c' || v_cum,
                                   'order_id', p_order));
              v_prev := v_cum;
            end if;
          end loop;
        end if;
      end if;
    end loop;
    if not v_any and coalesce(v_tip, 0) > 0 and v_first_id is not null then
      perform public.core_emit(v_first_tenant, v_first_loc, 'tip.recorded',
        'payment', v_first_id, null, null,
        jsonb_build_object('fact_id', 'tip_online_' || p_order::text, 'order_id', p_order));
      -- Every settled tender already refunded in full: the online tip is reversed.
      if not exists (
           select 1 from public.payments p
            where p.order_id = p_order and p.status::text in ('captured', 'refunded')
              and p.refunded_cents < p.amount_cents + p.tip_cents) then
        perform public.core_emit(v_first_tenant, v_first_loc, 'tip.adjusted',
          'payment', v_first_id, null, null,
          jsonb_build_object('fact_id', 'tipadj_online_' || p_order::text || '_full',
                             'order_id', p_order));
      end if;
    end if;
  exception when others then
    raise warning 'core_tip_backfill_for_order(%): tip events skipped (%: %)',
      p_order, sqlstate, sqlerrm;
  end;
end;
$$;

revoke all on function public.core_tip_backfill_for_order(uuid) from public, anon, authenticated;

create or replace function public.core_trg_payments()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_type text;
  v_changes jsonb;
  v_announced boolean;
  v_strict boolean;
  v_retract uuid;
  v_order_tip bigint;
  v_cum_new bigint;
  v_cum_old bigint;
begin
  -- The hub has seen the order (core_announced), OR it is a held /v1 order
  -- (draft + hold): its payment must reach the hub BEFORE the order is released,
  -- so a consumer (pizza-mcp) books the payment, then sees order.placed. Shop
  -- awaiting_payment orders and parked in-store drafts (no hold) stay suppressed.
  select (coalesce(o.core_announced, false)
          or (o.status::text = 'draft' and o.hold is not null)),
         coalesce(o.core_announced, false)
    into v_announced, v_strict from public.orders o where o.id = new.order_id;
  if not coalesce(v_announced, false) then
    return new;
  end if;

  if tg_op = 'UPDATE' and new.refunded_cents < old.refunded_cents then
    -- A released (failed) refund reservation.
    if public.core_outbox_enabled() then
      select id into v_retract from public.core_outbox
       where tenant_id = new.tenant_id and subject_type = 'payment'
         and subject_id = new.id and event_type = 'payment.refunded'
         and status = 'pending' and attempts = 0
         and jsonb_typeof(changes -> 'refunded_cents') = 'array'
         and (changes -> 'refunded_cents' ->> 1)::bigint
             - (changes -> 'refunded_cents' ->> 0)::bigint
             = old.refunded_cents - new.refunded_cents
       order by sequence desc
       limit 1
       for update skip locked;
      if v_retract is not null then
        update public.core_outbox
           set status = 'dead', last_error = 'retracted: refund released'
         where id = v_retract;
        return new;
      end if;
    end if;
    v_changes := jsonb_build_object('refunded_cents',
      jsonb_build_array(old.refunded_cents, new.refunded_cents));
    if new.status is distinct from old.status then
      v_changes := v_changes || jsonb_build_object('status',
        jsonb_build_array(old.status, new.status));
    end if;
    v_type := case new.status::text
      when 'authorized' then 'payment.authorized'
      when 'captured' then 'payment.captured'
      else null end;
  elsif tg_op = 'INSERT' then
    v_type := case new.status::text
      when 'authorized' then 'payment.authorized'
      when 'captured' then 'payment.captured'
      when 'failed' then 'payment.failed'
      when 'refunded' then 'payment.refunded'
      else null end;
  elsif new.status is distinct from old.status then
    v_changes := jsonb_build_object('status', jsonb_build_array(old.status, new.status));
    if new.refunded_cents is distinct from old.refunded_cents then
      v_changes := v_changes || jsonb_build_object('refunded_cents',
        jsonb_build_array(old.refunded_cents, new.refunded_cents));
    end if;
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

  -- ---- tip facts (tip.recorded / tip.adjusted) -----------------------------
  -- Only for an order the hub has already seen (the backfill in core_trg_orders
  -- covers earlier tenders), and only on a transition. Own subtransaction: a
  -- failure here must never fail the payment write.
  if v_strict and (
       (new.status::text = 'captured'
        and (tg_op = 'INSERT' or old.status::text not in ('captured', 'refunded')))
    or (tg_op = 'UPDATE'
        and new.refunded_cents > old.refunded_cents
        and new.status::text in ('captured', 'refunded'))) then
    begin
      -- 1. A tender becomes captured.
      if new.status::text = 'captured'
         and (tg_op = 'INSERT' or old.status::text not in ('captured', 'refunded')) then
        if new.tip_cents > 0 then
          perform public.core_emit(new.tenant_id, new.location_id, 'tip.recorded',
            'payment', new.id, null, null,
            jsonb_build_object('fact_id', 'tip_' || new.id::text, 'order_id', new.order_id));
        else
          -- Possibly the order-level online fact: only the FIRST settled tender
          -- of the order. Serialise concurrent first captures so exactly one of
          -- them sees "no other settled tender".
          perform pg_advisory_xact_lock(
            hashtextextended('core_tip_online:' || new.order_id::text, 0));
          select public.core_order_tip_cents(o.totals) into v_order_tip
            from public.orders o where o.id = new.order_id;
          if coalesce(v_order_tip, 0) > 0
             and not exists (
               select 1 from public.payments p
                where p.order_id = new.order_id and p.id <> new.id
                  and p.status::text in ('captured', 'refunded')
             ) then
            perform public.core_emit(new.tenant_id, new.location_id, 'tip.recorded',
              'payment', new.id, null, null,
              jsonb_build_object('fact_id', 'tip_online_' || new.order_id::text,
                                 'order_id', new.order_id));
          end if;
        end if;
      end if;

      -- 2. A refund on a settled tender.
      if tg_op = 'UPDATE'
         and new.refunded_cents > old.refunded_cents
         and new.status::text in ('captured', 'refunded') then
        if new.tip_cents > 0 then
          -- The tip part of refunds is recorded explicitly (tip_refunded_cents);
          -- a food-only refund leaves it unchanged and emits no tip event.
          v_cum_new := least(new.tip_refunded_cents, new.tip_cents);
          v_cum_old := least(old.tip_refunded_cents, new.tip_cents);
          if v_cum_new > v_cum_old then
            perform public.core_emit(new.tenant_id, new.location_id, 'tip.adjusted',
              'payment', new.id, null, null,
              jsonb_build_object('fact_id',
                                 'tipadj_' || new.id::text || '_c' || v_cum_new,
                                 'order_id', new.order_id));
          end if;
        else
          -- Online tip: reversed once, when every settled tender is refunded in full.
          perform pg_advisory_xact_lock(
            hashtextextended('core_tip_online:' || new.order_id::text, 0));
          select public.core_order_tip_cents(o.totals) into v_order_tip
            from public.orders o where o.id = new.order_id;
          if coalesce(v_order_tip, 0) > 0
             and not exists (
               select 1 from public.payments p
                where p.order_id = new.order_id
                  and p.status::text in ('captured', 'refunded') and p.tip_cents > 0)
             and not exists (
               select 1 from public.payments p
                where p.order_id = new.order_id
                  and p.status::text in ('captured', 'refunded')
                  and p.refunded_cents < p.amount_cents + p.tip_cents) then
            perform public.core_emit(new.tenant_id, new.location_id, 'tip.adjusted',
              'payment', new.id, null, null,
              jsonb_build_object('fact_id', 'tipadj_online_' || new.order_id::text || '_full',
                                 'order_id', new.order_id));
          end if;
        end if;
      end if;
    exception when others then
      raise warning 'core_trg_payments: tip events skipped for payment % (%: %)',
        new.id, sqlstate, sqlerrm;
    end;
  end if;
  return new;
end;
$$;

commit;

notify pgrst, 'reload schema';
