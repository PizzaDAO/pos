-- ============================================================================
-- Migration: core_tip_events  (pos-v1-gaps phase 3)
--
-- POS emits the catalog events `tip.recorded` and `tip.adjusted` (TipFactSchema).
-- The outbox row is THIN, like every other: it names the payment and the
-- deterministic fact id (row_snapshot.fact_id); the delivery worker hydrates the
-- full TipFact from current POS state with the same builder `GET /v1/tips` uses
-- (src/lib/core/tips.ts), so the list and the events cannot disagree. A fact that
-- no longer exists at delivery time (a released refund, an order voided since) is
-- dropped by the worker (subject_gone).
--
-- DEPLOY ORDER: code first, this migration second. A worker that predates the
-- code marks tip.* rows dead.
--
-- NEVER FAILS A PAYMENT OR ORDER WRITE. All tip logic runs inside its own
-- BEGIN ... EXCEPTION WHEN OTHERS block (a subtransaction): any error, including
-- a malformed totals value, a deadlock or a full disk, becomes a WARNING and the
-- tip event is skipped; the capture / refund / order update still commits. Every
-- numeric read of jsonb is guarded by a digits-only regex first (a value such as
-- 12.5 or 150.00 counts as 0, it does not raise).
--
-- When a fact is emitted (exactly once each; a replayed upsert changes neither
-- status nor refunded_cents, so the trigger sees no transition):
--   * Only for an order the hub has seen (orders.core_announced). A payment on an
--     order not yet announced (a shop checkout awaiting payment, a /v1 hold) emits
--     NO tip event here; core_trg_orders backfills it, once, when the order
--     becomes announced (core_tip_backfill_for_order), so a shop card tip is
--     never lost and a held /v1 order's tip is not announced before its order.
--   * tip.recorded: a tender becomes `captured` with tip_cents > 0 -> fact
--     `tip_<payment>`. A captured tender with NO tip is the order-level `online`
--     fact `tip_online_<order>` iff it is the FIRST settled tender of the order
--     and orders.totals.tip_cents > 0 (the core rule: tender tips win, else the
--     order tip is one online fact). A per-order advisory lock makes two
--     concurrent first captures emit once.
--   * tip.adjusted: a refund raises refunded_cents on a settled tender with a
--     tip. Refunds come off the tip FIRST (as netSettledBaseCents does), so the
--     tip part is least(refunded, tip) cumulatively: fact
--     `tipadj_<payment>_c<cumulative tip refunded>`. For an online tip, POS caps a
--     tender's refunds at amount + tip and the tender tip is 0, so a partial
--     refund never reaches the tip; when EVERY settled tender of the order is
--     refunded in full the tip is reversed once: `tipadj_online_<order>_full`.
--
-- Residual (documented, not guarded): a payment captured at the very instant its
-- order is announced, in two concurrent transactions, can miss its tip event;
-- the shop and /v1 code paths run those two writes sequentially.
--
-- Additive and live-safe: create or replace of TWO functions and one new one; no
-- table, index or trigger change (so no lock beyond a momentary catalog lock; the
-- lock_timeout bounds even that). No backfill of past payments.
-- ============================================================================

begin;
set local lock_timeout = '3s';

-- ---- order tip, read defensively -------------------------------------------
create or replace function public.core_order_tip_cents(p_totals jsonb)
returns bigint
language sql
immutable
set search_path = public
as $$
  select case when (p_totals ->> 'tip_cents') ~ '^[0-9]{1,12}$'
              then (p_totals ->> 'tip_cents')::bigint
              else 0 end;
$$;

-- ---- backfill when an order becomes announced -------------------------------
create or replace function public.core_tip_backfill_for_order(p_order uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  v_tip bigint;
  v_any boolean := false;
  v_first_id uuid;
  v_first_tenant uuid;
  v_first_loc uuid;
begin
  begin
    select public.core_order_tip_cents(o.totals) into v_tip
      from public.orders o where o.id = p_order;
    for r in
      select p.id, p.tenant_id, p.location_id, p.tip_cents
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
      end if;
    end loop;
    if not v_any and coalesce(v_tip, 0) > 0 and v_first_id is not null then
      perform public.core_emit(v_first_tenant, v_first_loc, 'tip.recorded',
        'payment', v_first_id, null, null,
        jsonb_build_object('fact_id', 'tip_online_' || p_order::text, 'order_id', p_order));
    end if;
  exception when others then
    raise warning 'core_tip_backfill_for_order(%): tip events skipped (%: %)',
      p_order, sqlstate, sqlerrm;
  end;
end;
$$;

revoke all on function public.core_tip_backfill_for_order(uuid) from public, anon, authenticated;

-- ---- orders: the hardening body plus the backfill ---------------------------
create or replace function public.core_trg_orders()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row jsonb := jsonb_build_object('id', new.id, 'status', new.status);
  v_changes jsonb;
  v_bookkeeping constant text[] := array[
    'paid_at', 'finalized_at', 'late_payment', 'recovery_attempts',
    'recovery_next_at', 'foreign_alerted_at', 'checkout_mode'];
begin
  if tg_op = 'INSERT' then
    if new.core_announced then
      perform public.core_emit(new.tenant_id, new.location_id, 'order.placed',
        'order', new.id, new.version, null, v_row);
    end if;
    return new;
  end if;

  if new.status is distinct from old.status then
    v_changes := jsonb_build_object('status', jsonb_build_array(old.status, new.status));
    if not old.core_announced then
      if new.core_announced then
        perform public.core_emit(new.tenant_id, new.location_id, 'order.placed',
          'order', new.id, new.version, v_changes, v_row);
        -- Tenders captured before the hub saw the order: their tip events.
        perform public.core_tip_backfill_for_order(new.id);
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
  elsif old.core_announced
     and new.status::text not in ('draft', 'awaiting_payment', 'abandoned') and (
        new.totals is distinct from old.totals
     or new.notes is distinct from old.notes
     or (new.fulfillment - v_bookkeeping) is distinct from (old.fulfillment - v_bookkeeping)
     or new.discount_cents is distinct from old.discount_cents
     or new.customer_id is distinct from old.customer_id) then
    perform public.core_emit(new.tenant_id, new.location_id, 'order.updated',
      'order', new.id, new.version, null, v_row);
  end if;
  return new;
end;
$$;

-- ---- payments: the held-events body plus the tip section --------------------
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
          v_cum_new := least(new.refunded_cents, new.tip_cents);
          v_cum_old := least(old.refunded_cents, new.tip_cents);
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
