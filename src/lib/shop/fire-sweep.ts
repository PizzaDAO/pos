/**
 * Fire sweep for scheduled online orders (audit 2026-11-18 pos P1-1). Vercel
 * cron calls it every minute (`/api/cron/fire-scheduled-orders`).
 *
 * A paid scheduled order is held off the KDS and the printer until its fire time
 * (src/lib/kds/fire.ts). The KDS needs no sweep: it compares the fire time with
 * the clock on every read. This sweep does the rest at the fire time:
 *   1. auto-prints the ticket (if the location opted in), deduped on
 *      `fire:<orderId>` so a re-run or an earlier print never prints twice;
 *   2. stamps `fulfillment.kitchen_released_at`, which takes the order out of the
 *      next sweep and bumps the row so a Realtime KDS refetches right away.
 *
 * Stateless and idempotent: a missed minute (cold start, deploy) is caught up by
 * the next run, since every due, unreleased order is listed again.
 */
import { getPosDriver } from "@/lib/db";
import { deploymentCheckoutMode } from "@/lib/payments/env";
import { autoPrintOnFire } from "@/lib/printing/queue";
import { captureError } from "@/lib/observability";

const PAGE_SIZE = 100;

export interface FireSweepSummary {
  released: number;
  printed: number;
  failed: number;
}

export async function releaseDueScheduledOrders(
  now: Date = new Date(),
  opts: { budgetMs?: number } = {},
): Promise<FireSweepSummary> {
  const driver = getPosDriver();
  const started = Date.now();
  const budget = opts.budgetMs ?? 45_000;
  const summary: FireSweepSummary = { released: 0, printed: 0, failed: 0 };
  const due = await driver.listDueScheduledOrders(now.toISOString(), {
    limit: PAGE_SIZE,
    checkoutMode: deploymentCheckoutMode(),
  });
  for (const order of due) {
    if (Date.now() - started > budget) break;
    try {
      // Never throws (printing must not block the release).
      summary.printed += await autoPrintOnFire(order);
      await driver.mergeOrderFulfillment(order.id, {
        kitchen_released_at: now.toISOString(),
      });
      summary.released += 1;
    } catch (err) {
      summary.failed += 1;
      captureError(err, {
        scope: "releaseDueScheduledOrders",
        orderId: order.id,
      });
    }
  }
  return summary;
}
