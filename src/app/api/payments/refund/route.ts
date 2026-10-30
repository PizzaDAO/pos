/**
 * Refund / void endpoint.
 *
 * POST /api/payments/refund — refund a captured tender (full or partial) via its
 * rail and persist the refunded amount. When every tender on the order is fully
 * refunded the order is marked `refunded`. Refunds are idempotent at the rail
 * via a derived key. Simulated rails always "succeed".
 */
import { NextResponse } from "next/server";
import { RefundExceedsError, refundPayment } from "@/lib/payments/service";
import { getOrderBalance } from "@/lib/payments/service";
import { getPosDriver } from "@/lib/db";
import { requireTenantRole } from "@/lib/auth/api";
import { effectiveTerminalRole } from "@/lib/auth/active-staff";
import { sessionRoleIn } from "@/lib/auth/tenant-guard";
import { publicTender } from "@/lib/payments/public";
import {
  enforceRateLimit,
  isClientId,
  isMoneyCents,
  isUuid,
  readJsonBody,
  recordAudit,
} from "@/lib/security";

export const runtime = "nodejs";

interface RefundBody {
  paymentId: string;
  amountCents?: number;
  reason?: string;
  /** Client-minted id for this refund request (idempotency across retries). */
  refundId?: string;
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
  // Validate the id shape up front: a malformed/non-UUID paymentId must be a
  // clean 422, never a 500 from a `uuid`-typed column rejecting the value.
  if (!b || !isUuid(b.paymentId)) {
    return NextResponse.json(
      { error: "paymentId must be a valid UUID." },
      { status: 422 },
    );
  }
  if (b.amountCents !== undefined && !isMoneyCents(b.amountCents)) {
    return NextResponse.json(
      { error: "amountCents must be a non-negative integer." },
      { status: 422 },
    );
  }

  if (b.refundId !== undefined && !isClientId(b.refundId)) {
    return NextResponse.json(
      { error: "refundId is invalid." },
      { status: 422 },
    );
  }

  const driver = getPosDriver();

  // The refund targets a specific payment; resolve it first so we can authorize
  // the caller against THAT payment's tenant (not a client-supplied tenant).
  // A lookup failure (e.g. transient DB error) must not leak as a 500 that an
  // unauthenticated caller could trigger — treat it as "not found".
  let existingPayment;
  try {
    existingPayment = await driver.getPayment(b.paymentId);
  } catch {
    existingPayment = null;
  }
  if (!existingPayment) {
    return NextResponse.json({ error: "Payment not found." }, { status: 404 });
  }
  // Refunds move money out: owner or manager only (not cashier / kitchen) —
  // and on a shared terminal it is the ACTIVE (PIN-switched) staff member who
  // must be owner|manager (the device login's role counts only while the
  // tenant has no staff PINs set up).
  const auth = await requireTenantRole(existingPayment.tenant_id, [
    "owner",
    "manager",
  ]);
  if (!auth.ok) return auth.res;
  const active = await effectiveTerminalRole(request, {
    tenantId: existingPayment.tenant_id,
    // requireTenantRole guaranteed owner|manager; least privileged default.
    role: sessionRoleIn(auth.user, existingPayment.tenant_id) ?? "manager",
    user: auth.user,
  });
  if (active.role !== "owner" && active.role !== "manager") {
    return NextResponse.json(
      { error: "Only an owner or manager can refund." },
      { status: 403 },
    );
  }

  try {
    const result = await refundPayment({
      paymentId: b.paymentId,
      amountCents: b.amountCents,
      reason: b.reason,
      refundId: b.refundId,
    });
    if (!result) {
      return NextResponse.json(
        { error: "Payment not found." },
        { status: 404 },
      );
    }
    const { replayed, refundedNowCents, manualRefund, ...payment } = result;
    const order = await driver.getOrder(payment.order_id);
    const balance = order ? await getOrderBalance(order) : 0;

    // Audit the refund (tenant-scoped) with the amount ACTUALLY refunded now.
    // An idempotent replay did nothing, so it writes no second entry.
    if (!replayed) {
      const fullyRefunded =
        payment.refunded_cents >= payment.amount_cents + payment.tip_cents;
      await recordAudit({
        actor: { id: auth.user.id, label: auth.user.email },
        action: fullyRefunded ? "payment_void" : "payment_refund",
        tenantId: payment.tenant_id,
        detail: `${manualRefund ? "Recorded a MANUAL refund of" : "Refunded"} ${refundedNowCents}¢ on payment ${payment.id} (order ${payment.order_id})${manualRefund ? " -- no money was sent; return it by hand" : ""}${b.reason ? ` — ${b.reason}` : ""}.`,
      });
    }

    return NextResponse.json({
      payment: publicTender(payment),
      balanceCents: balance,
      orderStatus: order?.status,
      // Crypto refunds only record the intent: the money was NOT sent.
      manualRefund: manualRefund === true,
      note:
        manualRefund === true
          ? "Refund recorded, but no money was sent. Return the funds to the customer manually from your wallet / Coinbase account."
          : undefined,
    });
  } catch (err) {
    if (err instanceof RefundExceedsError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Refund failed." },
      { status: 502 },
    );
  }
}
