/**
 * POST /api/orders/[id]/refund -- partial or full refund of an order.
 *
 * Body: {
 *   requestId,                       // client-minted, reused on retry (idempotent)
 *   lines?: [{ lineId, quantity }],  // item refund (amount derived from the order) ...
 *   amountCents?,                    // ... or a base (food) amount
 *   tipCents?,                       // tip to refund on top: kept separate + flagged
 *   paymentId?,                      // only this tender (default: card, then cash, ...)
 *   reasonCode, reasonText?,         // required (see src/lib/adjustments/reasons.ts)
 *   approval?: { staffId, pin },     // manager PIN above the location threshold
 *   cancel?: true,                   // give up on an unfinished request (requestId)
 * }
 *
 * Resuming: resend the SAME requestId (any body): a pending / partial / failed
 * request finishes what is left, never moving money twice. `cancel: true`
 * closes one that is stuck so its item units are released (refused while a
 * card refund of it may still be in flight at Stripe).
 *
 * Owner | manager | cashier (the ACTIVE staff member's role); above the
 * location's refund threshold a non-manager needs `approval` (403
 * `approval_required` otherwise). Money: card through Stripe (idempotency key
 * per tender + request), cash as a drawer cash-out, crypto recorded only
 * (`manualRefund`). 409 `refund_exceeds` when more than is left is asked for
 * (also when another till just took the same items). See
 * src/lib/adjustments/service.ts.
 */
import { NextResponse } from "next/server";
import { isUuid } from "@/lib/security";
import { optCents, parseLineSelections, prepareAction, respond } from "@/lib/adjustments/route";
import { cancelRefundRequest, refundOrder } from "@/lib/adjustments/service";

export const runtime = "nodejs";
// Must stay under the 2-minute order_adjustments claim so a hung provider call
// can't outlive its claim and let a retry run alongside it.
export const maxDuration = 60;

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const prepared = await prepareAction(request, id, "refund");
  if (!prepared.ok) return prepared.res;
  const { body, input } = prepared.action;
  if (body.cancel === true) return respond(await cancelRefundRequest(input));

  const lines =
    body.lines === undefined ? undefined : parseLineSelections(body.lines, { quantityRequired: true });
  if (lines === null) {
    return NextResponse.json({ error: "lines must be [{ lineId, quantity }]." }, { status: 422 });
  }
  if (!optCents(body.amountCents) || !optCents(body.tipCents)) {
    return NextResponse.json({ error: "Amounts must be non-negative integer cents." }, { status: 422 });
  }
  if (lines && body.amountCents !== undefined) {
    return NextResponse.json({ error: "Refund items or an amount, not both." }, { status: 422 });
  }
  if (body.paymentId !== undefined && body.paymentId !== null && !isUuid(body.paymentId)) {
    return NextResponse.json({ error: "paymentId must be a valid UUID." }, { status: 422 });
  }

  const result = await refundOrder({
    ...input,
    lines: lines?.map((l) => ({ line_id: l.line_id, quantity: l.quantity! })),
    amountCents: body.amountCents as number | undefined,
    tipCents: body.tipCents as number | undefined,
    paymentId: (body.paymentId as string | undefined) ?? null,
  });
  if (result.ok && (result.body.record as { status?: string } | undefined)?.status === "failed") {
    return NextResponse.json(result.body, { status: 502 });
  }
  return respond(result);
}
