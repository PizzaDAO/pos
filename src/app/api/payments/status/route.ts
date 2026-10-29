/**
 * Payment status / watcher endpoint.
 *
 * GET /api/payments/status?paymentId= — re-check a tender's status with its rail
 * (crypto confirmation watcher, Stripe capture) and persist the result. The
 * terminal polls this for pending crypto tenders; with no live keys the
 * simulated rails report `captured` after their fixed confirmation delay.
 *
 * Auth: an operational role of the PAYMENT's own tenant (resolved server-side).
 */
import { NextResponse } from "next/server";
import { refreshPaymentStatus } from "@/lib/payments/service";
import { getPosDriver } from "@/lib/db";
import { getOrderBalance } from "@/lib/payments/service";
import { getCurrentUser } from "@/lib/auth/session";
import { requireTenantAccess } from "@/lib/auth/tenant-guard";

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
  // Authenticate before touching the id, then authorize on the payment's tenant.
  if (!(await getCurrentUser())) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }
  const driver = getPosDriver();
  const existing = await driver.getPayment(paymentId).catch(() => null);
  if (!existing) {
    return NextResponse.json({ error: "Payment not found." }, { status: 404 });
  }
  const auth = await requireTenantAccess(existing.tenant_id, "terminal");
  if (!auth.ok) return auth.res;

  const payment = await refreshPaymentStatus(paymentId);
  if (!payment) {
    return NextResponse.json({ error: "Payment not found." }, { status: 404 });
  }
  const order = await driver.getOrder(payment.order_id);
  const balance = order ? await getOrderBalance(order) : 0;
  return NextResponse.json({
    payment,
    balanceCents: balance,
    orderStatus: order?.status,
  });
}
