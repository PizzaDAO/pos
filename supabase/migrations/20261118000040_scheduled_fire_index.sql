-- ============================================================================
-- Migration: scheduled_fire_index (audit 2026-11-18 pos P1-1, PR #55)
--
-- Partial index for the scheduled-order fire sweep (listDueScheduledOrders, the
-- /api/cron/fire-scheduled-orders cron every minute): paid orders that carry a
-- kitchen fire time and were not released yet. It stays tiny (only scheduled
-- orders waiting to fire), so the per-minute query never scans orders.
--
-- Backward compatible: an index only, no schema or function change. The code
-- works without it (the query is just slower), so it can be applied before or
-- after the merge.
--
-- The predicate is written exactly like the PostgREST filter (->> is not null /
-- is null), so the planner can prove the query implies it.
--
-- Plain (not CONCURRENTLY): this file runs inside a transaction, like every
-- hand-applied POS migration. Building a partial index over the few `paid`
-- orders is quick; the lock_timeout makes it give up rather than queue behind a
-- long write on orders (just re-run it).
-- ============================================================================

begin;
set local lock_timeout = '3s';

create index if not exists orders_scheduled_fire_due_idx
  on public.orders (((fulfillment ->> 'kitchen_fire_at')))
  where status = 'paid'
    and (fulfillment ->> 'kitchen_fire_at') is not null
    and (fulfillment ->> 'kitchen_released_at') is null;

notify pgrst, 'reload schema';

commit;
