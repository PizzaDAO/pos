/**
 * Late payments -- /api/admin/late-payments (owner/manager only)
 *
 * A "late payment" is money that settled on an online order the lifecycle had
 * already given up on (`abandoned`, or a legacy `voided` one): the customer paid
 * after the checkout expired. The order is NOT sent to the kitchen on its own;
 * `payments/service` marks it (`fulfillment.late_payment`) and it lands here.
 *
 * GET  ?tenantId=&locationId=   unresolved late payments for a location.
 * POST { orderId, action }      resolve one:
 *   - "accept": promote the abandoned order to `paid` through the SHARED
 *     `finalizeOnlinePayment` (compare-and-set from `abandoned`), so it goes on
 *     the KDS, depletes inventory and dispatches delivery exactly once. Abandoned
 *     orders only (a voided legacy order had its delivery canceled: refund it).
 *   - "refund": fully refund every settled tender (`refundPayment`, idempotent
 *     per tender), leaving the order abandoned.
 * Both are audited.
 */
import { NextResponse } from "next/server";
import { getPosDriver, type Order } from "@/lib/db";
import { requireTenantRole } from "@/lib/auth/api";
import { orderDueCents, refundPayment } from "@/lib/payments/service";
import { publicTender } from "@/lib/payments/public";
import { finalizeOnlinePayment } from "@/lib/shop/finalize";
import { enforceRateLimit, readJsonBody, recordAudit } from "@/lib/security";

export const runtime = "nodejs";

const ROLES = ["owner", "manager"] as const;

function isOpenLatePayment(o: Order): boolean {
  return (
    (o.status === "abandoned" || o.status === "voided") &&
    !!o.fulfillment?.late_payment &&
    !o.fulfillment.late_payment.resolved
  );
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
  const auth = await requireTenantRole(tenantId, [...ROLES]);
  if (!auth.ok) return auth.res;
  const driver = getPosDriver();
  const orders = (await driver.listOrders(tenantId, locationId)).filter(
    isOpenLatePayment,
  );
  const out = await Promise.all(
    orders.map(async (order) => ({
      order,
      payments: (await driver.listPaymentsForOrder(order.id)).map(publicTender),
    })),
  );
  return NextResponse.json({ latePayments: out });
}

export async function POST(request: Request) {
  const limited = enforceRateLimit(request, "payments");
  if (limited) return limited;
  const parsed = await readJsonBody(request);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: parsed.status });
  }
  const b = parsed.body as { orderId?: unknown; action?: unknown } | null;
  if (
    typeof b?.orderId !== "string" ||
    (b.action !== "accept" && b.action !== "refund")
  ) {
    return NextResponse.json({ error: "Malformed request." }, { status: 422 });
  }

  const driver = getPosDriver();
  const order = await driver.getOrder(b.orderId);
  if (!order) {
    return NextResponse.json({ error: "Order not found." }, { status: 404 });
  }
  // Authorize against the ORDER's tenant, never a client-named one.
  const auth = await requireTenantRole(order.tenant_id, [...ROLES]);
  if (!auth.ok) return auth.res;
  if (!isOpenLatePayment(order)) {
    return NextResponse.json(
      { error: "No unresolved late payment on this order." },
      { status: 409 },
    );
  }
  const marker = order.fulfillment!.late_payment!;
  const actor = { id: auth.user.id, label: auth.user.email };
  const resolvedAt = new Date().toISOString();
  const settled = (await driver.listPaymentsForOrder(order.id)).filter(
    (p) => p.status === "captured" || p.status === "authorized",
  );

  if (b.action === "accept") {
    const covered = settled.reduce((n, p) => n + p.amount_cents, 0);
    if (order.status !== "abandoned" || covered < orderDueCents(order)) {
      return NextResponse.json(
        {
          error:
            order.status !== "abandoned"
              ? "Only an abandoned order can be accepted; refund it instead."
              : "The settled payments do not cover this order; refund it instead.",
        },
        { status: 409 },
      );
    }
    const result = await finalizeOnlinePayment(order.id, {
      from: ["abandoned"],
      fulfillmentExtra: {
        late_payment: { ...marker, resolved: "accepted", resolved_at: resolvedAt },
      },
    });
    if (!result.won) {
      return NextResponse.json(
        { error: "This order was already resolved." },
        { status: 409 },
      );
    }
    await recordAudit({
      actor,
      action: "late_payment_accepted",
      tenantId: order.tenant_id,
      detail: `Accepted late payment (${marker.amount_cents}c) on order ${order.id}.`,
    });
    return NextResponse.json({ order: result.order });
  }

  // refund
  try {
    for (const p of settled) {
      if (p.refunded_cents >= p.amount_cents + p.tip_cents) continue;
      await refundPayment({
        paymentId: p.id,
        refundId: `late-${p.id}`,
        reason: "late payment on an expired checkout",
      });
    }
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Refund failed." },
      { status: 502 },
    );
  }
  const updated = await driver.mergeOrderFulfillment(order.id, {
    late_payment: { ...marker, resolved: "refunded", resolved_at: resolvedAt },
  });
  await recordAudit({
    actor,
    action: "late_payment_refunded",
    tenantId: order.tenant_id,
    detail: `Refunded late payment (${marker.amount_cents}c) on order ${order.id}.`,
  });
  return NextResponse.json({ order: updated });
}
