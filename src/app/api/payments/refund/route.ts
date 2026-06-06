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
import { requireTenantMember } from "@/lib/auth/api";
import {
  enforceRateLimit,
  isMoneyCents,
  readJsonBody,
  recordAudit,
} from "@/lib/security";

export const runtime = "nodejs";

interface RefundBody {
  paymentId: string;
  amountCents?: number;
  reason?: string;
}

export async function POST(request: Request) {
  // Refunds move money out — rate-limit + audit every one.
  const limited = enforceRateLimit(request, "payments");
  if (limited) return limited;

  const parsed = await readJsonBody(request);
  if (!parsed.ok) {
    return NextResponse.json(
      { error: parsed.error },
      { status: parsed.status },
    );
  }
  const b = parsed.body as RefundBody;
  if (!b || typeof b.paymentId !== "string") {
    return NextResponse.json(
      { error: "paymentId is required." },
      { status: 422 },
    );
  }
  if (b.amountCents !== undefined && !isMoneyCents(b.amountCents)) {
    return NextResponse.json(
      { error: "amountCents must be a non-negative integer." },
      { status: 422 },
    );
  }

  const driver = getPosDriver();

  // The refund targets a specific payment; resolve it first so we can authorize
  // the caller against THAT payment's tenant (not a client-supplied tenant).
  const existingPayment = await driver.getPayment(b.paymentId);
  if (!existingPayment) {
    return NextResponse.json({ error: "Payment not found." }, { status: 404 });
  }
  const auth = await requireTenantMember(existingPayment.tenant_id);
  if (!auth.ok) return auth.res;

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
    const order = await driver.getOrder(payment.order_id);
    const balance = order ? await getOrderBalance(order) : 0;

    // Audit the refund (tenant-scoped). Fully-refunded ⇒ a void of the tender.
    const fullyRefunded = payment.refunded_cents >= payment.amount_cents;
    await recordAudit({
      actor: { id: auth.user.id, label: auth.user.email },
      action: fullyRefunded ? "payment_void" : "payment_refund",
      tenantId: payment.tenant_id,
      detail: `Refunded ${b.amountCents ?? payment.amount_cents}¢ on payment ${payment.id} (order ${payment.order_id})${b.reason ? ` — ${b.reason}` : ""}.`,
    });

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
