-- ============================================================================
-- Migration: audit_delivery_override
--
-- New audit action the application writes: delivery_manual_override, recorded
-- when a manager overrides a stuck driver conflict ("dispatch manually instead")
-- and the delivery switches to in-house. Previously logged as connect_change.
-- Audit writes are fail-open, so until this value exists the entry would be
-- dropped silently: DEPLOY ORDER migration first, then code.
--
-- Additive and live-safe: enum value only (ADD VALUE IF NOT EXISTS; nothing in
-- this transaction uses it). lock_timeout bounds the catalog lock.
-- ============================================================================

begin;
set local lock_timeout = '3s';

alter type public.audit_action add value if not exists 'delivery_manual_override';

commit;

notify pgrst, 'reload schema';
