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
--   * billing_checkout_sessions: the tenant's ONE open Stripe Checkout
--     Session for a new subscription (see below). Server-only.
--
-- IDEMPOTENT (if not exists / if exists / revoke is repeatable).
-- ============================================================================

alter table public.subscriptions
  add column if not exists last_event_created bigint;

drop policy if exists subscriptions_write on public.subscriptions;

revoke insert, update, delete on public.subscriptions from authenticated;
revoke insert, update, delete on public.subscriptions from anon;

-- ---- One open billing Checkout Session per tenant (no double subscribe) -----
-- POST /api/billing {subscribe} used to open a NEW Stripe Checkout Session on
-- every click, so two tabs / a double click could each complete and leave the
-- tenant with two paid subscriptions. The server now records the tenant's open
-- session here and reuses (same tier) or expires-and-replaces / refuses it
-- before creating another; the tenant_id primary key makes the record atomic
-- (a concurrent second insert fails and that request reuses the winner). The
-- billing webhook accepts checkout.session.* ONLY for the recorded session id.
-- Server-only (service_role); RLS forced with no policies.
create table if not exists public.billing_checkout_sessions (
  tenant_id uuid primary key references public.tenants (id) on delete cascade,
  session_id text not null unique,
  tier public.plan_tier not null,
  url text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

alter table public.billing_checkout_sessions enable row level security;
alter table public.billing_checkout_sessions force row level security;
revoke all on public.billing_checkout_sessions from anon;
revoke all on public.billing_checkout_sessions from authenticated;
grant select, insert, update, delete on public.billing_checkout_sessions
  to service_role;
