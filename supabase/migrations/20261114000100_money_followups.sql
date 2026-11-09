-- ============================================================================
-- Migration: money_followups (gift card + refund review follow-ups)
--
--   1. sv_order_settled_cents(order): the base money the order's settled
--      (captured / authorized) tenders still HOLD, net of refunds and pending
--      refund reservations (the tip absorbs a refund first, like the caps).
--      sv_credit's "is the sale settled?" check uses it, so a sale tender that
--      was partly refunded before the sale settled can never activate the card
--      for the full amount. What an order still OWES (sv_redeem's remaining,
--      sv_order_sum) is unchanged. Mirrors isSettled / heldBaseCents in
--      src/lib/giftcards/order-math.ts.
--   2. finish_order_adjustment(..., p_keep_claim): a writer that does not own
--      the request's execution claim (the Stripe refund.failed webhook)
--      re-derives the record WITHOUT clearing a live claim, so a concurrent
--      execution of the same request stays exclusive. Default false: every
--      existing caller (the claim owner) still releases it.
--
-- No new tables. Functions are service_role only.
-- ============================================================================

begin;
set local lock_timeout = '3s';

create or replace function public.sv_order_settled_cents(p_order public.orders)
returns bigint
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce(sum(
           greatest(0, least(
             p.amount_cents::bigint,
             p.amount_cents::bigint + p.tip_cents - p.refunded_cents - p.refund_reserved_cents
           ))), 0)::bigint
    from public.payments p
   where p.order_id = p_order.id
     and upper(p.currency) = upper(p_order.currency)
     and p.status::text in ('captured', 'authorized');
$$;

-- ---- sv_credit ----------------------------------------------------------------
-- Outcomes: ok (replayed true|false) | not_found | inactive | not_settled |
--           bad_amount | exceeds_max
create or replace function public.sv_credit(
  p_tenant_id uuid,
  p_account_id uuid,
  p_location_id uuid,
  p_kind text,
  p_amount integer,
  p_key text,
  p_order_id uuid default null,
  p_payment_id uuid default null,
  p_reason text default null,
  p_actor_id text default null,
  p_approved_by text default null,
  p_activate boolean default false,
  p_require_settled_order uuid default null,
  p_max_balance integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_acct public.stored_value_accounts;
  v_prior public.stored_value_ledger;
  v_order public.orders;
  v_entry public.stored_value_ledger;
  v_after bigint;
begin
  if p_kind not in ('issue', 'load', 'refund') then
    raise exception 'sv_credit: bad kind %', p_kind;
  end if;

  select * into v_acct from public.stored_value_accounts
   where id = p_account_id and tenant_id = p_tenant_id
   for update;
  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  select * into v_prior from public.stored_value_ledger
   where account_id = p_account_id and idempotency_key = p_key;
  if found then
    return jsonb_build_object('outcome', 'ok', 'replayed', true,
      'account', to_jsonb(v_acct), 'entry', to_jsonb(v_prior));
  end if;

  if v_acct.status = 'voided' or (v_acct.status = 'pending' and not p_activate) then
    return jsonb_build_object('outcome', 'inactive', 'account', to_jsonb(v_acct));
  end if;

  if p_require_settled_order is not null then
    select * into v_order from public.orders
     where id = p_require_settled_order and tenant_id = p_tenant_id;
    if not found
       or v_order.status::text in ('voided', 'abandoned', 'refunded')
       or public.sv_order_settled_cents(v_order) < public.sv_order_due(v_order) then
      return jsonb_build_object('outcome', 'not_settled', 'account', to_jsonb(v_acct));
    end if;
  end if;

  if p_amount is null or p_amount <= 0 then
    return jsonb_build_object('outcome', 'bad_amount', 'account', to_jsonb(v_acct));
  end if;
  -- A refund back to the card never exceeds what that tender redeemed (the
  -- credit runs BEFORE the refund is recorded, so it must cap itself).
  if p_kind = 'refund' then
    if p_payment_id is null or coalesce((
         select -sum(amount_cents) from public.stored_value_ledger
          where account_id = p_account_id and payment_id = p_payment_id and kind = 'redeem'
       ), 0) < coalesce((
         select sum(amount_cents) from public.stored_value_ledger
          where account_id = p_account_id and payment_id = p_payment_id and kind = 'refund'
       ), 0) + p_amount then
      return jsonb_build_object('outcome', 'exceeds_max', 'account', to_jsonb(v_acct));
    end if;
  end if;
  v_after := v_acct.balance_cents::bigint + p_amount;
  if p_max_balance is not null and v_after > p_max_balance then
    return jsonb_build_object('outcome', 'exceeds_max', 'account', to_jsonb(v_acct));
  end if;

  update public.stored_value_accounts
     set balance_cents = v_after,
         status = case when p_activate and status = 'pending' then 'active' else status end,
         activated_at = case when p_activate and status = 'pending' then now() else activated_at end,
         updated_at = now()
   where id = p_account_id
  returning * into v_acct;

  insert into public.stored_value_ledger (
    account_id, tenant_id, location_id, kind, amount_cents, balance_after_cents,
    order_id, payment_id, idempotency_key, reason, actor_id, approved_by
  ) values (
    p_account_id, p_tenant_id, p_location_id, p_kind, p_amount, v_after,
    p_order_id, p_payment_id, p_key, p_reason, p_actor_id, p_approved_by
  ) returning * into v_entry;

  return jsonb_build_object('outcome', 'ok', 'replayed', false,
    'account', to_jsonb(v_acct), 'entry', to_jsonb(v_entry));
end;
$$;

-- ---- finish_order_adjustment: optionally keep the execution claim -----------
drop function if exists public.finish_order_adjustment(uuid, text, text, jsonb, jsonb);

create or replace function public.finish_order_adjustment(
  p_order_id uuid,
  p_id text,
  p_status text,
  p_allocations jsonb,
  p_meta jsonb default null,
  p_keep_claim boolean default false
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
         claimed_until = case when p_keep_claim then a.claimed_until else null end,
         updated_at = now()
   where a.order_id = p_order_id and a.id = p_id
  returning * into r;
  if not found then
    return null;
  end if;
  return to_jsonb(r);
end;
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.sv_order_settled_cents(public.orders)',
    'public.sv_credit(uuid, uuid, uuid, text, integer, text, uuid, uuid, text, text, text, boolean, uuid, integer)',
    'public.finish_order_adjustment(uuid, text, text, jsonb, jsonb, boolean)'
  ] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on function %s from anon', f);
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format('revoke all on function %s from authenticated', f);
    end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('grant execute on function %s to service_role', f);
    end if;
  end loop;
end
$$;

commit;
