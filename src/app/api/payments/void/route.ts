/**
 * Void (cancel) an UNSETTLED tender — POST /api/payments/void
 *
 * Body: { paymentId }. A tender stuck in `pending` / `requires_action` (e.g. an
 * abandoned crypto invoice, or a card attempt whose provider outcome was never
 * confirmed) keeps holding the order balance. Voiding it marks it `canceled`
 * under a row lock (public.void_tender) so the balance frees up. Settled money
 * is refunded via /api/payments/refund instead.
 *
 * A Stripe tender that already has a PaymentIntent id is NOT voided here: its
 * outcome must be reconciled with Stripe first (status refresh / webhook), so
 * we never "cancel" a charge that actually captured.
 *
 * Auth: terminal role of the PAYMENT's tenant (resolved server-side), and the
 * ACTIVE (PIN-switched) staff member must be an owner or manager. Audited.
 */
import { NextResponse } from "next/server";
import { getPosDriver } from "@/lib/db";
import { requireTenantAccess } from "@/lib/auth/tenant-guard";
import { effectiveTerminalRole } from "@/lib/auth/active-staff";
import { getOrderBalance } from "@/lib/payments/service";
import {
  enforceRateLimit,
  isClientId,
  readJsonBody,
  recordAudit,
} from "@/lib/security";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const limited = enforceRateLimit(request, "payments");
  if (limited) return limited;

  const parsed = await readJsonBody(request);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: parsed.status });
  }
  const b = parsed.body as { paymentId?: unknown };
  if (!b || !isClientId(b.paymentId)) {
    return NextResponse.json(
      { error: "paymentId is required." },
      { status: 422 },
    );
  }

  const driver = getPosDriver();
  const payment = await driver.getPayment(b.paymentId).catch(() => null);
  if (!payment) {
    return NextResponse.json({ error: "Payment not found." }, { status: 404 });
  }
  const auth = await requireTenantAccess(payment.tenant_id, "terminal");
  if (!auth.ok) return auth.res;
  const active = await effectiveTerminalRole(request, auth);
  if (active.role !== "owner" && active.role !== "manager") {
    return NextResponse.json(
      { error: "Only an owner or manager can void a tender." },
      { status: 403 },
    );
  }

  if (
    payment.charge_id &&
    (payment.rail === "stripe_online" || payment.rail === "stripe_terminal")
  ) {
    return NextResponse.json(
      {
        error:
          "This card payment reached Stripe; refresh its status (or refund it) instead of voiding.",
      },
      { status: 409 },
    );
  }

  const result = await driver.voidTender(payment.id);
  if (!result.ok) {
    return NextResponse.json(
      {
        error:
          result.reason === "not_found"
            ? "Payment not found."
            : "Only an unsettled (pending) tender can be voided; refund settled payments.",
      },
      { status: result.reason === "not_found" ? 404 : 409 },
    );
  }

  await recordAudit({
    actor: {
      id: auth.user.id,
      label: active.staff
        ? `${active.staff.name} (via ${auth.user.email})`
        : auth.user.email,
    },
    action: "payment_void",
    tenantId: payment.tenant_id,
    detail: `Voided unsettled tender ${payment.id} (${payment.amount_cents}¢, ${payment.rail}) on order ${payment.order_id}.`,
  });

  const order = await driver.getOrder(payment.order_id);
  return NextResponse.json({
    payment: result.payment,
    balanceCents: order ? await getOrderBalance(order) : 0,
    orderStatus: order?.status,
  });
}
