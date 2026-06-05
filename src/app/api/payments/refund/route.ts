/**
 * Refund / void endpoint.
 *
 * POST /api/payments/refund — refund a captured tender (full or partial) via its
 * rail and persist the refunded amount. When every tender on the order is fully
 * refunded the order is marked `refunded`. Refunds are idempotent at the rail
 * via a derived key. Simulated rails always "succeed".
 */
import { NextResponse } from "next/server";
import { refundPayment } from "@/lib/payments/service";
import { getOrderBalance } from "@/lib/payments/service";
import { getPosDriver } from "@/lib/db";

export const runtime = "nodejs";

interface RefundBody {
  paymentId: string;
  amountCents?: number;
  reason?: string;
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const b = body as RefundBody;
  if (!b || typeof b.paymentId !== "string") {
    return NextResponse.json(
      { error: "paymentId is required." },
      { status: 422 },
    );
  }

  try {
    const payment = await refundPayment({
      paymentId: b.paymentId,
      amountCents: b.amountCents,
      reason: b.reason,
    });
    if (!payment) {
      return NextResponse.json(
        { error: "Payment not found." },
        { status: 404 },
      );
    }
    const driver = getPosDriver();
    const order = await driver.getOrder(payment.order_id);
    const balance = order ? await getOrderBalance(order) : 0;
    return NextResponse.json({
      payment,
      balanceCents: balance,
      orderStatus: order?.status,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Refund failed." },
      { status: 502 },
    );
  }
}
