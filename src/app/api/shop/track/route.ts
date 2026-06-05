/**
 * Customer order tracking feed — GET /api/shop/track?orderId=
 *
 * Returns the order's current status + (for delivery) the live delivery state.
 * This is the endpoint the customer tracking page polls through the REALTIME
 * polling seam (`src/lib/realtime/`), so status advances (placed → in_kitchen →
 * ready → out_for_delivery → completed) and driver/ETA updates appear without a
 * websocket. Refreshing the delivery here also pulls provider tracking (simulated
 * driver/ETA for in-house, provider tracking ref for DoorDash).
 *
 * No env vars required.
 */
import { NextResponse } from "next/server";
import { getPosDriver } from "@/lib/db";
import { refreshDelivery } from "@/lib/delivery/service";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const orderId = searchParams.get("orderId");
  if (!orderId) {
    return NextResponse.json({ error: "orderId is required." }, { status: 400 });
  }

  const driver = getPosDriver();
  const order = await driver.getOrder(orderId);
  if (!order) {
    return NextResponse.json({ error: "Order not found." }, { status: 404 });
  }

  let delivery = await driver.getDeliveryForOrder(orderId);
  // Pull live provider state when there's a dispatched delivery to track.
  if (delivery) {
    delivery = (await refreshDelivery(delivery.id)) ?? delivery;
  }

  return NextResponse.json(
    {
      order: {
        id: order.id,
        order_number: order.order_number,
        status: order.status,
        channel: order.channel,
        currency: order.currency,
        totals: order.totals,
        fulfillment: order.fulfillment ?? null,
        created_at: order.created_at,
        updated_at: order.updated_at,
      },
      delivery,
      serverTime: new Date().toISOString(),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
