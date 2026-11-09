/**
 * In-house dispatch view + manual driver assignment (Phase 4 /admin).
 *
 * GET  /api/delivery/dispatch?tenantId=&locationId=
 *   Lists a location's deliveries (newest first) for the dispatch board, each
 *   with its order number + status, so a dispatcher can see what needs a driver.
 *
 * POST /api/delivery/dispatch  body: { deliveryId, driverName, driverPhone? }
 *   Assigns a driver to an in-house delivery (pending_assignment → assigned) and
 *   flips the order to `out_for_delivery` (surfaces on the KDS + customer tracker).
 *
 *   An `openpizza_driver` delivery is refused (409): its state comes from the
 *   driver module, and a hand-assignment would fork it.
 *
 * POST /api/delivery/dispatch  body: { deliveryId, action: "dispatchManually" }
 *   "Dispatch manually instead": the explicit, manager-only fallback that turns
 *   an `openpizza_driver` delivery into an in-house one (`pending_assignment`).
 *   Refused while the driver may still be carrying it. Never automatic.
 *
 * Auth: owner|manager (admin surface) of the tenant. Assignment resolves the
 * delivery first and authorizes against ITS tenant.
 *
 * No env vars required.
 */
import { NextResponse } from "next/server";
import { getPosDriver } from "@/lib/db";
import {
  DeliveryNotAssignableError,
  assignDriver,
  dispatchManuallyInstead,
} from "@/lib/delivery/service";
import { requireAdminAccess } from "@/lib/auth/admin-gate";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const auth = await requireAdminAccess(request, searchParams.get("tenantId"), {
    locationId: searchParams.get("locationId"),
    requireLocation: true,
  });
  if (!auth.ok) return auth.res;
  const tenantId = auth.tenantId;
  const locationId = auth.locationId as string;
  const driver = getPosDriver();
  const deliveries = await driver.listDeliveries(tenantId, locationId);
  // Enrich each with its order number for the dispatch board. One batched read
  // (getOrdersByIds chunks 100 ids per query) instead of a getOrder per row.
  const ordersById = new Map(
    (
      await driver.getOrdersByIds(
        tenantId,
        deliveries.map((d) => d.order_id),
      )
    ).map((o) => [o.id, o]),
  );
  const rows = deliveries.map((d) => {
    const order = ordersById.get(d.order_id);
    return {
      delivery: d,
      orderNumber: order?.order_number ?? null,
      orderStatus: order?.status ?? null,
    };
  });
  return NextResponse.json(
    { deliveries: rows, serverTime: new Date().toISOString() },
    { headers: { "Cache-Control": "no-store" } },
  );
}

interface AssignBody {
  deliveryId: string;
  driverName: string;
  driverPhone?: string;
}

function isValid(body: unknown): body is AssignBody {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  return typeof b.deliveryId === "string" && typeof b.driverName === "string";
}

function isManualSwitch(
  body: unknown,
): body is {
  deliveryId: string;
  action: "dispatchManually";
  confirmNotWithDriver?: boolean;
} {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  return typeof b.deliveryId === "string" && b.action === "dispatchManually";
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (!isValid(body) && !isManualSwitch(body)) {
    return NextResponse.json(
      { error: "deliveryId and driverName are required." },
      { status: 422 },
    );
  }

  // Authorize against the delivery's OWN tenant (not a client-supplied one).
  const existing = await getPosDriver()
    .getDelivery(body.deliveryId)
    .catch(() => null);
  if (!existing) {
    return NextResponse.json({ error: "Delivery not found." }, { status: 404 });
  }
  const auth = await requireAdminAccess(request, existing.tenant_id);
  if (!auth.ok) return auth.res;

  if (isManualSwitch(body)) {
    const res = await dispatchManuallyInstead(body.deliveryId, new Date(), {
      confirmNotWithDriver: body.confirmNotWithDriver === true,
      actor: { id: auth.user.id, label: auth.user.email },
    });
    if (!res.ok) {
      const status =
        res.reason === "not_found" ? 404 : res.reason === "not_driver" ? 422 : 409;
      return NextResponse.json({ error: res.message }, { status });
    }
    return NextResponse.json({ delivery: res.delivery });
  }

  let updated;
  try {
    updated = await assignDriver({
      deliveryId: body.deliveryId,
      driverName: body.driverName,
      driverPhone: body.driverPhone,
    });
  } catch (err) {
    if (err instanceof DeliveryNotAssignableError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    throw err;
  }
  if (!updated) {
    return NextResponse.json({ error: "Delivery not found." }, { status: 404 });
  }
  return NextResponse.json({ delivery: updated });
}
