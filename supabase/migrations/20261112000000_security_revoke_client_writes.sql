-- ============================================================================
-- Migration: security_revoke_client_writes (security audit H1, H2, M2)
--
-- H1. Tenant staff of ANY role (cashier, kitchen) could write orders, line
--     items, payments, deliveries and drawer cash events straight through
--     PostgREST with the anon key + their own JWT, bypassing the server's refund,
--     discount and balance controls. The app never writes these tables with a
--     user JWT: every write goes through the service-role driver
--     (src/lib/db/supabase.ts) or a SECURITY DEFINER function granted only to
--     service_role. The browser/user-session Supabase clients only do auth calls
--     and the realtime `postgres_changes` subscription on `orders`, which needs
--     SELECT only. So: revoke INSERT/UPDATE/DELETE from `authenticated` and
--     `anon`, and drop the write policies. SELECT grants and SELECT policies are
--     kept (realtime, customer order tracking).
--
-- H2. `customers_insert` / `customers_update` let any signed-in user write a row
--     whose id is their own auth uid (`is_self_customer(id)`) at ANY tenant,
--     binding any email, then read that email's future guest orders. Nothing in
--     the app writes a customer row with a user JWT (guest checkout and the OTP
--     path run server-side with the service role), so the self branch is removed.
--     Customers can still READ their own row (customers_select is unchanged).
--
-- M2. `public.users.email` was updatable by the user themself, and email is used
--     as an identity key (createTenant, the auth.users bridge). Nothing in the
--     app updates public.users with a user JWT (the bridge trigger and the
--     service-role driver do), so UPDATE is revoked from `authenticated`/`anon`.
--
-- Re-runnable: revokes are idempotent, policies use drop-if-exists + create.
-- Live-safe: grants and policies only; lock_timeout bounds the table locks.
-- DEPLOY ORDER: any order (the code does not depend on these grants).
-- ============================================================================

begin;
set local lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- H1: no direct client writes to money / fulfillment tables.
-- ---------------------------------------------------------------------------
revoke insert, update, delete on table
  public.orders,
  public.order_items,
  public.payments,
  public.deliveries,
  public.shift_cash_events
from authenticated, anon;

drop policy if exists orders_insert on public.orders;
drop policy if exists orders_update on public.orders;
drop policy if exists orders_delete on public.orders;
drop policy if exists order_items_write on public.order_items;
drop policy if exists payments_write on public.payments;
drop policy if exists deliveries_write on public.deliveries;
drop policy if exists shift_cash_events_write on public.shift_cash_events;
-- Kept: orders_select, order_items_select, payments_select, deliveries_select,
-- shift_cash_events_select.

-- ---------------------------------------------------------------------------
-- H2: a signed-in user can no longer create or edit a customer row as "self".
-- ---------------------------------------------------------------------------
drop policy if exists customers_insert on public.customers;
create policy customers_insert on public.customers
  for insert
  with check (
    public.is_platform_admin()
    or public.is_tenant_member(tenant_id)
  );

drop policy if exists customers_update on public.customers;
create policy customers_update on public.customers
  for update
  using (
    public.is_platform_admin()
    or public.is_tenant_member(tenant_id)
  )
  with check (
    public.is_platform_admin()
    or public.is_tenant_member(tenant_id)
  );

-- ---------------------------------------------------------------------------
-- M2: public.users is not client-updatable (email is an identity key).
-- ---------------------------------------------------------------------------
revoke update on table public.users from authenticated, anon;
revoke update (email) on table public.users from authenticated, anon;

commit;

notify pgrst, 'reload schema';
