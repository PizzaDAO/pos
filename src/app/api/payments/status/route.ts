/**
 * Payment status / watcher endpoint.
 *
 * GET /api/payments/status?paymentId= — re-check a tender's status with its rail
 * (crypto confirmation watcher, Stripe capture) and persist the result. The
 * terminal polls this for pending crypto tenders; with no live keys the
 * simulated rails report `captured` after their fixed confirmation delay.
 *
 * Auth: owner | manager | cashier of the payment's ORDER's tenant. Signed out is
 * 401 for everyone (so existence never depends on being signed out); a signed-in
 * caller who is not allowed gets the same 404 as an unknown id (no existence leak).
 */
import { NextResponse } from "next/server";
import { refreshPaymentStatus } from "@/lib/payments/service";
import { getPosDriver } from "@/lib/db";
import { getOrderBalance } from "@/lib/payments/service";
import { publicTender } from "@/lib/payments/public";
import { requireTenantRole } from "@/lib/auth/api";
import { getCurrentUser } from "@/lib/auth/session";

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
  if (!(await getCurrentUser())) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }
  const driver = getPosDriver();
  const notFound = () =>
    NextResponse.json({ error: "Payment not found." }, { status: 404 });
  let existing = null;
  try {
    existing = await driver.getPayment(paymentId);
  } catch {
    existing = null;
  }
  const owningOrder = existing ? await driver.getOrder(existing.order_id) : null;
  if (!existing || !owningOrder) return notFound();
  const auth = await requireTenantRole(owningOrder.tenant_id, [
    "owner",
    "manager",
    "cashier",
  ]);
  if (!auth.ok) return notFound();

  const payment = await refreshPaymentStatus(paymentId);
  if (!payment) return notFound();
  const order = await driver.getOrder(payment.order_id);
  const balance = order ? await getOrderBalance(order) : 0;
  return NextResponse.json({
    payment: publicTender(payment),
    balanceCents: balance,
    orderStatus: order?.status,
  });
}
