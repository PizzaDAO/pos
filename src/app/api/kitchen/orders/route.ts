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
 *   / retries never corrupt state. A Ready / out-for-delivery ticket whose
 *   delivery is provider-run (not in_house_manual) can't be bumped (no-op).
 *
 * Auth: an operational role (kitchen surface) of the tenant; the location must
 * belong to it. Bump/recall resolves the ORDER first and authorizes against the
 * order's own tenant (never a client-supplied tenant).
 *
 * No env vars are read — everything runs against the in-memory mock driver.
 */
import { after, NextResponse } from "next/server";
import { getPosDriver, KDS_ACTIVE_STATUSES } from "@/lib/db";
import { isPendingAcceptance, notifyMarketplaceReady } from "@/lib/marketplace/service";
import {
  buildTickets,
  buildVoidNotices,
  DEFAULT_KDS_THRESHOLDS,
  VOID_NOTICE_MS,
} from "@/lib/kds/board";
import {
  isHandoffStatus,
  kitchenHandsOffDelivery,
  nextBumpStatus,
  recallStatus,
} from "@/lib/kds/status";
import type { KitchenBoardResponse } from "@/lib/kds/types";
import {
  requireOrderAccess,
  requireTenantAccess,
} from "@/lib/auth/tenant-guard";

// In-memory mock state lives in the Node runtime; force it (not edge).
export const runtime = "nodejs";

/**
 * An order in an active status stays on the board while it was touched
 * (placed, released from a hold, bumped, edited) in the last week. Filtered on
 * updated_at, not created_at, so a catering order booked weeks ahead stays on
 * the board after its release. Only an active order nobody touched for a week
 * drops off.
 */
const KDS_ACTIVE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** The delivery record's provider for an order (null when none / unreadable). */
async function deliveryProviderOf(orderId: string): Promise<string | null> {
  try {
    return (await getPosDriver().getDeliveryForOrder(orderId))?.provider ?? null;
  } catch {
    return null;
  }
}

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
  const now = new Date();
  // Filtered in SQL: active tickets touched in the last week, plus anything changed
  // inside the void-notice window (a voided order or line). Not the location's
  // whole order history.
  const [orders, settings] = await Promise.all([
    driver.listKitchenOrders(tenantId, locationId, {
      statuses: KDS_ACTIVE_STATUSES,
      activeSince: new Date(now.getTime() - KDS_ACTIVE_WINDOW_MS).toISOString(),
      updatedSince: new Date(now.getTime() - VOID_NOTICE_MS).toISOString(),
    }),
    driver.getStoreSettings(tenantId, locationId),
  ]);

  const thresholds = settings.kds_thresholds ?? DEFAULT_KDS_THRESHOLDS;
  const built = buildTickets(orders, now, thresholds);
  // Delivery tickets carry their delivery record's provider: it decides whether
  // the kitchen offers a hand-off (in-house only).
  const tickets = await Promise.all(
    built.map(async (t) =>
      t.order.channel === "online_delivery"
        ? { ...t, deliveryProvider: await deliveryProviderOf(t.order.id) }
        : t,
    ),
  );

  const body: KitchenBoardResponse = {
    tickets,
    voided: buildVoidNotices(orders, now),
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

  // A marketplace order the cashier has not accepted is not the kitchen's yet:
  // no bump, no recall (accept / reject / provider cancel are its only moves).
  if (isPendingAcceptance(current)) {
    return NextResponse.json(
      { error: "Accept this marketplace order before the kitchen can bump it." },
      { status: 409 },
    );
  }

  // A provider-run delivery (DoorDash, the driver module) leaves the kitchen
  // through the provider: the KDS never moves it past Ready.
  const providerOwned =
    action === "bump" &&
    isHandoffStatus(current.status) &&
    current.channel === "online_delivery" &&
    !kitchenHandsOffDelivery(current, await deliveryProviderOf(current.id));
  const next = providerOwned
    ? null
    : action === "bump"
      ? nextBumpStatus(current.status, current.channel)
      : recallStatus(current.status);

  // No-op (already terminal for this action) → return unchanged, idempotently.
  if (!next || next === current.status) {
    return NextResponse.json({ order: current, changed: false });
  }

  // Compare-and-set on the status the guard just read (no second read): a
  // concurrent bump that already moved the order makes this a no-op that
  // returns the order as it now is.
  const res = await driver.casOrderStatus(id, [current.status], next);
  if (!res.ok && res.reason === "not_found") {
    return NextResponse.json({ error: "Order not found." }, { status: 404 });
  }
  if (!res.ok) return NextResponse.json({ order: res.order, changed: false });
  const updated = res.order;
  // Marketplace order bumped to ready: tell the provider (best effort, inert
  // unless the provider is configured).
  // Never awaited by the bump: runs after the response (or detached, outside a
  // request scope such as tests).
  if (updated && next === "ready" && updated.channel === "marketplace") {
    const notify = () => notifyMarketplaceReady(updated);
    try {
      after(notify);
    } catch {
      void notify();
    }
  }
  return NextResponse.json({ order: updated, changed: true });
}
