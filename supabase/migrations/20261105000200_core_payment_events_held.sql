-- ============================================================================
-- Migration: core_payment_events_held  (pos-v1-gaps)
--
-- core_trg_payments suppressed every payment event for an order the hub had not
-- seen (orders.core_announced). A /v1 order held for payment (status draft, hold
-- set) is not announced until it is released, so a session payment produced only
-- the hydrated order.placed and never payment.captured, and pizza-mcp could not
-- book it. The check is now:
--
--     core_announced  OR  (status = 'draft' AND hold IS NOT NULL)
--
-- Shop awaiting_payment orders and parked in-store drafts (no hold) stay
-- suppressed. The function body is otherwise identical to
-- 20261102000400_core_v1_hardening (create or replace; the trigger is untouched).
--
-- Additive and live-safe: replaces one function, no table change, no rewrite.
-- ============================================================================

begin;
set local lock_timeout = '3s';

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
  v_retract uuid;
begin
  -- The hub has seen the order (core_announced), OR it is a held /v1 order
  -- (draft + hold): its payment must reach the hub BEFORE the order is released,
  -- so a consumer (pizza-mcp) books the payment, then sees order.placed. Shop
  -- awaiting_payment orders and parked in-store drafts (no hold) stay suppressed.
  select (coalesce(o.core_announced, false)
          or (o.status::text = 'draft' and o.hold is not null))
    into v_announced from public.orders o where o.id = new.order_id;
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
  return new;
end;
$$;

commit;

notify pgrst, 'reload schema';
