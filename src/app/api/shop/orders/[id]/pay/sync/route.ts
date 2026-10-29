/**
 * Payment sync -- POST /api/shop/orders/[id]/pay/sync
 *
 * The customer-facing poll for an online order that is still `awaiting_payment`
 * (a crypto tender confirming, a card finishing 3DS). The SERVER re-asks each
 * open tender's rail for its status (`refreshPaymentStatus`) and persists it; if
 * the tenders now cover the order, `finalizeOnlinePayment` promotes it. Nothing
 * the client says is trusted: it only triggers the server-side check.
 *
 * Returns `orderStatus` -- the only signal the UI may treat as "paid" -- plus the
 * order's expiry so the UI can show a countdown. Anonymous, rate-limited.
 */
import { NextResponse } from "next/server";
import { getPosDriver } from "@/lib/db";
import { getOrderBalance, refreshPaymentStatus } from "@/lib/payments/service";
import { publicTender } from "@/lib/payments/public";
import { orderExpiresAt } from "@/lib/shop/lifecycle";
import { enforceRateLimit, isClientId } from "@/lib/security";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const limited = enforceRateLimit(request, "paySync");
  if (limited) return limited;

  const { id } = await ctx.params;
  if (!isClientId(id)) {
    return NextResponse.json({ error: "Invalid order id." }, { status: 422 });
  }
  const driver = getPosDriver();
  let order = await driver.getOrder(id);
  if (!order || order.channel === "in_store") {
    return NextResponse.json({ error: "Order not found." }, { status: 404 });
  }

  if (order.status === "awaiting_payment") {
    const open = (await driver.listPaymentsForOrder(id)).filter(
      (p) => p.status === "requires_action" || p.status === "pending",
    );
    for (const p of open) {
      try {
        await refreshPaymentStatus(p.id);
      } catch (err) {
        return NextResponse.json(
          { error: err instanceof Error ? err.message : "Sync failed." },
          { status: 502 },
        );
      }
    }
    order = (await driver.getOrder(id)) ?? order;
  }

  const payments = await driver.listPaymentsForOrder(id);
  return NextResponse.json(
    {
      orderStatus: order.status,
      balanceCents: await getOrderBalance(order),
      expiresAt:
        order.status === "awaiting_payment"
          ? orderExpiresAt(order, payments).toISOString()
          : null,
      payments: payments.map(publicTender),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
