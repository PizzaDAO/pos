-- ============================================================================
-- Migration: core_cancel_and_prune
--   * public.core_cancel_order(): the tender check and the status transition in
--     ONE transaction under a row lock on the order, so a payment cannot slip in
--     between "no tender in flight" and "voided".
--   * core_outbox_prune(): configurable stale-pending expiry (default 7 days).
-- (PR #21 rebased: was 20260622000000_core_cancel_and_prune.)
-- Stale unsettled tender = pending/requires_action, no charge_id, older than 15
-- minutes (same rule as the mock driver's cancelOrder). Only /v1 cancel uses
-- this function; main's storefront cancel (/api/shop/orders/cancel) and
-- checkout lifecycle are unchanged.
-- ============================================================================

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

  -- The order row lock serializes concurrent /v1 cancels and status writes.
  -- (Main records tenders without locking the order; a live card tender is
  -- unique per order via main's index, and any pending/authorized tender that
  -- is not a stale abandoned attempt blocks the cancel below.)
  select exists (
    select 1 from public.payments p
     where p.order_id = p_order_id
       and p.status in ('pending', 'authorized', 'requires_action')
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

  -- Void abandoned attempts, then cancel.
  update public.payments
     set status = 'canceled', updated_at = now()
   where order_id = p_order_id
     and status in ('pending', 'requires_action')
     and charge_id is null
     and created_at < now() - interval '15 minutes';

  update public.orders
     set status = 'voided', hold = null, updated_at = now()
   where id = p_order_id;

  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.core_cancel_order(uuid, uuid) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.core_cancel_order(uuid, uuid) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.core_cancel_order(uuid, uuid) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.core_cancel_order(uuid, uuid) to service_role;
  end if;
end
$$;

-- ---- prune with a configurable stale-pending expiry --------------------------
drop function if exists public.core_outbox_prune();

create or replace function public.core_outbox_prune(p_pending_expiry interval default interval '7 days')
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
   where status = 'pending' and occurred_at < now() - p_pending_expiry;
  update public.core_outbox
     set row_snapshot = null
   where status in ('delivered', 'dead') and row_snapshot is not null;
end;
$$;

revoke all on function public.core_outbox_prune(interval) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.core_outbox_prune(interval) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.core_outbox_prune(interval) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.core_outbox_prune(interval) to service_role;
  end if;
end
$$;
