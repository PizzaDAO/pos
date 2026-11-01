-- ============================================================================
-- Migration: core_quotes  (pos-v1-gaps, phase 1.2)
--
-- Stored /v1 quotes. `POST /quotes` persists the validated request; later
-- `GET /quotes/{id}` and `POST /orders` with `quote_id` (and no `lines`) reload
-- the request and RE-PRICE it server-side. Nothing stored here is trusted for
-- money: `request` is only the cart, `quote_hash` only detects drift.
--
-- Additive and live-safe: one new table, no change to any existing table.
-- Service role only: RLS is forced with no policies, anon/authenticated have no
-- grants. Rows are pruned by the expire cron (see driver.pruneExpiredQuotes).
-- ============================================================================

begin;
set local lock_timeout = '3s';

create table if not exists public.core_quotes (
  id text primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  location_id uuid not null references public.locations(id) on delete cascade,
  request jsonb not null,
  quote_hash text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists core_quotes_expires_idx
  on public.core_quotes (expires_at);
create index if not exists core_quotes_tenant_idx
  on public.core_quotes (tenant_id, created_at desc);

alter table public.core_quotes enable row level security;
alter table public.core_quotes force row level security;
revoke all on public.core_quotes from anon, authenticated;

commit;

notify pgrst, 'reload schema';
