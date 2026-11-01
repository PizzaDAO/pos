-- ============================================================================
-- Migration: payment_sessions  (pos-v1-gaps, phase 1.3)
--
-- Hosted pay links for `POST /v1/orders/{id}/payment-sessions` (Stripe Checkout
-- on the tenant's connected account, or a simulated page). Each session has
-- exactly one `stripe_online` tender row (created with the session, status
-- `requires_action`, `charge_id` null until Stripe creates the PaymentIntent);
-- the tender is what the money flows through, the session is only the link.
--
--   * id: random and unguessable (it appears in the simulated pay URL).
--   * (tenant_id, idempotency_key) unique: same key + same body replays.
--   * one OPEN session per order (partial unique index).
--   * stripe_session_id unique (nullable).
--
-- Additive and live-safe: one new table. Service role only: RLS forced with no
-- policies, anon/authenticated have no grants.
-- ============================================================================

begin;
set local lock_timeout = '3s';

create table if not exists public.payment_sessions (
  id text primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  order_id uuid not null references public.orders(id) on delete cascade,
  -- Set to the tender (payments.id) once the session is captured.
  payment_id uuid,
  status text not null default 'open'
    check (status in ('open', 'completed', 'expired', 'canceled')),
  url text not null,
  stripe_session_id text unique,
  currency text not null,
  amount_cents integer not null check (amount_cents >= 0),
  tip_cents integer not null default 0 check (tip_cents >= 0),
  application_fee_cents integer not null default 0 check (application_fee_cents >= 0),
  idempotency_key text not null,
  request_hash text not null,
  success_url text not null,
  cancel_url text,
  expires_at timestamptz not null,
  simulated boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, idempotency_key)
);

create unique index if not exists payment_sessions_one_open_per_order
  on public.payment_sessions (order_id)
  where status = 'open';
create index if not exists payment_sessions_order_idx
  on public.payment_sessions (order_id);

alter table public.payment_sessions enable row level security;
alter table public.payment_sessions force row level security;
revoke all on public.payment_sessions from anon, authenticated;

commit;

notify pgrst, 'reload schema';
