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
import { requireTenantMember } from "@/lib/auth/api";
import { enforceRateLimit, readJsonBody } from "@/lib/security";
import {
  captureError,
  childLogger,
  resolveRequestId,
  traceResponseHeaders,
} from "@/lib/observability";

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
  const requestId = resolveRequestId(request.headers);
  const log = childLogger({ requestId, route: "POST /api/orders" });
  const headers = traceResponseHeaders(requestId);

  // Rate-limit order creation per IP to blunt automated order spam / abuse.
  const limited = enforceRateLimit(request, "orders");
  if (limited) return limited;

  const parsed = await readJsonBody(request);
  if (!parsed.ok) {
    return NextResponse.json(
      { error: parsed.error },
      { status: parsed.status, headers },
    );
  }
  const body = parsed.body;

  if (!isValidPayload(body)) {
    return NextResponse.json(
      { error: "Malformed order payload." },
      { status: 422, headers },
    );
  }

  // In-store terminal orders are placed by a signed-in device user who must be a
  // member of the order's tenant. (Customer/online orders go through the public
  // /api/shop/orders route instead.)
  const auth = await requireTenantMember(body.tenant_id);
  if (!auth.ok) return auth.res;

  try {
    const driver = getPosDriver();
    // createOrder is an idempotent upsert-by-UUID — retries return the existing
    // order, so this log line may report the same order id more than once.
    const order = await driver.createOrder(body);
    log.info("order_upserted", {
      orderId: order.id,
      tenantId: order.tenant_id,
      locationId: order.location_id,
      total_cents: order.totals.total_cents,
    });
    return NextResponse.json({ order }, { status: 201, headers });
  } catch (err) {
    captureError(err, {
      requestId,
      scope: "orders",
      tenantId: (body as CreateOrderInput).tenant_id,
    });
    return NextResponse.json(
      { error: "Failed to place order." },
      { status: 500, headers },
    );
  }
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
