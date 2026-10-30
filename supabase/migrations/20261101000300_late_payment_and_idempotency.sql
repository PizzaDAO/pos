-- ============================================================================
-- Online checkout lifecycle, second review round.
--
-- 1. payments_one_live_card_or_cb now constrains only OPEN tenders
--    (requires_action / pending). It used to also cover authorized / captured /
--    refunded, which meant a webhook settling an older tender could not be
--    RECORDED while a newer tender held the slot (money settled but stored as
--    canceled). Settled tenders no longer hold the slot, so every settlement can
--    always be recorded; the concurrent-intent gap stays closed because two OPEN
--    card/Coinbase tenders for one order are still refused.
-- 2. One delivery per order (dispatch is idempotent per order).
-- 3. Atomic order-fulfillment helpers (service role only): a shallow merge, a
--    nested merge into fulfillment.late_payment, and the compare-and-set CLAIM
--    that makes concurrent Accept / Refund of a late payment mutually exclusive.
-- ============================================================================

drop index if exists public.payments_one_live_card_or_cb;
create unique index payments_one_live_card_or_cb
  on public.payments (order_id, rail)
  where rail in ('stripe_online', 'crypto_coinbase')
    and status in ('requires_action', 'pending');

-- Dispatch is "insert-first": a second dispatch for the same order is refused by
-- the database and the application returns the existing record.
create unique index if not exists deliveries_order_id_uidx
  on public.deliveries (order_id);

-- Shallow-merge keys into orders.fulfillment in ONE statement (no read-modify-write).
create or replace function public.merge_order_fulfillment(
  p_order_id uuid,
  p_patch jsonb
) returns setof public.orders
language sql
as $$
  update public.orders o
     set fulfillment = o.fulfillment || p_patch,
         updated_at = now()
   where o.id = p_order_id
     and o.fulfillment is not null
  returning o.*;
$$;

-- Merge into fulfillment.late_payment; keys set to null are removed.
create or replace function public.update_late_payment(
  p_order_id uuid,
  p_patch jsonb
) returns setof public.orders
language sql
as $$
  update public.orders o
     set fulfillment = jsonb_set(
           o.fulfillment,
           '{late_payment}',
           jsonb_strip_nulls((o.fulfillment -> 'late_payment') || p_patch)
         ),
         updated_at = now()
   where o.id = p_order_id
     and o.fulfillment -> 'late_payment' is not null
  returning o.*;
$$;

-- Claim an unresolved (or refund-owed) late payment for ONE actor: sets
-- late_payment.claim only if nobody holds a live claim (a claim older than
-- p_stale_before is treated as abandoned by a crashed request). Zero rows back
-- means someone else got there first.
create or replace function public.claim_late_payment(
  p_order_id uuid,
  p_claim text,
  p_stale_before timestamptz
) returns setof public.orders
language sql
as $$
  update public.orders o
     set fulfillment = jsonb_set(
           o.fulfillment,
           '{late_payment}',
           (o.fulfillment -> 'late_payment')
             || jsonb_build_object('claim', p_claim, 'claim_at', now())
         ),
         updated_at = now()
   where o.id = p_order_id
     and o.fulfillment -> 'late_payment' is not null
     and coalesce(o.fulfillment -> 'late_payment' ->> 'resolved', '')
         in ('', 'refund_owed_manual')
     and (
       o.fulfillment -> 'late_payment' ->> 'claim' is null
       or (o.fulfillment -> 'late_payment' ->> 'claim_at')::timestamptz < p_stale_before
     )
  returning o.*;
$$;

revoke all on function public.merge_order_fulfillment(uuid, jsonb)
  from public, anon, authenticated;
revoke all on function public.update_late_payment(uuid, jsonb)
  from public, anon, authenticated;
revoke all on function public.claim_late_payment(uuid, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.merge_order_fulfillment(uuid, jsonb) to service_role;
grant execute on function public.update_late_payment(uuid, jsonb) to service_role;
grant execute on function public.claim_late_payment(uuid, text, timestamptz) to service_role;
