/**
 * Cancel an unpaid online order -- POST /api/shop/orders/cancel { orderId }
 *
 * The storefront places the order BEFORE it charges (the server reprices it), so
 * when the customer declines a changed total the just-placed order must not stay
 * live on the KDS. This is deliberately minimal and anonymous-safe: it only voids
 * an ONLINE order that is still `placed`, was created within a short window, and
 * has no pending/authorized/captured tender. Any open (requires_action) card
 * intent is canceled first. A matching delivery is canceled too.
 *
 * Idempotent: an already-voided order returns 200.
 */
import { NextResponse } from "next/server";
import { getPosDriver } from "@/lib/db";
import { cancelOpenOnlineIntents } from "@/lib/payments/service";
import { cancelDeliveryForOrder } from "@/lib/delivery/service";
import { CANCEL_WINDOW_MS } from "@/lib/shop/cancel-window";
import { enforceRateLimit, isClientId, readJsonBody } from "@/lib/security";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const limited = enforceRateLimit(request, "orders");
  if (limited) return limited;

  const parsed = await readJsonBody(request);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: parsed.status });
  }
  const orderId = (parsed.body as { orderId?: unknown } | null)?.orderId;
  if (!isClientId(orderId)) {
    return NextResponse.json({ error: "orderId is required." }, { status: 422 });
  }

  const driver = getPosDriver();
  const order = await driver.getOrder(orderId);
  if (!order || order.channel === "in_store") {
    return NextResponse.json({ error: "Order not found." }, { status: 404 });
  }
  if (order.status === "voided") {
    return NextResponse.json({ order });
  }
  if (order.status !== "placed") {
    return NextResponse.json(
      { error: "This order can no longer be canceled." },
      { status: 409 },
    );
  }
  if (Date.now() - new Date(order.created_at).getTime() > CANCEL_WINDOW_MS) {
    return NextResponse.json(
      { error: "This order can no longer be canceled." },
      { status: 409 },
    );
  }

  const live = (await driver.listPaymentsForOrder(order.id)).some(
    (p) =>
      p.status === "pending" ||
      p.status === "authorized" ||
      p.status === "captured",
  );
  if (live) {
    return NextResponse.json(
      { error: "This order has a payment and can't be canceled here." },
      { status: 409 },
    );
  }

  try {
    // Close any open card intent so it can't be confirmed after the void. If it
    // turned out to have succeeded, that syncs the tender: re-check below.
    await cancelOpenOnlineIntents(order.id);
    const nowPaid = (await driver.listPaymentsForOrder(order.id)).some(
      (p) => p.status === "authorized" || p.status === "captured",
    );
    if (nowPaid) {
      return NextResponse.json(
        { error: "This order has a payment and can't be canceled here." },
        { status: 409 },
      );
    }
    const voided = await driver.updateOrderStatus(order.id, "voided");
    await cancelDeliveryForOrder(order.id);
    return NextResponse.json({ order: voided });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Cancel failed." },
      { status: 502 },
    );
  }
}
