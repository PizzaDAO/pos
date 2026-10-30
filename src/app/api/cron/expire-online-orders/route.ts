/**
 * Abandonment sweeper -- GET /api/cron/expire-online-orders
 *
 * Vercel Cron (every 5 minutes, see vercel.json) calls this with
 * `Authorization: Bearer $CRON_SECRET`. Every `awaiting_payment` online order
 * past its expiry window is closed on its payment provider and moved to
 * `abandoned` (or finalized if its payment landed). See `src/lib/shop/lifecycle.ts`.
 *
 * Auth: `CRON_SECRET` is REQUIRED. The one exception is the in-memory mock driver
 * (zero-env dev/CI), where there is no data worth protecting and the route is
 * callable without a secret so the sweeper can be exercised end to end.
 */
import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { expireOnlineOrders } from "@/lib/shop/lifecycle";
import { usingMockDriver } from "@/lib/payments/env";
import { reconcileTerminalTenders } from "@/lib/payments/terminal/flow";
import { captureError } from "@/lib/observability";

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
  // Also sweep in-store card-reader tenders left open (tablet died mid-payment):
  // re-read from Stripe, capture if it went through, else cancel. Failure here
  // must not fail the online-order sweep.
  const terminal = await reconcileTerminalTenders({
    // Inside maxDuration: whatever the online sweep left, at most 40s.
    budgetMs: Math.max(5_000, Math.min(40_000, 55_000 - (Date.now() - startedAt))),
  }).catch((err) => {
    captureError(err, { scope: "terminal-reconcile-cron" });
    return null;
  });
  return NextResponse.json(
    { ...summary, terminal },
    { headers: { "Cache-Control": "no-store" } },
  );
}
