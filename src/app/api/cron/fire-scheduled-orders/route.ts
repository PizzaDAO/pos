/**
 * Scheduled-order fire sweep -- GET /api/cron/fire-scheduled-orders
 *
 * Vercel Cron (every minute, see vercel.json) calls this with
 * `Authorization: Bearer $CRON_SECRET`. Paid scheduled online orders whose fire
 * time (promised - prep) has come are auto-printed and stamped released. The KDS
 * does not depend on this run: it holds and releases scheduled orders on read.
 * See `src/lib/shop/fire-sweep.ts`.
 *
 * Auth: `CRON_SECRET` is REQUIRED, except on the in-memory mock driver (zero-env
 * dev/CI), same as /api/cron/expire-online-orders.
 */
import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { releaseDueScheduledOrders } from "@/lib/shop/fire-sweep";
import { usingMockDriver } from "@/lib/payments/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
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
  if (!authorized(request)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  const summary = await releaseDueScheduledOrders(new Date(), {
    budgetMs: 50_000,
  });
  return NextResponse.json(summary, {
    headers: { "Cache-Control": "no-store" },
  });
}
