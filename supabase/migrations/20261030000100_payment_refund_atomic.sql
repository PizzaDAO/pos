-- ============================================================================
-- Atomic refund bookkeeping.
--
-- refundPayment used to read the payment, add to refunded_cents in app code and
-- upsert the whole row, so two concurrent refunds lost one update and the
-- over-refund cap was check-then-act. These functions do the increment, the
-- refund-id append and the cap check in ONE UPDATE, so concurrent refunds with
-- different ids both keep, a replayed id is a no-op, and an over-refund is
-- refused. Server-only (service role): not executable by anon/authenticated.
--
-- refund_ids lives in a dedicated column (not raw jsonb) so the append is a plain
-- array operation.
-- ============================================================================
alter table public.payments
  add column if not exists refund_ids text[] not null default '{}';

-- Reserve a refund: refunded_cents += amount, refund id appended, status flipped
-- to 'refunded' when the tender is fully refunded. Outcomes:
--   ok         reserved (payment = updated row)
--   duplicate  p_refund_id already recorded (payment = current row)
--   exceeds    would exceed amount+tip, or the tender isn't refundable
--   not_found  no such payment
create or replace function public.reserve_payment_refund(
  p_payment_id uuid,
  p_amount integer,
  p_refund_id text
) returns jsonb
language plpgsql
as $$
declare
  r public.payments;
begin
  update public.payments p
     set refunded_cents = p.refunded_cents + p_amount,
         refund_ids = case
           when p_refund_id is null then p.refund_ids
           else p.refund_ids || p_refund_id
         end,
         status = case
           when p.refunded_cents + p_amount >= p.amount_cents + p.tip_cents
             then 'refunded'::public.payment_status
           else p.status
         end,
         updated_at = now()
   where p.id = p_payment_id
     and p_amount > 0
     and p.status in ('captured', 'authorized')
     and p.refunded_cents + p_amount <= p.amount_cents + p.tip_cents
     and (p_refund_id is null or not (p_refund_id = any (p.refund_ids)))
  returning * into r;

  if found then
    return jsonb_build_object('outcome', 'ok', 'payment', to_jsonb(r));
  end if;

  select * into r from public.payments where id = p_payment_id;
  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;
  if p_refund_id is not null and p_refund_id = any (r.refund_ids) then
    return jsonb_build_object('outcome', 'duplicate', 'payment', to_jsonb(r));
  end if;
  return jsonb_build_object('outcome', 'exceeds', 'payment', to_jsonb(r));
end;
$$;

-- Undo a reservation whose rail call failed.
create or replace function public.release_payment_refund(
  p_payment_id uuid,
  p_amount integer,
  p_refund_id text
) returns void
language sql
as $$
  update public.payments p
     set refunded_cents = greatest(0, p.refunded_cents - p_amount),
         refund_ids = case
           when p_refund_id is null then p.refund_ids
           else array_remove(p.refund_ids, p_refund_id)
         end,
         status = case
           when p.status = 'refunded' then 'captured'::public.payment_status
           else p.status
         end,
         updated_at = now()
   where p.id = p_payment_id;
$$;

revoke all on function public.reserve_payment_refund(uuid, integer, text)
  from public, anon, authenticated;
revoke all on function public.release_payment_refund(uuid, integer, text)
  from public, anon, authenticated;
grant execute on function public.reserve_payment_refund(uuid, integer, text)
  to service_role;
grant execute on function public.release_payment_refund(uuid, integer, text)
  to service_role;
