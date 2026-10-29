-- Online checkout lifecycle (slice 1): indexes. Additive; safe to apply ahead of
-- the application code.

-- The abandonment sweeper scans only unpaid online orders, oldest first.
create index if not exists orders_awaiting_payment_idx
  on public.orders (created_at)
  where status = 'awaiting_payment';

-- One LIVE card (or Coinbase checkout) tender per order. Closes the concurrent
-- intent gap (docs/PRODUCTION_READINESS.md 11f): two simultaneous /api/payments
-- calls with different paymentIds can no longer each persist an open
-- stripe_online tender. A canceled/failed tender frees the slot, so a rail
-- switch or a retry after cancellation still works.
create unique index if not exists payments_one_live_card_or_cb
  on public.payments (order_id, rail)
  where rail in ('stripe_online', 'crypto_coinbase')
    and status not in ('canceled', 'failed');
