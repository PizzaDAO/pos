-- ============================================================================
-- Migration: stored_value_enums  (gift cards + store credit, part 1 of 2)
--
-- New enum values the stored-value code writes:
--   * payment_rail 'gift_card' / 'store_credit': a tender redeemed from a card
--     (written only by sv_redeem in 20261113000410).
--   * audit_action 'gift_card_void' / 'store_credit_issue'.
--
-- A new enum value cannot be used in the transaction that adds it, so this is its
-- own migration; 20261113000410 uses them. Additive and live-safe (ADD VALUE IF
-- NOT EXISTS; nothing in this transaction uses them). DEPLOY ORDER: both
-- migrations first, then code (audit writes are fail-open, but a gift card
-- tender insert needs the rail value).
-- ============================================================================

begin;
set local lock_timeout = '3s';

alter type public.payment_rail add value if not exists 'gift_card';
alter type public.payment_rail add value if not exists 'store_credit';
alter type public.audit_action add value if not exists 'gift_card_void';
alter type public.audit_action add value if not exists 'store_credit_issue';

commit;

notify pgrst, 'reload schema';
