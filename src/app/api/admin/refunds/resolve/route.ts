/**
 * Resolve a stuck card refund -- POST /api/admin/refunds/resolve
 *
 * GET  ?tenantId=&locationId=   card refunds needing a manager (pending at
 *                               Stripe, or recorded without a Stripe id).
 * POST { tenantId, paymentId, refundId, stripeRefundId?, dryRun?, expect? }
 *   dryRun: only look it up and say what would happen ("Check Stripe").
 *   expect: "confirmed" | "released" | "ref_recorded", the outcome the manager
 *           pressed; refused (409) if Stripe now says otherwise.
 *
 * For a card refund left `pending` (Stripe kept answering an idempotency error,
 * never answered, or it is older than Stripe's 24 h idempotency window, so POS
 * will not send it again). The server looks the refund up AT STRIPE (by the
 * `re_` id when given, else by the refund id POS sent as metadata) and confirms
 * it (records the Stripe refund id) or releases it (Stripe failed it or never
 * made it: the money is held again). Never asks Stripe to refund.
 * See src/lib/payments/refund-resolve.ts.
 *
 * Owner / manager only, behind the back-office PIN gate (requireAdminAccess).
 * Audited.
 */
import { NextResponse } from "next/server";
import { requireAdminAccess } from "@/lib/auth/admin-gate";
import { publicTender } from "@/lib/payments/public";
import {
  listStuckCardRefunds,
  RefundResolveError,
  resolveStuckCardRefund,
  type ResolveOutcome,
} from "@/lib/payments/refund-resolve";
import { enforceRateLimit, isClientId, isUuid, readJsonBody, recordAudit } from "@/lib/security";

export const runtime = "nodejs";
export const maxDuration = 60;

const OUTCOMES: readonly ResolveOutcome[] = ["confirmed", "released", "ref_recorded"];

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const locationId = searchParams.get("locationId");
  const auth = await requireAdminAccess(request, searchParams.get("tenantId"), { locationId });
  if (!auth.ok) return auth.res;
  if (auth.actor.role !== "owner" && auth.actor.role !== "manager") {
    return NextResponse.json({ error: "Only an owner or manager can resolve a refund." }, { status: 403 });
  }
  return NextResponse.json({ refunds: await listStuckCardRefunds(auth.tenantId, locationId) });
}

export async function POST(request: Request) {
  const limited = enforceRateLimit(request, "payments");
  if (limited) return limited;
  const parsed = await readJsonBody(request);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: parsed.status });
  const body = (parsed.body ?? {}) as Record<string, unknown>;
  const auth = await requireAdminAccess(request, typeof body.tenantId === "string" ? body.tenantId : null);
  if (!auth.ok) return auth.res;
  // The UNLOCKED staff member's role (PIN gate), not the device login's.
  if (auth.actor.role !== "owner" && auth.actor.role !== "manager") {
    return NextResponse.json({ error: "Only an owner or manager can resolve a refund." }, { status: 403 });
  }
  if (!isUuid(body.paymentId) || !isClientId(body.refundId)) {
    return NextResponse.json({ error: "paymentId and refundId are required." }, { status: 422 });
  }
  const stripeRefundId = body.stripeRefundId;
  if (stripeRefundId !== undefined && (typeof stripeRefundId !== "string" || !/^re_[A-Za-z0-9]{6,64}$/.test(stripeRefundId))) {
    return NextResponse.json({ error: "stripeRefundId must be a Stripe refund id (re_...)." }, { status: 422 });
  }

  const expect = body.expect;
  if (expect !== undefined && !OUTCOMES.includes(expect as ResolveOutcome)) {
    return NextResponse.json({ error: "expect must be confirmed, released or ref_recorded." }, { status: 422 });
  }
  const dryRun = body.dryRun === true;

  try {
    const out = await resolveStuckCardRefund({
      tenantId: auth.tenantId,
      paymentId: body.paymentId,
      refundId: body.refundId,
      stripeRefundId: stripeRefundId as string | undefined,
      dryRun,
      expect: expect as ResolveOutcome | undefined,
    });
    if (out.dryRun) {
      return NextResponse.json({ dryRun: true, outcome: out.outcome, stripeRefund: out.stripeRefund });
    }
    const who = auth.actor.staff ? `${auth.actor.staff.name} (${auth.actor.staff.id})` : auth.user.email;
    const stripe = out.stripeRefund
      ? `Stripe refund ${out.stripeRefund.id} is ${out.stripeRefund.status} (${out.stripeRefund.amount}c)`
      : "Stripe has no such refund";
    await recordAudit({
      actor: { id: auth.user.id, label: auth.user.email },
      action: "payment_refund",
      tenantId: auth.tenantId,
      detail: `Stuck card refund ${body.refundId} on payment ${out.payment.id} (order ${out.payment.order_id}) resolved by ${who}: ${stripe}; ${
        out.outcome === "released" ? "released, the money is held again" : out.outcome === "confirmed" ? "confirmed" : "Stripe id recorded"
      }.`,
    });
    return NextResponse.json({
      outcome: out.outcome,
      stripeRefund: out.stripeRefund,
      payment: publicTender(out.payment),
    });
  } catch (err) {
    if (err instanceof RefundResolveError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not reach Stripe: nothing was changed." },
      { status: 502 },
    );
  }
}
