-- ============================================================================
-- Migration: billing_event_ordering   (PR #20 rebased; was part of
-- 20260611000000_tender_settlement_guards — the tender/refund half of that file
-- is dropped: main's 20261030000100_payment_refund_atomic + settlement code
-- cover it.)
--
--   * subscriptions.last_event_created: the Stripe `event.created` (unix
--     seconds) of the last Billing webhook applied to the row, so an older,
--     out-of-order event is ignored (src/lib/billing/webhook.ts). The server
--     driver writes this column on every subscription upsert, so this
--     migration must be applied BEFORE the code that uses it is deployed.
--   * subscriptions is SERVER-WRITE-ONLY. The tier is decided by Stripe (only
--     the Billing webhook sets it in real billing mode); an owner holding a
--     user JWT could otherwise upgrade their own tier straight through
--     PostgREST (subscriptions_write allowed owners). Same pattern as main's
--     20260610000000_connect_accounts_lockdown: drop the owner write policy and
--     revoke write privileges from authenticated/anon. The tenant-member SELECT
--     policy (subscriptions_select) and the SELECT grant stay. The app writes
--     subscriptions only through the service-role server driver.
--
-- IDEMPOTENT (if not exists / if exists / revoke is repeatable).
-- ============================================================================

alter table public.subscriptions
  add column if not exists last_event_created bigint;

drop policy if exists subscriptions_write on public.subscriptions;

revoke insert, update, delete on public.subscriptions from authenticated;
revoke insert, update, delete on public.subscriptions from anon;
