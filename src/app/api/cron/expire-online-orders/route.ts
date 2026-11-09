/**
 * Abandonment sweeper -- GET /api/cron/expire-online-orders
 *
 * Vercel Cron (every 5 minutes, see vercel.json) calls this with
 * `Authorization: Bearer $CRON_SECRET`. Every `awaiting_payment` online order
 * past its expiry window is closed on its payment provider and moved to
 * `abandoned` (or finalized if its payment landed). It also voids `/v1` held
 * orders (`draft`, hold `awaiting_payment`) whose hold expired, prunes stored
 * quotes, and sweeps refund requests stuck pending (sweepPendingRefunds). See
 * `src/lib/shop/lifecycle.ts`.
 *
 * Auth: `CRON_SECRET` is REQUIRED. The one exception is the in-memory mock driver
 * (zero-env dev/CI), where there is no data worth protecting and the route is
 * callable without a secret so the sweeper can be exercised end to end.
 */
import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { getPosDriver } from "@/lib/db";
import { expireHeldOrders, expireOnlineOrders } from "@/lib/shop/lifecycle";
import { usingMockDriver } from "@/lib/payments/env";
import { reconcileTerminalTenders } from "@/lib/payments/terminal/flow";
import { captureError } from "@/lib/observability";
import { sweepDriverDispatches } from "@/lib/delivery/service";
import { sweepPendingRefunds } from "@/lib/adjustments/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Provider cancels + paging can take a while on a busy night; give the sweep room.
export const maxDuration = 60;

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return usingMockDriver();
  const given = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret}`;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function GET(request: Request) {
  const startedAt = Date.now();
  if (!authorized(request)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  const summary = await expireOnlineOrders();
  // Stored /v1 quotes long past their validity window.
  const quotesPruned = await getPosDriver()
    .pruneExpiredQuotes(new Date(startedAt - 60 * 60_000).toISOString())
    .catch((err) => {
      captureError(err, { scope: "prune-quotes-cron" });
      return null;
    });
  // Print-job retention: finished (done/failed/expired) jobs older than 3 days.
  const printJobsPruned = await getPosDriver()
    .pruneFinishedPrintJobs(new Date(startedAt - 3 * 24 * 60 * 60_000).toISOString())
    .catch((err) => {
      captureError(err, { scope: "prune-print-jobs-cron" });
      return null;
    });
  // Also sweep in-store card-reader tenders left open (tablet died mid-payment):
  // re-read from Stripe, capture if it went through, else cancel. Failure here
  // must not fail the online-order sweep.
  const terminal = await reconcileTerminalTenders({
    // Inside maxDuration: whatever the online sweep left, at most 30s (the held sweep runs after it).
    budgetMs: Math.max(5_000, Math.min(30_000, 55_000 - (Date.now() - startedAt))),
  }).catch((err) => {
    captureError(err, { scope: "terminal-reconcile-cron" });
    return null;
  });
  // /v1 held orders whose hold ran out (draft + awaiting_payment). Failure here
  // must not fail the online-order sweep.
  const held = await expireHeldOrders(undefined, {
    // Inside maxDuration, after the terminal reconcile: whatever is left (>= 3s).
    budgetMs: Math.max(3_000, 55_000 - (Date.now() - startedAt)),
  }).catch((err) => {
    captureError(err, { scope: "expire-held-orders-cron" });
    return null;
  });
  // Open Pizza Driver dispatches that were not confirmed (driver or hub down):
  // retry with the same idempotency key, give up after 15 minutes. A no-op when
  // no driver delivery is waiting. Failure here must not fail the sweep.
  const driverDispatch = await sweepDriverDispatches(
    new Date(),
    10,
    // Last, inside maxDuration: whatever the sweeps above left (<= 20 s, >= 3 s).
    Math.max(3_000, Math.min(20_000, 57_000 - (Date.now() - startedAt))),
  ).catch((err) => {
    captureError(err, { scope: "driver-dispatch-sweep-cron" });
    return null;
  });
  // Refund requests stuck pending > 15 min: alerted; their card / stored-value
  // refunds still pending at the provider are finished with the same key.
  const refunds = await sweepPendingRefunds().catch((err) => {
    captureError(err, { scope: "refund-sweep-cron" });
    return null;
  });
  return NextResponse.json(
    { ...summary, held, quotesPruned, printJobsPruned, terminal, driverDispatch, refunds },
    { headers: { "Cache-Control": "no-store" } },
  );
}
