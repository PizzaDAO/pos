/**
 * Payment status / watcher endpoint.
 *
 * GET /api/payments/status?paymentId= — re-check a tender's status with its rail
 * (crypto confirmation watcher, Stripe capture) and persist the result. The
 * terminal polls this for pending crypto tenders; with no live keys the
 * simulated rails report `captured` after their fixed confirmation delay.
 */
import { NextResponse } from "next/server";
import { refreshPaymentStatus } from "@/lib/payments/service";
import { getPosDriver } from "@/lib/db";
import { getOrderBalance } from "@/lib/payments/service";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const paymentId = searchParams.get("paymentId");
  if (!paymentId) {
    return NextResponse.json(
      { error: "paymentId is required." },
      { status: 400 },
    );
  }
  const payment = await refreshPaymentStatus(paymentId);
  if (!payment) {
    return NextResponse.json({ error: "Payment not found." }, { status: 404 });
  }
  const driver = getPosDriver();
  const order = await driver.getOrder(payment.order_id);
  const balance = order ? await getOrderBalance(order) : 0;
  return NextResponse.json({
    payment,
    balanceCents: balance,
    orderStatus: order?.status,
  });
}
