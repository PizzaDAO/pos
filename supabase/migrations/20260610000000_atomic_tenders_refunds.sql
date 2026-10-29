-- ============================================================================
-- Migration: atomic_tenders_refunds
--
-- WHY: the payment API checked the order balance in application code and then
-- inserted the tender in a separate statement, so two concurrent requests could
-- both see the full balance and both charge (overpayment). Refunds had the same
-- race against the refundable amount, and every refund of a payment reused one
-- rail idempotency key (`refund_<paymentId>`), so a second partial refund was
-- swallowed by the provider as a replay of the first.
--
-- WHAT:
--   * reserve_payment(jsonb): locks the ORDER row (SELECT … FOR UPDATE), sums the
--     non-failed/non-canceled tenders, and inserts the new tender only if it
--     fits in the remaining balance — all in one transaction. Idempotent on the
--     tender id (a retry returns the existing row).
--   * payment_refunds: a ledger of refund REQUESTS keyed by a client-supplied
--     refund id (the idempotency key end-to-end; the rail key is
--     `refund_<paymentId>_<refundId>`).
--   * reserve_refund(...): locks the PAYMENT row and inserts a pending refund
--     only if it fits in amount + tip − refunded − pending refunds. Idempotent
--     on the refund id.
--   * finalize_refund(...): flips a pending refund to succeeded/failed and, on
--     success, adds its amount to payments.refunded_cents exactly once.
--
-- The functions are SECURITY DEFINER with a pinned search_path and are only
-- executable by service_role (the server data path); anon/authenticated cannot
-- call them. IDEMPOTENT: create-if-not-exists / create or replace.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Refund ledger
-- ----------------------------------------------------------------------------
create table if not exists public.payment_refunds (
  id uuid primary key,
  payment_id uuid not null references public.payments (id) on delete cascade,
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  amount_cents integer not null check (amount_cents > 0),
  status text not null default 'pending'
    check (status in ('pending', 'succeeded', 'failed')),
  reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists payment_refunds_payment_id_idx
  on public.payment_refunds (payment_id);
create index if not exists payment_refunds_tenant_id_idx
  on public.payment_refunds (tenant_id);

alter table public.payment_refunds enable row level security;
alter table public.payment_refunds force row level security;

drop policy if exists payment_refunds_select on public.payment_refunds;
create policy payment_refunds_select on public.payment_refunds
  for select
  using (public.is_platform_admin() or public.is_tenant_member(tenant_id));
-- No write policy: refunds are written only through the functions below
-- (service_role).

revoke all on public.payment_refunds from anon;
revoke all on public.payment_refunds from authenticated;
grant select on public.payment_refunds to authenticated;
grant select, insert, update, delete on public.payment_refunds to service_role;

-- ----------------------------------------------------------------------------
-- reserve_payment(p_payment jsonb) → jsonb
--   { ok: true,  created: bool, payment: <row> }
--   { ok: false, reason: 'order_not_found' | 'order_mismatch'
--                        | 'order_closed' | 'exceeds_balance',
--     balance_cents: int }
-- ----------------------------------------------------------------------------
create or replace function public.reserve_payment(p_payment jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid := (p_payment ->> 'id')::uuid;
  v_amount bigint := coalesce((p_payment ->> 'amount_cents')::bigint, 0);
  v_order public.orders%rowtype;
  v_existing public.payments%rowtype;
  v_covered bigint;
  v_total bigint;
begin
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
  if v_order.tenant_id <> (p_payment ->> 'tenant_id')::uuid
     or v_order.location_id <> (p_payment ->> 'location_id')::uuid then
    return jsonb_build_object('ok', false, 'reason', 'order_mismatch',
                              'balance_cents', 0);
  end if;
  if v_order.status in ('voided', 'refunded') then
    return jsonb_build_object('ok', false, 'reason', 'order_closed',
                              'balance_cents', 0);
  end if;

  -- Re-check after acquiring the lock (a concurrent retry may have inserted).
  select * into v_existing from public.payments where id = v_id;
  if found then
    return jsonb_build_object('ok', true, 'created', false,
                              'payment', to_jsonb(v_existing));
  end if;

  v_total := coalesce((v_order.totals ->> 'total_cents')::bigint, 0);
  select coalesce(sum(amount_cents), 0) into v_covered
    from public.payments
   where order_id = v_order.id
     and status not in ('failed', 'canceled');

  if v_amount <= 0 or v_covered + v_amount > v_total then
    return jsonb_build_object('ok', false, 'reason', 'exceeds_balance',
                              'balance_cents', greatest(v_total - v_covered, 0));
  end if;

  insert into public.payments
  select * from jsonb_populate_record(null::public.payments,
    p_payment || jsonb_build_object(
      'created_at', coalesce(p_payment ->> 'created_at', now()::text),
      'updated_at', now()::text))
  returning * into v_existing;

  return jsonb_build_object('ok', true, 'created', true,
                            'payment', to_jsonb(v_existing));
end;
$$;

-- ----------------------------------------------------------------------------
-- reserve_refund(p_refund_id, p_payment_id, p_amount_cents, p_reason) → jsonb
--   { ok: true,  created: bool, refund: <row> }
--   { ok: false, reason: 'payment_not_found' | 'refund_mismatch'
--                        | 'exceeds_refundable', refundable_cents: int }
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
set search_path = public
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

  select coalesce(sum(amount_cents), 0) into v_pending
    from public.payment_refunds
   where payment_id = p_payment_id and status = 'pending';
  v_refundable := v_payment.amount_cents + v_payment.tip_cents
                  - v_payment.refunded_cents - v_pending;

  if p_amount_cents <= 0 or p_amount_cents > v_refundable then
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
-- finalize_refund(p_refund_id, p_status) → payments row (as jsonb) or null
--   pending → succeeded adds amount_cents to payments.refunded_cents (and marks
--   the payment refunded when fully refunded) exactly once; pending → failed
--   releases the reservation. Already-final refunds are left untouched.
-- ----------------------------------------------------------------------------
create or replace function public.finalize_refund(
  p_refund_id uuid,
  p_status text
)
returns jsonb
language plpgsql
security definer
set search_path = public
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

  -- Re-read under the payment lock so concurrent finalizes apply once.
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

-- Only the server (service_role) may call these.
revoke all on function public.reserve_payment(jsonb) from public, anon, authenticated;
revoke all on function public.reserve_refund(uuid, uuid, integer, text) from public, anon, authenticated;
revoke all on function public.finalize_refund(uuid, text) from public, anon, authenticated;
grant execute on function public.reserve_payment(jsonb) to service_role;
grant execute on function public.reserve_refund(uuid, uuid, integer, text) to service_role;
grant execute on function public.finalize_refund(uuid, text) to service_role;
