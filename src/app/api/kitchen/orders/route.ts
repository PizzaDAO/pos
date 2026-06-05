/**
 * Kitchen Display System order feed (Phase 3).
 *
 * GET  /api/kitchen/orders?tenantId=&locationId=
 *   Returns the active tickets for a location with elapsed time, age coloring,
 *   and station routing computed SERVER-SIDE (so every connected screen renders
 *   identical colors with no clock drift). This is the endpoint the realtime
 *   polling provider hits on its interval; a Supabase Realtime provider would
 *   reuse the same fetch for the initial load + on each change.
 *
 * POST /api/kitchen/orders   body: { id, action: "bump" | "recall" }
 *   Advances (bump) or re-opens (recall) an order's status through the DB
 *   abstraction. Idempotent: bumping a `completed` order or recalling an
 *   in-progress one is a no-op that returns the unchanged order, so double-taps
 *   / retries never corrupt state.
 *
 * No env vars are read — everything runs against the in-memory mock driver.
 */
import { NextResponse } from "next/server";
import { getPosDriver } from "@/lib/db";
import { buildTickets, DEFAULT_KDS_THRESHOLDS } from "@/lib/kds/board";
import { nextBumpStatus, recallStatus } from "@/lib/kds/status";
import type { KitchenBoardResponse } from "@/lib/kds/types";

// In-memory mock state lives in the Node runtime; force it (not edge).
export const runtime = "nodejs";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const tenantId = searchParams.get("tenantId");
  const locationId = searchParams.get("locationId");
  if (!tenantId || !locationId) {
    return NextResponse.json(
      { error: "tenantId and locationId are required." },
      { status: 400 },
    );
  }

  const driver = getPosDriver();
  const [orders, settings] = await Promise.all([
    driver.listOrders(tenantId, locationId),
    driver.getStoreSettings(tenantId, locationId),
  ]);

  const now = new Date();
  const thresholds = settings.kds_thresholds ?? DEFAULT_KDS_THRESHOLDS;
  const tickets = buildTickets(orders, now, thresholds);

  const body: KitchenBoardResponse = {
    tickets,
    driver: driver.name,
    serverTime: now.toISOString(),
    thresholds,
  };
  // No caching — the board must reflect the latest status on every poll.
  return NextResponse.json(body, {
    headers: { "Cache-Control": "no-store" },
  });
}

interface BumpBody {
  id: unknown;
  action: unknown;
}

export async function POST(request: Request) {
  let body: BumpBody;
  try {
    body = (await request.json()) as BumpBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const id = typeof body.id === "string" ? body.id : null;
  const action = body.action === "bump" || body.action === "recall"
    ? body.action
    : null;
  if (!id || !action) {
    return NextResponse.json(
      { error: 'Body must be { id: string, action: "bump" | "recall" }.' },
      { status: 422 },
    );
  }

  const driver = getPosDriver();
  const current = await driver.getOrder(id);
  if (!current) {
    return NextResponse.json({ error: "Order not found." }, { status: 404 });
  }

  const next =
    action === "bump"
      ? nextBumpStatus(current.status, current.channel)
      : recallStatus(current.status);

  // No-op (already terminal for this action) → return unchanged, idempotently.
  if (!next || next === current.status) {
    return NextResponse.json({ order: current, changed: false });
  }

  const updated = await driver.updateOrderStatus(id, next);
  return NextResponse.json({ order: updated, changed: true });
}
