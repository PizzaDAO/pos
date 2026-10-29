-- ============================================================================
-- Orders: only tenant staff (or a platform admin) may INSERT.
--
-- The original `orders_insert` policy (20260605000100) also let a signed-in
-- customer insert "their own" order (is_self_customer(customer_id)). Because the
-- row's status/totals/items are caller-controlled, that meant a customer could
-- write a `placed` order with arbitrary totals straight onto the KDS. Online
-- orders are inserted server-side by /api/shop/orders with the service role
-- (which bypasses RLS) after repricing from the menu, so nothing legitimate uses
-- the customer branch. Customers keep SELECT on their own orders (orders_select).
-- ============================================================================
drop policy if exists orders_insert on public.orders;
create policy orders_insert on public.orders
  for insert
  with check (
    public.is_platform_admin()
    or public.is_tenant_member(tenant_id)
  );
