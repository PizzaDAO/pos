-- ============================================================================
-- Migration: payment_rail_external  (pos-v1-gaps, phase 2)
--
-- New payment rail for tenders recorded through `POST /v1/orders/{id}/payments`
-- (payments.recordExternal): money collected OUTSIDE POS's own processors (a
-- kiosk's card reader, cash on delivery, a paid invoice, a gift card captured by
-- guests). It gets its own rail so the cash drawer math and the Stripe code paths
-- never see it.
--
-- A new enum value cannot be used in the transaction that adds it, so this is its
-- own migration; the next one (20261106000100) uses it. Additive and live-safe.
-- ============================================================================

begin;
set local lock_timeout = '3s';

alter type public.payment_rail add value if not exists 'external';

commit;

notify pgrst, 'reload schema';
