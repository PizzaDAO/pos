-- ============================================================================
-- Migration: core_tip_events  (pos-v1-gaps phase 3)
--
-- POS now emits the catalog events `tip.recorded` and `tip.adjusted`
-- (TipFactSchema), from core_trg_payments. The outbox row is THIN, like every
-- other: it names the payment and the deterministic fact id
-- (row_snapshot.fact_id); the delivery worker hydrates the full TipFact from
-- current POS state with the same builder `GET /v1/tips` uses
-- (src/lib/core/tips.ts), so the list and the events cannot disagree. If the
-- fact no longer exists at delivery time (a released refund) the worker drops
-- the row (subject_gone).
--
-- When a fact is emitted (once each; a replayed upsert changes neither status nor
-- refunded_cents, so the trigger sees no transition and emits nothing):
--   tip.recorded  a tender becomes `captured` (INSERT as captured, or UPDATE from
--                 another status) with tip_cents > 0: fact `tip_<payment>`.
--                 A captured tender with NO tip emits the order-level `online`
--                 fact `tip_online_<order>` iff it is the FIRST settled tender of
--                 the order and orders.totals.tip_cents > 0 (the core rule: tender
--                 tips win, else the order tip is one online fact). A per-order
--                 advisory lock makes two concurrent first captures emit once.
--   tip.adjusted  a refund raises refunded_cents on a settled tender. Refunds come
--                 off the tip FIRST (as netSettledBaseCents does), so the tip part
--                 is least(refunded, tip) cumulatively: fact
--                 `tipadj_<payment>_c<cumulative tip refunded>`. For an online
--                 tip, the part of the order's refund total beyond its base:
--                 `tipadj_online_<order>_c<cum>`. Cumulative ids mean a replay
--                 can never mint a second fact for the same step.
-- Same suppression as every payment event: nothing for an order the hub has not
-- seen (core_announced) unless it is a held /v1 order (draft + hold).
--
-- The body is 20261105000200_core_payment_events_held plus the tip section at
-- the end. Additive and live-safe: create or replace of ONE function, no table,
-- index or trigger change (so no lock beyond a momentary catalog lock; the
-- lock_timeout bounds even that).
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
  v_order_tip bigint;
  v_base bigint;
  v_run_new bigint;
  v_cum_new bigint;
  v_cum_old bigint;
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

  -- ---- tip facts (tip.recorded / tip.adjusted) -----------------------------
  -- 1. A tender becomes captured.
  if new.status::text = 'captured'
     and (tg_op = 'INSERT' or old.status::text not in ('captured', 'refunded')) then
    if new.tip_cents > 0 then
      perform public.core_emit(new.tenant_id, new.location_id, 'tip.recorded',
        'payment', new.id, null, null,
        jsonb_build_object('fact_id', 'tip_' || new.id::text, 'order_id', new.order_id));
    else
      -- Possibly the order-level online fact: only the FIRST settled tender of
      -- the order, and only while no tender carries a tip. Serialise concurrent
      -- first captures so exactly one of them sees "no other settled tender".
      perform pg_advisory_xact_lock(hashtextextended('core_tip_online:' || new.order_id::text, 0));
      select coalesce((o.totals ->> 'tip_cents')::bigint, 0) into v_order_tip
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

  -- 2. A refund on a settled tender: the part that lands on the tip.
  if tg_op = 'UPDATE'
     and new.refunded_cents > old.refunded_cents
     and new.status::text in ('captured', 'refunded') then
    if new.tip_cents > 0 then
      v_cum_new := least(new.refunded_cents, new.tip_cents);
      v_cum_old := least(old.refunded_cents, new.tip_cents);
      if v_cum_new > v_cum_old then
        perform public.core_emit(new.tenant_id, new.location_id, 'tip.adjusted',
          'payment', new.id, null, null,
          jsonb_build_object('fact_id', 'tipadj_' || new.id::text || '_c' || v_cum_new,
                             'order_id', new.order_id));
      end if;
    else
      perform pg_advisory_xact_lock(hashtextextended('core_tip_online:' || new.order_id::text, 0));
      select coalesce((o.totals ->> 'tip_cents')::bigint, 0) into v_order_tip
        from public.orders o where o.id = new.order_id;
      if coalesce(v_order_tip, 0) > 0
         and not exists (
           select 1 from public.payments p
            where p.order_id = new.order_id and p.tip_cents > 0
              and p.status::text in ('captured', 'refunded')
         ) then
        select coalesce(sum(p.amount_cents), 0), coalesce(sum(p.refunded_cents), 0)
          into v_base, v_run_new
          from public.payments p
         where p.order_id = new.order_id and p.status::text in ('captured', 'refunded');
        v_cum_new := greatest(0, least(v_run_new - v_base, v_order_tip));
        v_cum_old := greatest(0, least(
          v_run_new - (new.refunded_cents - old.refunded_cents) - v_base, v_order_tip));
        if v_cum_new > v_cum_old then
          perform public.core_emit(new.tenant_id, new.location_id, 'tip.adjusted',
            'payment', new.id, null, null,
            jsonb_build_object('fact_id',
                               'tipadj_online_' || new.order_id::text || '_c' || v_cum_new,
                               'order_id', new.order_id));
        end if;
      end if;
    end if;
  end if;
  return new;
end;
$$;

commit;

notify pgrst, 'reload schema';
