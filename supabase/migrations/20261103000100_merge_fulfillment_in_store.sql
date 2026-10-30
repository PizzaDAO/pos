-- merge_order_fulfillment now also works on an order with no fulfillment blob.
--
-- In-store orders have no `fulfillment` (it is the online-order blob). A duplicate
-- payment on an in-store order (e.g. cash taken while a card-reader tender was
-- live) is flagged through `fulfillment.late_payment` so it shows in the same
-- admin "late / duplicate payments" list as online orders; the merge must be able
-- to create the blob. Same shallow, single-statement merge otherwise.
create or replace function public.merge_order_fulfillment(
  p_order_id uuid,
  p_patch jsonb
) returns setof public.orders
language sql
as $$
  update public.orders o
     set fulfillment = coalesce(o.fulfillment, '{}'::jsonb) || p_patch,
         updated_at = now()
   where o.id = p_order_id
  returning o.*;
$$;
