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

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
  if (!authorized(request)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  const summary = await expireOnlineOrders();
  return NextResponse.json(summary, { headers: { "Cache-Control": "no-store" } });
}
