-- ============================================================================
-- Migration: marketplace_inbox
--
-- Storage for the DoorDash / Uber Eats / Grubhub order inbox (src/lib/marketplace).
--
--   * order_channel gets 'marketplace'. A new enum value cannot be USED in the
--     transaction that adds it, so nothing below references it (the unique index
--     keys on source->>'type', not on channel).
--   * store_settings.marketplace jsonb (nullable): per-location enablement,
--     auto-accept and per-provider store ids. NULL = off; nothing is ingested and
--     nothing calls out to a provider.
--   * orders_marketplace_ref_uq: one order per (location, provider, external id).
--     The ingest code derives the order id from the same tuple, so a replayed
--     webhook is already a no-op; this index is the database-level backstop
--     against a double insert under concurrent deliveries.
--
-- Additive and live-safe: a nullable column (metadata-only), an enum value, and a
-- partial unique index on rows that cannot exist yet. lock_timeout bounds the
-- catalog lock.
-- ============================================================================

begin;
set local lock_timeout = '3s';

alter type public.order_channel add value if not exists 'marketplace';

alter table public.store_settings add column if not exists marketplace jsonb;

-- NOTE: if public.orders is large, build this index CONCURRENTLY outside a
-- transaction instead (it takes a write lock on orders while building). Volume
-- is tiny today, so the plain statement is fine.
create unique index if not exists orders_marketplace_ref_uq
  on public.orders (location_id, (source->>'module'), (source->>'external_ref'))
  where source->>'type' = 'marketplace';

-- marketplace_stores: which provider store belongs to which location. ASSIGNED BY
-- A PLATFORM ADMIN ONLY (tenants cannot write it: a tenant that could claim a
-- store id could receive another restaurant's orders). The primary key is the
-- uniqueness guarantee: one (provider, store_id) -> exactly one location; the
-- second constraint gives a location one store per provider. Webhooks route by
-- this table. Service-role only (RLS forced, no policy, no client grants).
create table if not exists public.marketplace_stores (
  provider text not null,
  store_id text not null check (btrim(store_id) <> ''),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  location_id uuid not null references public.locations (id) on delete cascade,
  assigned_by text,
  assigned_at timestamptz not null default now(),
  primary key (provider, store_id),
  unique (location_id, provider)
);

alter table public.marketplace_stores enable row level security;
alter table public.marketplace_stores force row level security;
revoke all on public.marketplace_stores from anon, authenticated;
grant select, insert, update, delete on public.marketplace_stores to service_role;

commit;

notify pgrst, 'reload schema';
