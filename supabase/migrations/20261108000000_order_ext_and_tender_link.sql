-- ============================================================================
-- Migration: order_ext_and_tender_link  (pos-v1-gaps phase 4)
--
--   * orders.core_ext jsonb (nullable): what /v1 order creation carries that POS
--     had no column for: custom fee lines (`fees`), `tax_exempt`, `callout_name`,
--     `metadata`, `fire_at`. Written once, at insert; never updated.
--   * core_link_tender_session(): a true compare-and-set that records a Stripe
--     Checkout session id on its tender (payments.raw.checkout_session_id) ONLY
--     while the tender is still `requires_action`. The caller used to re-read the
--     tender and then upsert the whole row; a close (cash settled the order, a
--     cancel, a supersede, a webhook) landing between the read and the write was
--     overwritten by the stale copy. One UPDATE ... WHERE status closes that gap.
--     Tenant filter in SQL: the service key bypasses RLS.
--
-- DEPLOY ORDER: this migration first, code second (the new code calls the
-- function; the old code ignores the column). Additive and live-safe: a nullable
-- column with no default (metadata-only) and a new function; lock_timeout bounds
-- the catalog lock. No trigger is touched; the payments trigger fires on this
-- UPDATE exactly as it did on the old upsert (no status change, so no event).
-- ============================================================================

begin;
set local lock_timeout = '3s';

alter table public.orders add column if not exists core_ext jsonb;

create or replace function public.core_link_tender_session(
  p_tenant_id uuid,
  p_payment_id uuid,
  p_session_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.payments;
  v_status text;
begin
  if p_session_id is null or btrim(p_session_id) = '' then
    raise exception 'core_link_tender_session: session id required';
  end if;
  update public.payments
     set raw = coalesce(raw, '{}'::jsonb) || jsonb_build_object('checkout_session_id', p_session_id),
         updated_at = now()
   where id = p_payment_id
     and tenant_id = p_tenant_id
     and status::text = 'requires_action'
  returning * into v_row;
  if found then
    return jsonb_build_object('outcome', 'ok', 'payment', to_jsonb(v_row));
  end if;
  select status::text into v_status from public.payments
   where id = p_payment_id and tenant_id = p_tenant_id;
  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;
  return jsonb_build_object('outcome', 'not_open', 'status', v_status);
end;
$$;

revoke all on function public.core_link_tender_session(uuid, uuid, text) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.core_link_tender_session(uuid, uuid, text) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.core_link_tender_session(uuid, uuid, text) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.core_link_tender_session(uuid, uuid, text) to service_role;
  end if;
end
$$;

commit;

notify pgrst, 'reload schema';
