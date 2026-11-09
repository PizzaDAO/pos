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

create unique index if not exists orders_marketplace_ref_uq
  on public.orders (location_id, (source->>'module'), (source->>'external_ref'))
  where source->>'type' = 'marketplace';

commit;

notify pgrst, 'reload schema';
