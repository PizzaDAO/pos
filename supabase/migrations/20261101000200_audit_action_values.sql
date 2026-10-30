-- Audit actions. Enum values live in their own file (ALTER TYPE ... ADD VALUE
-- cannot share a transaction with statements that use the new value).
--
-- Adds the late-payment actions of the online checkout lifecycle, and also the
-- Phase 7 values the application already writes (payment_refund, payment_void,
-- auth_sign_in, ...) which the original 5-value enum never contained: audit
-- writes are fail-open, so those entries were being dropped.
alter type public.audit_action add value if not exists 'auth_sign_in';
alter type public.audit_action add value if not exists 'staff_pin_switch';
alter type public.audit_action add value if not exists 'membership_change';
alter type public.audit_action add value if not exists 'payment_refund';
alter type public.audit_action add value if not exists 'payment_void';
alter type public.audit_action add value if not exists 'menu_86';
alter type public.audit_action add value if not exists 'connect_change';
alter type public.audit_action add value if not exists 'subscription_change';
alter type public.audit_action add value if not exists 'tenant_go_live';
alter type public.audit_action add value if not exists 'late_payment_flagged';
alter type public.audit_action add value if not exists 'late_payment_accepted';
alter type public.audit_action add value if not exists 'late_payment_refunded';
