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
 * PRICING IS SERVER-SIDE: client line prices/totals are ignored. Every line is
 * re-priced from the location's menu (size price + modifiers incl. the
 * half-and-half rule); unknown / 86'd items → 422. An order-level discount is
 * an explicit `discount_cents` field that only owner|manager may apply (403
 * otherwise). In-store order-level tip is always 0 (tips ride on the tender).
 *
 * No env vars are read; everything runs against the in-memory mock driver.
 */
import { NextResponse } from "next/server";
import { getPosDriver, type CreateOrderInput } from "@/lib/db";
import { requireTenantMember, requireTenantRole } from "@/lib/auth/api";
import {
  requireLocationInTenant,
  sessionRoleIn,
} from "@/lib/auth/tenant-guard";
import { enforceRateLimit, isMoneyCents, readJsonBody } from "@/lib/security";
import { priceOrder } from "@/lib/order-pricing";
import { RepriceError } from "@/lib/reprice";
import { effectiveTerminalRole } from "@/lib/auth/active-staff";
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
    Array.isArray(b.items) &&
    (b.discount_cents === undefined || isMoneyCents(b.discount_cents)) &&
    (b.order_number === undefined ||
      (typeof b.order_number === "string" && b.order_number.length <= 32)) &&
    (b.notes === undefined ||
      b.notes === null ||
      (typeof b.notes === "string" && b.notes.length <= 1000))
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
  // Only till roles create orders (the kitchen display never does), and the
  // location must belong to that tenant (no writing into another tenant's
  // location under your own tenant id).
  const roleAuth = await requireTenantRole(body.tenant_id, [
    "owner",
    "manager",
    "cashier",
  ]);
  if (!roleAuth.ok) return roleAuth.res;
  const locationDenied = await requireLocationInTenant(
    body.tenant_id,
    body.location_id,
  );
  if (locationDenied) return locationDenied.res;
  const auth = {
    user: roleAuth.user,
    tenantId: body.tenant_id,
    locationId: body.location_id,
    // requireTenantRole guarantees one of the till roles; default to the
    // least privileged one if the session shape doesn't carry it.
    role: sessionRoleIn(roleAuth.user, body.tenant_id) ?? ("cashier" as const),
  };

  try {
    const driver = getPosDriver();

    // Idempotent replay (offline queue retry): return the stored order as-is,
    // without re-validating against a menu that may have changed since.
    const existing = await driver.getOrder(body.id);
    if (existing) {
      if (existing.tenant_id !== auth.tenantId) {
        return NextResponse.json(
          { error: "Order id already in use." },
          { status: 409, headers },
        );
      }
      return NextResponse.json({ order: existing }, { status: 201, headers });
    }

    // Staff discounts are an explicit field, gated by the ACTIVE (PIN-switched)
    // staff member's role — not the device login's role.
    const active = await effectiveTerminalRole(request, auth);
    const discountCents = body.discount_cents ?? 0;
    if (
      discountCents > 0 &&
      active.role !== "owner" &&
      active.role !== "manager"
    ) {
      return NextResponse.json(
        { error: "Only an owner or manager can apply a discount." },
        { status: 403, headers },
      );
    }

    // Attribution: the server-verified active staff wins; otherwise a
    // client-sent staff id must at least belong to this tenant.
    const staffId =
      active.staff?.id ??
      (typeof body.staff_id === "string" &&
      (await driver.getStaffById(auth.tenantId, body.staff_id))
        ? body.staff_id
        : null);

    let priced;
    try {
      priced = await priceOrder({
        tenantId: auth.tenantId,
        locationId: auth.locationId,
        items: body.items,
        discountCents,
        tipCents: 0,
        voided: "keep",
      });
    } catch (err) {
      if (err instanceof RepriceError) {
        return NextResponse.json(
          { error: err.message },
          { status: 422, headers },
        );
      }
      throw err;
    }
    if (!priced.items.some((i) => !i.voided)) {
      return NextResponse.json(
        { error: "Order has no items." },
        { status: 422, headers },
      );
    }

    const input: CreateOrderInput = {
      id: body.id,
      tenant_id: auth.tenantId,
      location_id: auth.locationId,
      channel: "in_store",
      currency: priced.settings.currency,
      items: priced.items,
      discount_cents: priced.totals.discount_cents,
      totals: priced.totals,
      notes:
        typeof body.notes === "string" && body.notes.trim()
          ? body.notes.trim()
          : null,
      order_number: body.order_number,
      status: "placed",
      staff_id: staffId,
    };
    // createOrder is an idempotent upsert-by-UUID — retries return the existing
    // order, so this log line may report the same order id more than once.
    const order = await driver.createOrder(input);
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
  // Order lists carry customer details: tenant members only, and the location
  // must belong to that tenant.
  const auth = await requireTenantMember(tenantId);
  if (!auth.ok) return auth.res;
  const locationDenied = await requireLocationInTenant(tenantId, locationId);
  if (locationDenied) return locationDenied.res;
  const driver = getPosDriver();
  const orders = await driver.listOrders(tenantId, locationId);
  return NextResponse.json({ orders });
}
