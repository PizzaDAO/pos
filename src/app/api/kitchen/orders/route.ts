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
 * Auth: an operational role (kitchen surface) of the tenant; the location must
 * belong to it. Bump/recall resolves the ORDER first and authorizes against the
 * order's own tenant (never a client-supplied tenant).
 *
 * No env vars are read — everything runs against the in-memory mock driver.
 */
import { NextResponse } from "next/server";
import { getPosDriver } from "@/lib/db";
import { buildTickets, DEFAULT_KDS_THRESHOLDS } from "@/lib/kds/board";
import { nextBumpStatus, recallStatus } from "@/lib/kds/status";
import type { KitchenBoardResponse } from "@/lib/kds/types";
import {
  requireOrderAccess,
  requireTenantAccess,
} from "@/lib/auth/tenant-guard";

// In-memory mock state lives in the Node runtime; force it (not edge).
export const runtime = "nodejs";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const auth = await requireTenantAccess(
    searchParams.get("tenantId"),
    "kitchen",
    { locationId: searchParams.get("locationId"), requireLocation: true },
  );
  if (!auth.ok) return auth.res;
  const tenantId = auth.tenantId;
  const locationId = auth.locationId as string;

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
  const auth = await requireOrderAccess(id, "kitchen");
  if (!auth.ok) return auth.res;
  const current = auth.order;

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
