/**
 * Late and duplicate payments -- /api/admin/late-payments (owner/manager only)
 *
 * Two kinds of item share one marker (`fulfillment.late_payment`):
 *  - `late`: money settled on an online order the lifecycle had already given up on
 *    (`abandoned`, or a legacy `voided` one), even if it is less than the order was
 *    worth. The order is NOT sent to the kitchen on its own.
 *  - `duplicate`: an order holds more settled money than it is worth (two tenders
 *    both settled); one of them must be refunded.
 *
 * GET  ?tenantId=&locationId=   open items (unresolved, or refund still owed by
 *                               hand) from a dedicated, ordered, capped query.
 * POST { orderId, action }      resolve one. Every action first CLAIMS the marker
 *   with an atomic compare-and-set (`claimLatePayment`), so two staff members (or
 *   Accept racing Refund) can never both act; only the claimant proceeds, and the
 *   claim is released on failure.
 *   - "accept": promote an abandoned `late` order to `paid` through the SHARED
 *     `finalizeOnlinePayment` (compare-and-set from `abandoned`), once, if the
 *     settled money (net of refunds) covers it.
 *   - "refund": send the money back. Card and cash tenders are refunded through
 *     `refundPayment`. CRYPTO tenders cannot be refunded by the system (their
 *     `refund()` only records an intent): they stay `captured` and the item
 *     becomes `refund_owed_manual`, listed with instructions until staff return
 *     the money themselves.
 *   - "mark_refunded": staff did the manual transfer; record it (the tender is
 *     marked refunded) and close the item.
 * All are audited.
 */
import { NextResponse } from "next/server";
import { getPosDriver, type LatePaymentMarker, type Payment } from "@/lib/db";
import { requireTenantRole } from "@/lib/auth/api";
import {
  isManualRefundRail,
  netSettledCents,
  refundPayment,
} from "@/lib/payments/service";
import { publicTender } from "@/lib/payments/public";
import { finalizeOnlinePayment } from "@/lib/shop/finalize";
import { enforceRateLimit, readJsonBody, recordAudit } from "@/lib/security";

export const runtime = "nodejs";

const ROLES = ["owner", "manager"] as const;
/** A claim older than this is treated as left behind by a crashed request. */
const CLAIM_STALE_MS = 10 * 60_000;

type Action = "accept" | "refund" | "mark_refunded";
const CLAIM_FOR: Record<Action, "accepting" | "refunding" | "marking_refunded"> = {
  accept: "accepting",
  refund: "refunding",
  mark_refunded: "marking_refunded",
};

function isOpen(m: LatePaymentMarker | undefined): m is LatePaymentMarker {
  return !!m && (m.resolved === undefined || m.resolved === "refund_owed_manual");
}

function tenderView(p: Payment) {
  const raw = (p.raw ?? {}) as Record<string, unknown>;
  const returnAddress =
    (typeof raw.from === "string" && raw.from) ||
    (typeof raw.payer_address === "string" && raw.payer_address) ||
    null;
  return {
    ...publicTender(p),
    // The customer's return address, when the rail recorded one.
    return_address: returnAddress,
    manual_refund: isManualRefundRail(p.rail),
  };
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const tenantId = searchParams.get("tenantId");
  const locationId = searchParams.get("locationId");
  if (!tenantId || !locationId) {
    return NextResponse.json(
      { error: "tenantId and locationId are required." },
      { status: 400 },
    );
  }
  const auth = await requireTenantRole(tenantId, [...ROLES]);
  if (!auth.ok) return auth.res;
  const driver = getPosDriver();
  const orders = await driver.listOpenLatePayments(tenantId, locationId, 100);
  const out = await Promise.all(
    orders.map(async (order) => ({
      order,
      payments: (await driver.listPaymentsForOrder(order.id)).map(tenderView),
    })),
  );
  return NextResponse.json({ latePayments: out });
}

export async function POST(request: Request) {
  const limited = enforceRateLimit(request, "payments");
  if (limited) return limited;
  const parsed = await readJsonBody(request);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: parsed.status });
  }
  const b = parsed.body as { orderId?: unknown; action?: unknown } | null;
  if (
    typeof b?.orderId !== "string" ||
    (b.action !== "accept" && b.action !== "refund" && b.action !== "mark_refunded")
  ) {
    return NextResponse.json({ error: "Malformed request." }, { status: 422 });
  }
  const action: Action = b.action;

  const driver = getPosDriver();
  const order = await driver.getOrder(b.orderId);
  if (!order) {
    return NextResponse.json({ error: "Order not found." }, { status: 404 });
  }
  // Authorize against the ORDER's tenant, never a client-named one.
  const auth = await requireTenantRole(order.tenant_id, [...ROLES]);
  if (!auth.ok) return auth.res;

  const pre = order.fulfillment?.late_payment;
  if (!isOpen(pre)) {
    return NextResponse.json(
      { error: "No unresolved payment issue on this order." },
      { status: 409 },
    );
  }
  const wrongState =
    (action === "accept" &&
      (pre.kind === "duplicate" || order.status !== "abandoned" || pre.resolved !== undefined)) ||
    (action === "refund" && pre.resolved !== undefined) ||
    (action === "mark_refunded" && pre.resolved !== "refund_owed_manual");
  if (wrongState) {
    return NextResponse.json(
      {
        error:
          action === "accept"
            ? "Only an abandoned order with an unresolved late payment can be accepted; refund it instead."
            : action === "refund"
              ? "This item is already being refunded by hand; use Mark refunded once you have sent the money."
              : "Nothing is owed by hand on this item.",
      },
      { status: 409 },
    );
  }

  // Atomic claim: only ONE concurrent request gets past this point.
  const claimed = await driver.claimLatePayment(
    order.id,
    CLAIM_FOR[action],
    new Date(Date.now() - CLAIM_STALE_MS).toISOString(),
  );
  if (!claimed) {
    return NextResponse.json(
      { error: "Someone else is resolving this item, or it was just resolved." },
      { status: 409 },
    );
  }
  const marker = claimed.fulfillment!.late_payment!;
  const actor = { id: auth.user.id, label: auth.user.email };
  const resolvedAt = new Date().toISOString();
  const release = () =>
    driver
      .updateLatePayment(order.id, { claim: null, claim_at: null })
      .catch(() => null);

  try {
    const settled = (await driver.listPaymentsForOrder(order.id)).filter(
      (p) => p.status === "captured" || p.status === "authorized",
    );

    if (action === "accept") {
      if (netSettledCents(settled) < order.totals.total_cents) {
        await release();
        return NextResponse.json(
          { error: "The settled payments (net of refunds) do not cover this order; refund it instead." },
          { status: 409 },
        );
      }
      const { claim, claim_at, ...rest } = marker;
      void claim;
      void claim_at;
      const result = await finalizeOnlinePayment(order.id, {
        from: ["abandoned"],
        fulfillmentExtra: {
          late_payment: { ...rest, resolved: "accepted", resolved_at: resolvedAt },
        },
      });
      if (!result.won) {
        await release();
        return NextResponse.json(
          { error: "This order was already resolved." },
          { status: 409 },
        );
      }
      await recordAudit({
        actor,
        action: "late_payment_accepted",
        tenantId: order.tenant_id,
        detail: `Accepted late payment (${marker.amount_cents}c) on order ${order.id}.`,
      });
      return NextResponse.json({ order: result.order });
    }

    if (action === "refund") {
      // What to give back: everything (late), or just the excess (duplicate),
      // newest tender first.
      let remaining =
        marker.kind === "duplicate" ? marker.amount_cents : Number.MAX_SAFE_INTEGER;
      const manual: { payment_id: string; amount_cents: number }[] = [];
      const newestFirst = [...settled].sort((a, b) =>
        b.created_at.localeCompare(a.created_at),
      );
      for (const p of newestFirst) {
        if (remaining <= 0) break;
        const net = p.amount_cents + p.tip_cents - p.refunded_cents;
        if (net <= 0) continue;
        const take = Math.min(net, remaining);
        if (isManualRefundRail(p.rail)) {
          // The system cannot send crypto back: it stays captured, owed by hand.
          manual.push({ payment_id: p.id, amount_cents: take });
        } else {
          await refundPayment({
            paymentId: p.id,
            amountCents: take,
            refundId: `late-${p.id}-${take}`,
            reason: marker.kind === "duplicate" ? "duplicate payment" : "late payment on an expired checkout",
          });
        }
        remaining -= take;
      }
      const owedManually = manual.length > 0;
      const updated = await driver.updateLatePayment(order.id, {
        resolved: owedManually ? "refund_owed_manual" : "refunded",
        resolved_at: resolvedAt,
        manual_refunds: owedManually ? manual : null,
        claim: null,
        claim_at: null,
      });
      await recordAudit({
        actor,
        action: "late_payment_refunded",
        tenantId: order.tenant_id,
        detail: owedManually
          ? `Refund of order ${order.id}: card/cash part sent; ${manual.reduce((n, m) => n + m.amount_cents, 0)}c of CRYPTO is OWED BY HAND (no money moved).`
          : `Refunded ${marker.kind === "duplicate" ? "duplicate" : "late"} payment on order ${order.id}.`,
      });
      return NextResponse.json({
        order: updated,
        refundOwedManually: owedManually,
        note: owedManually
          ? "Not refunded yet: crypto cannot be sent back by the system. Return the money from your wallet / Coinbase account, then press Mark refunded."
          : undefined,
      });
    }

    // mark_refunded: staff did the manual transfer.
    for (const m of marker.manual_refunds ?? []) {
      await refundPayment({
        paymentId: m.payment_id,
        amountCents: m.amount_cents,
        refundId: `manual-${m.payment_id}-${m.amount_cents}`,
        reason: "manual crypto refund confirmed by staff",
      });
    }
    const updated = await driver.updateLatePayment(order.id, {
      resolved: "refunded",
      resolved_at: resolvedAt,
      manual_refunds: null,
      claim: null,
      claim_at: null,
    });
    await recordAudit({
      actor,
      action: "late_payment_refunded",
      tenantId: order.tenant_id,
      detail: `Staff confirmed the manual crypto refund of order ${order.id} was sent.`,
    });
    return NextResponse.json({ order: updated });
  } catch (err) {
    await release();
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Action failed." },
      { status: 502 },
    );
  }
}

