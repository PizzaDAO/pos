/**
 * Order intake endpoint.
 *
 * POST /api/orders  — idempotent upsert-by-UUID of a placed order via the DB
 * abstraction (mock driver in Phase 1). The offline queue flushes here on
 * reconnect; because `createOrder` is keyed on the client UUID, retries return
 * the existing order rather than creating a duplicate.
 *
 * GET  /api/orders?tenantId=&locationId=  — recent orders for a location.
 *
 * No env vars are read; everything runs against the in-memory mock driver.
 */
import { NextResponse } from "next/server";
import { getPosDriver, type CreateOrderInput } from "@/lib/db";

// In-memory mock state lives in the Node runtime; force it (not edge).
export const runtime = "nodejs";

function isValidPayload(body: unknown): body is CreateOrderInput {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  return (
    typeof b.id === "string" &&
    typeof b.tenant_id === "string" &&
    typeof b.location_id === "string" &&
    typeof b.currency === "string" &&
    Array.isArray(b.items) &&
    typeof b.totals === "object" &&
    b.totals !== null
  );
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (!isValidPayload(body)) {
    return NextResponse.json(
      { error: "Malformed order payload." },
      { status: 422 },
    );
  }

  const driver = getPosDriver();
  const order = await driver.createOrder(body);
  return NextResponse.json({ order }, { status: 201 });
}

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
  const orders = await driver.listOrders(tenantId, locationId);
  return NextResponse.json({ orders });
}
