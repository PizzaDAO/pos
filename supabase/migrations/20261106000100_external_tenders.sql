-- ============================================================================
-- Migration: external_tenders  (pos-v1-gaps, phase 2)
--
-- Storage and one atomic writer for `payments.recordExternal`.
--
--   * payments gets method / processor / processor_ref / collection / staff_id.
--     They are only set on rail = 'external' rows. `processor_ref` is NOT
--     `charge_id` on purpose: charge_id is the Stripe/Coinbase correlation key
--     (webhooks look tenders up by it), and a kiosk's own `pi_...` must never
--     collide with it.
--   * payments_external_ref_uq: one CAPTURED external tender per
--     (tenant, processor, processor_ref). The same real-world payment can never
--     be counted twice, whatever Idempotency-Key a retry arrives with.
--   * core_record_external_tender(): ONE transaction under a row lock on the
--     order: state check, replay check, "nothing changed since the caller
--     validated the amounts" check, duplicate-ref check, insert, and the
--     supersede of a matching pending tender. Two concurrent tenders for one
--     order serialize on the order row, so neither can overshoot the amount due.
--   * core_cancel_order(): a PENDING external tender (money promised, not
--     received: an issued invoice, cash still to collect) is not "in flight" and
--     never blocks a cancel; it is voided with the order. A CAPTURED one still
--     blocks (refund first).
--
-- Additive and live-safe: new nullable columns, a partial unique index on rows
-- that cannot exist yet, a new function, and a replaced function. Needs
-- 20261106000000 (the enum value) applied first.
-- ============================================================================

begin;
set local lock_timeout = '3s';

alter table public.payments add column if not exists method text;
alter table public.payments add column if not exists processor text;
alter table public.payments add column if not exists processor_ref text;
alter table public.payments add column if not exists collection text;
alter table public.payments add column if not exists staff_id uuid;

create unique index if not exists payments_external_ref_uq
  on public.payments (tenant_id, processor, processor_ref)
  where rail = 'external' and status = 'captured' and processor_ref is not null;

-- ---- one atomic external-tender writer ----------------------------------------
--
-- p_recorded_by = {principal_id, module}: derived by the server from the verified
-- token (never from the request body); kept in raw for the audit trail.
-- p_expect = {n, amount, tip, refunded}: what the caller summed over the order's
-- live tenders (pending, authorized, captured, refunded) when it validated the
-- amounts. If the order changed since, nothing is written and the caller
-- re-validates ('stale'). p_status is the STORED status (captured | pending);
-- p_requested_status is what the caller asked for (authorized is stored as
-- pending so it never counts toward the balance).
--
-- Outcomes: ok | exists | duplicate_ref | not_found | invalid_state | stale
create or replace function public.core_record_external_tender(
  p_tenant_id uuid,
  p_order_id uuid,
  p_id uuid,
  p_method text,
  p_processor text,
  p_processor_ref text,
  p_amount integer,
  p_tip integer,
  p_status text,
  p_requested_status text,
  p_collection text,
  p_staff_id uuid,
  p_expect jsonb,
  p_recorded_by jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.orders;
  v_existing public.payments;
  v_dup public.payments;
  v_new public.payments;
  v_n bigint;
  v_amount bigint;
  v_tip bigint;
  v_refunded bigint;
  v_superseded uuid[] := '{}';
begin
  if p_status not in ('captured', 'pending') then
    raise exception 'core_record_external_tender: bad status %', p_status;
  end if;

  select * into v_order from public.orders
   where id = p_order_id and tenant_id = p_tenant_id
   for update;
  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;
  if v_order.status::text in ('voided', 'abandoned', 'refunded') then
    return jsonb_build_object('outcome', 'invalid_state', 'status', v_order.status::text);
  end if;

  -- Replay (or an id used for another order / tenant: the caller tells them apart).
  select * into v_existing from public.payments where id = p_id;
  if found then
    return jsonb_build_object('outcome', 'exists', 'payment', to_jsonb(v_existing));
  end if;

  select count(*), coalesce(sum(amount_cents), 0), coalesce(sum(tip_cents), 0),
         coalesce(sum(refunded_cents), 0)
    into v_n, v_amount, v_tip, v_refunded
    from public.payments
   where order_id = p_order_id
     and status::text in ('pending', 'authorized', 'captured', 'refunded');
  if v_n <> coalesce((p_expect ->> 'n')::bigint, -1)
     or v_amount <> coalesce((p_expect ->> 'amount')::bigint, -1)
     or v_tip <> coalesce((p_expect ->> 'tip')::bigint, -1)
     or v_refunded <> coalesce((p_expect ->> 'refunded')::bigint, -1) then
    return jsonb_build_object('outcome', 'stale');
  end if;

  if p_status = 'captured' and p_processor_ref is not null then
    select * into v_dup from public.payments
     where tenant_id = p_tenant_id and rail::text = 'external'
       and processor = p_processor and processor_ref = p_processor_ref
       and status::text = 'captured'
     limit 1;
    if found then
      return jsonb_build_object('outcome', 'duplicate_ref', 'payment', to_jsonb(v_dup));
    end if;
  end if;

  begin
    insert into public.payments (
      id, order_id, tenant_id, location_id, rail, status, amount_cents, tip_cents,
      application_fee_cents, currency, simulated, raw,
      method, processor, processor_ref, collection, staff_id
    ) values (
      p_id, p_order_id, p_tenant_id, v_order.location_id, 'external',
      p_status::public.payment_status, p_amount, p_tip,
      0, v_order.currency, false,
      jsonb_build_object('requested_status', p_requested_status,
                         'recorded_by', coalesce(p_recorded_by, '{}'::jsonb)),
      p_method, p_processor, p_processor_ref, p_collection, p_staff_id
    ) returning * into v_new;
  exception when unique_violation then
    -- Lost a race on the id or on the captured (processor, ref) index.
    select * into v_existing from public.payments where id = p_id;
    if found then
      return jsonb_build_object('outcome', 'exists', 'payment', to_jsonb(v_existing));
    end if;
    select * into v_dup from public.payments
     where tenant_id = p_tenant_id and rail::text = 'external'
       and processor = p_processor and processor_ref = p_processor_ref
       and status::text = 'captured'
     limit 1;
    if found then
      return jsonb_build_object('outcome', 'duplicate_ref', 'payment', to_jsonb(v_dup));
    end if;
    raise;
  end;

  -- A captured tender with the same processor + ref supersedes a pending one.
  if p_status = 'captured' and p_processor_ref is not null then
    with s as (
      update public.payments
         set status = 'canceled', updated_at = now()
       where order_id = p_order_id and id <> p_id
         and rail::text = 'external' and status::text = 'pending'
         and processor = p_processor and processor_ref = p_processor_ref
      returning id
    )
    select coalesce(array_agg(id), '{}') into v_superseded from s;
  end if;

  return jsonb_build_object(
    'outcome', 'ok',
    'payment', to_jsonb(v_new),
    'superseded', to_jsonb(v_superseded)
  );
end;
$$;

revoke all on function public.core_record_external_tender(
  uuid, uuid, uuid, text, text, text, integer, integer, text, text, text, uuid, jsonb, jsonb
) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.core_record_external_tender(
      uuid, uuid, uuid, text, text, text, integer, integer, text, text, text, uuid, jsonb, jsonb
    ) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.core_record_external_tender(
      uuid, uuid, uuid, text, text, text, integer, integer, text, text, text, uuid, jsonb, jsonb
    ) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.core_record_external_tender(
      uuid, uuid, uuid, text, text, text, integer, integer, text, text, text, uuid, jsonb, jsonb
    ) to service_role;
  end if;
end
$$;

-- ---- /v1 cancel: pending external tenders never block ---------------------------
create or replace function public.core_cancel_order(p_order_id uuid, p_tenant_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.orders;
  v_blocked boolean;
begin
  select * into v_order from public.orders
   where id = p_order_id and tenant_id = p_tenant_id
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if v_order.status = 'voided' then
    return jsonb_build_object('ok', true);
  end if;
  if v_order.status not in ('draft', 'placed', 'paid') then
    return jsonb_build_object('ok', false, 'reason', 'not_cancelable');
  end if;

  -- A pending/authorized tender that is not a stale abandoned attempt blocks the
  -- cancel. A PENDING external tender is a promise (invoice issued, cash still to
  -- collect), not money in flight: it never blocks and is voided below.
  select exists (
    select 1 from public.payments p
     where p.order_id = p_order_id
       and p.status in ('pending', 'authorized', 'requires_action')
       and p.rail::text <> 'external'
       and not (
         p.status in ('pending', 'requires_action')
         and p.charge_id is null
         and p.created_at < now() - interval '15 minutes'
       )
  ) into v_blocked;
  if v_blocked then
    return jsonb_build_object('ok', false, 'reason', 'in_flight');
  end if;

  if exists (
    select 1 from public.payments p
     where p.order_id = p_order_id
       and p.status = 'captured'
       and p.amount_cents + p.tip_cents > p.refunded_cents
  ) then
    return jsonb_build_object('ok', false, 'reason', 'captured');
  end if;

  update public.payments
     set status = 'canceled', updated_at = now()
   where order_id = p_order_id
     and (
       (status in ('pending', 'requires_action')
         and charge_id is null
         and created_at < now() - interval '15 minutes')
       or (rail::text = 'external' and status::text = 'pending')
     );

  update public.orders
     set status = 'voided', hold = null, updated_at = now()
   where id = p_order_id;

  return jsonb_build_object('ok', true);
end;
$$;

commit;

notify pgrst, 'reload schema';
