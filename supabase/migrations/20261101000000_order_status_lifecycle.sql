-- Online checkout lifecycle (slice 1): two new order statuses.
--
-- Enum values live in their OWN migration file: `ALTER TYPE ... ADD VALUE` cannot
-- be used in the same transaction as statements that reference the new value
-- (20261101000100_online_checkout.sql does, in an index predicate).
--
--   awaiting_payment  initial status of every online order; off the KDS, no
--                     inventory depletion, no delivery dispatch.
--   abandoned         terminal: the checkout expired or was cancelled unpaid.
alter type public.order_status add value if not exists 'awaiting_payment' before 'placed';
alter type public.order_status add value if not exists 'abandoned';
