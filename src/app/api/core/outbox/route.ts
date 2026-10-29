/**
 * Outbox delivery worker (cron): signs pending `core_outbox` events with
 * Standard Webhooks and POSTs them to the hub ingest URL, retrying failures on
 * the contract schedule.
 *
 *   GET|POST /api/core/outbox   Authorization: Bearer $CRON_SECRET
 *
 * Env: OPENPIZZA_HUB_INGEST_URL, OPENPIZZA_HUB_WEBHOOK_SECRET (whsec_..., comma
 * separated during rotation), CRON_SECRET. With the hub env unset it is a no-op
 * (events stay queued), so zero-env builds and previews are unaffected.
 * Schedule it every minute (Vercel Cron on Pro, or any external scheduler).
 */
import { NextResponse } from "next/server";
import { deliverOutbox, getOutboxStore, readHubEnv } from "@/lib/core/outbox";
import { readSupabaseConfig } from "@/lib/db/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    // No secret: only the zero-env simulated mode may call this.
    return readSupabaseConfig() === null;
  }
  const given = req.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret}`;
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) {
    diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

async function run(req: Request): Promise<Response> {
  if (!authorized(req)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  const hub = readHubEnv();
  const store = getOutboxStore();
  // Triggers only enqueue while a hub is configured, so an unconfigured POS
  // never accumulates an unbounded backlog.
  await store.setEnabled?.(hub !== null).catch(() => undefined);
  await store.prune?.().catch(() => undefined);
  if (!hub) {
    return NextResponse.json({ skipped: "hub_not_configured" });
  }
  const result = await deliverOutbox({ ...hub, store });
  return NextResponse.json(result);
}

export const GET = run;
export const POST = run;
