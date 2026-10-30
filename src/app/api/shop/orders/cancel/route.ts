/**
 * Cancel an unpaid online order -- POST /api/shop/orders/cancel { orderId }
 *
 * Anonymous-safe (the order id is an unguessable client UUID) and deliberately
 * narrow: it only ever ends an UNPAID ONLINE checkout.
 *
 *  - `awaiting_payment` (the lifecycle every online order now starts in): open
 *    card intents are canceled on the provider, then the order is moved to
 *    `abandoned` by compare-and-set (`cancelOnlineCheckout`). It was never on the
 *    KDS, depleted nothing and dispatched nothing, so there is nothing to undo.
 *    Used when the customer declines a repriced total, cancels from the tracking
 *    page, or switches to a different cart. Refused (409) if a tender is
 *    settled or still in flight.
 *  - `placed` (LEGACY): an online order created by the previous flow, which was
 *    on the KDS before payment. Orders already in flight at deploy time keep the
 *    old rule: voided only within `CANCEL_WINDOW_MS` of creation and with no live
 *    tender, delivery canceled too. This branch can be deleted once no `placed`
 *    unpaid online order can exist.
 *
 * Idempotent: an already abandoned (or legacy voided) order returns 200.
 */
import { NextResponse } from "next/server";
import { getPosDriver } from "@/lib/db";
import { cancelOpenOnlineIntents } from "@/lib/payments/service";
import { cancelDeliveryForOrder } from "@/lib/delivery/service";
import { cancelOnlineCheckout } from "@/lib/shop/lifecycle";
import { CANCEL_WINDOW_MS } from "@/lib/shop/cancel-window";
import { enforceRateLimit, isClientId, readJsonBody } from "@/lib/security";

export const runtime = "nodejs";

const CANNOT_CANCEL = "This order can no longer be canceled.";
const HAS_PAYMENT = "This order has a payment and can't be canceled here.";

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
  if (order.status === "voided" || order.status === "abandoned") {
    return NextResponse.json({ order });
  }

  // ---- Lifecycle path: awaiting_payment -> abandoned ------------------------
  if (order.status === "awaiting_payment") {
    try {
      const result = await cancelOnlineCheckout(order.id);
      if (!result.ok) {
        return NextResponse.json(
          { error: result.reason === "has_payment" ? HAS_PAYMENT : CANNOT_CANCEL },
          { status: 409 },
        );
      }
      return NextResponse.json({ order: result.order });
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "Cancel failed." },
        { status: 502 },
      );
    }
  }

  // ---- Legacy path: an unpaid `placed` online order -------------------------
  if (order.status !== "placed") {
    return NextResponse.json({ error: CANNOT_CANCEL }, { status: 409 });
  }
  if (Date.now() - new Date(order.created_at).getTime() > CANCEL_WINDOW_MS) {
    return NextResponse.json({ error: CANNOT_CANCEL }, { status: 409 });
  }

  const live = (await driver.listPaymentsForOrder(order.id)).some(
    (p) =>
      p.status === "pending" ||
      p.status === "authorized" ||
      p.status === "captured",
  );
  if (live) {
    return NextResponse.json({ error: HAS_PAYMENT }, { status: 409 });
  }

  try {
    // Close any open card intent so it can't be confirmed after the void. If it
    // turned out to have succeeded, that syncs the tender: re-check below.
    await cancelOpenOnlineIntents(order.id);
    const nowPaid = (await driver.listPaymentsForOrder(order.id)).some(
      (p) => p.status === "authorized" || p.status === "captured",
    );
    if (nowPaid) {
      return NextResponse.json({ error: HAS_PAYMENT }, { status: 409 });
    }
    // Compare-and-set so a payment landing meanwhile (-> paid) is not overwritten.
    const voided = await driver.transitionOrderStatus(
      order.id,
      ["placed"],
      "voided",
    );
    if (!voided) {
      return NextResponse.json({ error: HAS_PAYMENT }, { status: 409 });
    }
    await cancelDeliveryForOrder(order.id);
    return NextResponse.json({ order: voided });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Cancel failed." },
      { status: 502 },
    );
  }
}
