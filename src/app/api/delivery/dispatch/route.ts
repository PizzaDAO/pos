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
 * No env vars required.
 */
import { NextResponse } from "next/server";
import { getPosDriver } from "@/lib/db";
import { assignDriver } from "@/lib/delivery/service";

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
  const deliveries = await driver.listDeliveries(tenantId, locationId);
  // Enrich each with its order number for the dispatch board.
  const rows = await Promise.all(
    deliveries.map(async (d) => {
      const order = await driver.getOrder(d.order_id);
      return {
        delivery: d,
        orderNumber: order?.order_number ?? null,
        orderStatus: order?.status ?? null,
      };
    }),
  );
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

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (!isValid(body)) {
    return NextResponse.json(
      { error: "deliveryId and driverName are required." },
      { status: 422 },
    );
  }

  const updated = await assignDriver({
    deliveryId: body.deliveryId,
    driverName: body.driverName,
    driverPhone: body.driverPhone,
  });
  if (!updated) {
    return NextResponse.json({ error: "Delivery not found." }, { status: 404 });
  }
  return NextResponse.json({ delivery: updated });
}
