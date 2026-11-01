-- ============================================================================
-- Migration: audit_actions_scheduled_country  (catering follow-ups review)
--
-- Two new audit actions the application writes:
--   * scheduled_order_canceled: staff canceled an expired scheduled (catering)
--     order whose invoice was never paid; no money moved.
--   * location_country_change: a location's country (how phone numbers are read)
--     was changed in /admin.
-- Audit writes are fail-open, so until these values exist the entries would be
-- dropped silently: DEPLOY ORDER migration first, then code.
--
-- Additive and live-safe: enum values only (ADD VALUE IF NOT EXISTS; nothing in
-- this transaction uses them). lock_timeout bounds the catalog lock.
-- ============================================================================

begin;
set local lock_timeout = '3s';

alter type public.audit_action add value if not exists 'scheduled_order_canceled';
alter type public.audit_action add value if not exists 'location_country_change';

commit;

notify pgrst, 'reload schema';
