-- ============================================================================
-- Migration: tender_settlement_guards
--
-- Follow-up to 20260610000000_atomic_tenders_refunds (left untouched because it
-- may already be applied somewhere). Redefines its functions and adds:
--
--   * search_path = public, pg_temp on every SECURITY DEFINER function (no
--     pg_temp object shadowing).
--   * reserve_payment: NOT NULL columns default when keys are omitted (no NULL
--     inserts), created_at is server time, and STALE UNSETTLED tenders
--     (pending/requires_action, no charge_id, older than 15 minutes — an
--     abandoned or crashed attempt) no longer count toward the balance, so they
--     can't block an order forever.
--   * reserve_refund: the tender must be SETTLED (captured/authorized; a
--     partially refunded tender stays `captured`) before any refund is
--     reserved — no refunds of pending/failed/canceled/refunded tenders.
--   * void_tender: cancel an unsettled (pending/requires_action) tender under a
--     row lock so it stops counting toward the balance.
--   * subscriptions.last_event_created: the Stripe `event.created` of the last
--     billing webhook applied, so out-of-order events are ignored.
--
-- Keep STALE_TENDER_TTL in sync with STALE_TENDER_TTL_MS in
-- src/lib/payments/balance.ts. IDEMPOTENT (create or replace / if not exists).
-- ============================================================================

alter table public.subscriptions
  add column if not exists last_event_created bigint;

-- ----------------------------------------------------------------------------
-- reserve_payment(p_payment jsonb) → jsonb   (same contract as before)
-- ----------------------------------------------------------------------------
create or replace function public.reserve_payment(p_payment jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid := (p_payment ->> 'id')::uuid;
  v_amount bigint := coalesce((p_payment ->> 'amount_cents')::bigint, 0);
  v_order public.orders%rowtype;
  v_existing public.payments%rowtype;
  v_covered bigint;
  v_total bigint;
begin
  if v_id is null then
    raise exception 'payment id is required';
  end if;

  select * into v_existing from public.payments where id = v_id;
  if found then
    return jsonb_build_object('ok', true, 'created', false,
                              'payment', to_jsonb(v_existing));
  end if;

  -- Serialize every tender for this order behind the order row lock.
  select * into v_order from public.orders
   where id = (p_payment ->> 'order_id')::uuid
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'order_not_found',
                              'balance_cents', 0);
  end if;
  if v_order.tenant_id is distinct from (p_payment ->> 'tenant_id')::uuid
     or v_order.location_id is distinct from (p_payment ->> 'location_id')::uuid then
    return jsonb_build_object('ok', false, 'reason', 'order_mismatch',
                              'balance_cents', 0);
  end if;
  if v_order.status in ('voided', 'refunded') then
    return jsonb_build_object('ok', false, 'reason', 'order_closed',
                              'balance_cents', 0);
  end if;

  select * into v_existing from public.payments where id = v_id;
  if found then
    return jsonb_build_object('ok', true, 'created', false,
                              'payment', to_jsonb(v_existing));
  end if;

  v_total := coalesce((v_order.totals ->> 'total_cents')::bigint, 0);
  select coalesce(sum(amount_cents), 0) into v_covered
    from public.payments
   where order_id = v_order.id
     and status not in ('failed', 'canceled')
     -- abandoned attempts (never reached a rail) stop holding the balance
     and not (status in ('pending', 'requires_action')
              and charge_id is null
              and created_at < now() - interval '15 minutes');

  if v_amount <= 0 or v_covered + v_amount > v_total then
    return jsonb_build_object('ok', false, 'reason', 'exceeds_balance',
                              'balance_cents', greatest(v_total - v_covered, 0));
  end if;

  insert into public.payments (
    id, order_id, tenant_id, location_id, rail, status,
    amount_cents, tip_cents, application_fee_cents, currency,
    charge_id, connect_account_id, crypto_tx_hash, crypto_chain,
    cash_tendered_cents, cash_change_cents, refunded_cents, simulated, raw,
    created_at, updated_at
  ) values (
    v_id,
    v_order.id,
    v_order.tenant_id,
    v_order.location_id,
    (p_payment ->> 'rail')::public.payment_rail,
    coalesce((p_payment ->> 'status')::public.payment_status, 'pending'),
    v_amount,
    coalesce((p_payment ->> 'tip_cents')::integer, 0),
    coalesce((p_payment ->> 'application_fee_cents')::integer, 0),
    coalesce(p_payment ->> 'currency', v_order.currency),
    p_payment ->> 'charge_id',
    p_payment ->> 'connect_account_id',
    p_payment ->> 'crypto_tx_hash',
    p_payment ->> 'crypto_chain',
    (p_payment ->> 'cash_tendered_cents')::integer,
    (p_payment ->> 'cash_change_cents')::integer,
    coalesce((p_payment ->> 'refunded_cents')::integer, 0),
    coalesce((p_payment ->> 'simulated')::boolean, true),
    case when jsonb_typeof(p_payment -> 'raw') = 'object'
         then p_payment -> 'raw' else null end,
    now(),
    now()
  )
  returning * into v_existing;

  return jsonb_build_object('ok', true, 'created', true,
                            'payment', to_jsonb(v_existing));
end;
$$;

-- ----------------------------------------------------------------------------
-- reserve_refund(...) → jsonb   (adds reason 'not_settled')
-- ----------------------------------------------------------------------------
create or replace function public.reserve_refund(
  p_refund_id uuid,
  p_payment_id uuid,
  p_amount_cents integer,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_payment public.payments%rowtype;
  v_refund public.payment_refunds%rowtype;
  v_pending bigint;
  v_refundable bigint;
begin
  select * into v_refund from public.payment_refunds where id = p_refund_id;
  if found then
    if v_refund.payment_id <> p_payment_id then
      return jsonb_build_object('ok', false, 'reason', 'refund_mismatch',
                                'refundable_cents', 0);
    end if;
    return jsonb_build_object('ok', true, 'created', false,
                              'refund', to_jsonb(v_refund));
  end if;

  select * into v_payment from public.payments
   where id = p_payment_id
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'payment_not_found',
                              'refundable_cents', 0);
  end if;

  select * into v_refund from public.payment_refunds where id = p_refund_id;
  if found then
    return jsonb_build_object('ok', true, 'created', false,
                              'refund', to_jsonb(v_refund));
  end if;

  -- Only money that actually settled can be refunded.
  if v_payment.status not in ('captured', 'authorized') then
    return jsonb_build_object('ok', false, 'reason', 'not_settled',
                              'refundable_cents', 0);
  end if;

  select coalesce(sum(amount_cents), 0) into v_pending
    from public.payment_refunds
   where payment_id = p_payment_id and status = 'pending';
  v_refundable := v_payment.amount_cents + v_payment.tip_cents
                  - v_payment.refunded_cents - v_pending;

  if p_amount_cents is null or p_amount_cents <= 0
     or p_amount_cents > v_refundable then
    return jsonb_build_object('ok', false, 'reason', 'exceeds_refundable',
                              'refundable_cents', greatest(v_refundable, 0));
  end if;

  insert into public.payment_refunds
    (id, payment_id, tenant_id, amount_cents, status, reason)
  values
    (p_refund_id, p_payment_id, v_payment.tenant_id, p_amount_cents,
     'pending', p_reason)
  returning * into v_refund;

  return jsonb_build_object('ok', true, 'created', true,
                            'refund', to_jsonb(v_refund));
end;
$$;

-- ----------------------------------------------------------------------------
-- finalize_refund(...) → payments row (unchanged logic; pinned search_path)
-- ----------------------------------------------------------------------------
create or replace function public.finalize_refund(
  p_refund_id uuid,
  p_status text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_refund public.payment_refunds%rowtype;
  v_payment public.payments%rowtype;
begin
  if p_status not in ('succeeded', 'failed') then
    raise exception 'invalid refund status %', p_status;
  end if;

  select * into v_refund from public.payment_refunds where id = p_refund_id;
  if not found then
    return null;
  end if;

  select * into v_payment from public.payments
   where id = v_refund.payment_id
   for update;

  select * into v_refund from public.payment_refunds
   where id = p_refund_id
   for update;

  if v_refund.status = 'pending' then
    update public.payment_refunds
       set status = p_status, updated_at = now()
     where id = p_refund_id;

    if p_status = 'succeeded' then
      update public.payments
         set refunded_cents = refunded_cents + v_refund.amount_cents,
             status = case
               when refunded_cents + v_refund.amount_cents
                    >= amount_cents + tip_cents then 'refunded'::public.payment_status
               else status end,
             updated_at = now()
       where id = v_refund.payment_id
       returning * into v_payment;
    end if;
  end if;

  return to_jsonb(v_payment);
end;
$$;

-- ----------------------------------------------------------------------------
-- void_tender(p_payment_id) → jsonb
--   { ok: true, payment } when an unsettled tender was canceled (or already
--   canceled); { ok: false, reason: 'not_found' | 'not_voidable', payment }.
-- ----------------------------------------------------------------------------
create or replace function public.void_tender(p_payment_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_payment public.payments%rowtype;
begin
  select * into v_payment from public.payments
   where id = p_payment_id
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if v_payment.status = 'canceled' then
    return jsonb_build_object('ok', true, 'payment', to_jsonb(v_payment));
  end if;
  if v_payment.status not in ('pending', 'requires_action') then
    return jsonb_build_object('ok', false, 'reason', 'not_voidable',
                              'payment', to_jsonb(v_payment));
  end if;
  update public.payments
     set status = 'canceled', updated_at = now()
   where id = p_payment_id
   returning * into v_payment;
  return jsonb_build_object('ok', true, 'payment', to_jsonb(v_payment));
end;
$$;

revoke all on function public.reserve_payment(jsonb) from public, anon, authenticated;
revoke all on function public.reserve_refund(uuid, uuid, integer, text) from public, anon, authenticated;
revoke all on function public.finalize_refund(uuid, text) from public, anon, authenticated;
revoke all on function public.void_tender(uuid) from public, anon, authenticated;
grant execute on function public.reserve_payment(jsonb) to service_role;
grant execute on function public.reserve_refund(uuid, uuid, integer, text) to service_role;
grant execute on function public.finalize_refund(uuid, text) to service_role;
grant execute on function public.void_tender(uuid) to service_role;
