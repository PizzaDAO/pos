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
--     Extended to order_item_modifiers, shifts, inventory_movements, staff and
--     magic_link_tokens (same proof: no user-JWT client writes any table).
--
-- H2. `customers_insert` / `customers_update` let any signed-in user write a row
--     whose id is their own auth uid (`is_self_customer(id)`) at ANY tenant,
--     binding any email, then read that email's future guest orders. Nothing in
--     the app writes a customer row with a user JWT (guest checkout and the OTP
--     path run server-side with the service role), so client writes to
--     customers are revoked and every write policy is dropped. Customers can
--     still READ their own row (customers_select is unchanged).
--
-- M2. `public.users.email` was updatable by the user themself, and email is used
--     as an identity key (createTenant, the auth.users bridge). Nothing in the
--     app updates public.users with a user JWT (the bridge trigger and the
--     service-role driver do), so UPDATE is revoked from `authenticated`/`anon`.
--
-- Re-runnable: revokes are idempotent, policies use drop-if-exists.
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
-- H1 (extended): the rest of the operational tables the app writes only with
-- the service role. SELECT is kept where a tenant-scoped read policy exists.
--   order_item_modifiers, shifts, inventory_movements: like orders/payments.
--   staff: also closes L4 (a manager writing a known pin_hash onto the owner's
--     row and PIN-switching as owner) and the role/user_id relink paths.
--   magic_link_tokens: the legacy never-emailed shop token. Members could mint
--     or un-consume one for any customer of their tenant; consuming it only sets
--     the untrusted legacy `customers.verified` flag (no session is created), but
--     a token is a bearer secret, so SELECT is revoked too and no policy is left.
-- ---------------------------------------------------------------------------
revoke insert, update, delete on table
  public.order_item_modifiers,
  public.shifts,
  public.inventory_movements,
  public.staff,
  public.magic_link_tokens
from authenticated, anon;
revoke select on table public.magic_link_tokens from authenticated, anon;

drop policy if exists order_item_modifiers_write on public.order_item_modifiers;
drop policy if exists shifts_write on public.shifts;
drop policy if exists inventory_movements_insert on public.inventory_movements;
drop policy if exists staff_write on public.staff;
drop policy if exists magic_link_tokens_all on public.magic_link_tokens;
-- Kept: order_item_modifiers_select, shifts_select, inventory_movements_select,
-- staff_select (pin_hash stays non-selectable by column grant).

-- ---------------------------------------------------------------------------
-- H2: only the service role writes customers. Guest checkout (ensureCustomer /
-- upsertCustomer), the OTP path (core_upsert_customer, service_role only), the
-- legacy verify stub and the /v1 customers API all run server-side. Dropping
-- the self branch closes the cross-tenant plant; dropping the member branch
-- means a staff JWT cannot rewrite CRM rows either. customers_select (incl. a
-- customer reading their own row) is unchanged.
-- ---------------------------------------------------------------------------
revoke insert, update, delete on table public.customers from authenticated, anon;
drop policy if exists customers_insert on public.customers;
drop policy if exists customers_update on public.customers;
drop policy if exists customers_delete on public.customers;

-- ---------------------------------------------------------------------------
-- M2: public.users is not client-updatable (email is an identity key).
-- ---------------------------------------------------------------------------
revoke update on table public.users from authenticated, anon;
revoke update (email) on table public.users from authenticated, anon;

commit;

notify pgrst, 'reload schema';
