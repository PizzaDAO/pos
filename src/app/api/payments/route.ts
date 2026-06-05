/**
 * Payments endpoint.
 *
 * POST /api/payments — take one tender against an order. Idempotent on the
 * client-supplied `paymentId` (UUID): retries return the existing tender rather
 * than charging again. Resolves the tenant's Connect account for card rails,
 * computes the platform application fee, calls the rail (real when keys are
 * present, simulated otherwise), persists the payment, and marks the order
 * `paid` once the balance reaches zero.
 *
 * GET /api/payments?orderId= — list tenders + remaining balance for an order.
 *
 * No env vars are required; with none, rails settle via the simulated path.
 */
import { NextResponse } from "next/server";
import { getPosDriver } from "@/lib/db";
import type { PaymentRailKey } from "@/lib/payments/PaymentRail";
import { takePayment, getOrderBalance } from "@/lib/payments/service";

export const runtime = "nodejs";

interface TakePaymentBody {
  paymentId: string;
  orderId: string;
  tenantId: string;
  locationId: string;
  rail: PaymentRailKey | "cash";
  amountCents: number;
  tipCents?: number;
  currency: string;
  cashTenderedCents?: number;
  metadata?: Record<string, string>;
}

function isValid(body: unknown): body is TakePaymentBody {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  return (
    typeof b.paymentId === "string" &&
    typeof b.orderId === "string" &&
    typeof b.tenantId === "string" &&
    typeof b.locationId === "string" &&
    typeof b.rail === "string" &&
    typeof b.amountCents === "number" &&
    typeof b.currency === "string"
  );
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (!isValid(body)) {
    return NextResponse.json(
      { error: "Malformed payment payload." },
      { status: 422 },
    );
  }

  const driver = getPosDriver();
  const order = await driver.getOrder(body.orderId);
  if (!order) {
    return NextResponse.json({ error: "Order not found." }, { status: 404 });
  }

  // Resolve the connected account for card rails (simulated when no Stripe key).
  let connectAccountId: string | null = null;
  if (body.rail === "stripe_terminal" || body.rail === "stripe_online") {
    const account = await driver.getConnectAccount(body.tenantId);
    connectAccountId = account?.account_id ?? null;
  }

  try {
    const payment = await takePayment({
      paymentId: body.paymentId,
      orderId: body.orderId,
      tenantId: body.tenantId,
      locationId: body.locationId,
      rail: body.rail,
      amountCents: body.amountCents,
      tipCents: body.tipCents ?? 0,
      currency: body.currency,
      connectAccountId,
      cashTenderedCents: body.cashTenderedCents,
      metadata: body.metadata,
    });

    const refreshed = await driver.getOrder(body.orderId);
    const balance = refreshed ? await getOrderBalance(refreshed) : 0;
    return NextResponse.json(
      { payment, balanceCents: balance, orderStatus: refreshed?.status },
      { status: 201 },
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Payment failed." },
      { status: 502 },
    );
  }
}

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
  const payments = await driver.listPaymentsForOrder(orderId);
  const balance = await getOrderBalance(order);
  return NextResponse.json({
    order,
    payments,
    balanceCents: balance,
    orderStatus: order.status,
  });
}
