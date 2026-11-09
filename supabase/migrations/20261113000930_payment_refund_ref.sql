-- ============================================================================
-- Migration: payment_refund_ref
--
-- set_payment_refund_ref(payment, request id, processor ref): fill in the
-- provider refund id (Stripe `re_...`) on a payments.refunds[] entry that was
-- recorded without one. Used when a card refund is replayed: refundPayment calls
-- the rail again with the SAME idempotency key (Stripe returns the original
-- refund, or makes it if it never happened) and records the id. One UPDATE
-- (row lock): only an entry with this request id and NO ref yet is touched, so
-- a concurrent refund appending its own entry is never lost.
--
-- Additive and live-safe: one new function, service_role only.
-- ============================================================================

begin;
set local lock_timeout = '3s';

create or replace function public.set_payment_refund_ref(
  p_payment_id uuid,
  p_request_id text,
  p_processor_ref text
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.payments p
     set refunds = (
           select coalesce(jsonb_agg(
                    case when t.e ->> 'request_id' = p_request_id
                              and coalesce(t.e ->> 'processor_ref', '') = ''
                         then jsonb_set(t.e, '{processor_ref}', to_jsonb(p_processor_ref))
                         else t.e end
                    order by t.o), '[]'::jsonb)
             from jsonb_array_elements(p.refunds) with ordinality as t(e, o)),
         updated_at = now()
   where p.id = p_payment_id
     and exists (
       select 1 from jsonb_array_elements(p.refunds) x
        where x ->> 'request_id' = p_request_id
          and coalesce(x ->> 'processor_ref', '') = '');
  return found;
end;
$$;

revoke all on function public.set_payment_refund_ref(uuid, text, text) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.set_payment_refund_ref(uuid, text, text) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.set_payment_refund_ref(uuid, text, text) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.set_payment_refund_ref(uuid, text, text) to service_role;
  end if;
end
$$;

commit;

notify pgrst, 'reload schema';
