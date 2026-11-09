/**
 * POST /api/orders/[id]/void -- void items or the whole order.
 *
 * Body: {
 *   requestId, reasonCode, reasonText?, approval?: { staffId, pin },
 *   lines?: [{ lineId, quantity? }],   // void these lines (some units, or all)
 *   wholeOrder?: true,                 // ... or the whole order
 * }
 *
 * Before payment: the lines / order are voided (fired food shows as VOID on the
 * kitchen screen; voiding food already sent needs approval above the location's
 * void threshold). After payment: voiding a line is refused with 409
 * `use_refund` (refund the item instead); voiding the whole order refunds
 * everything still held (the refund flow, refund threshold).
 */
import { NextResponse } from "next/server";
import { parseLineSelections, prepareAction, respond } from "@/lib/adjustments/route";
import { voidLines, voidOrder } from "@/lib/adjustments/service";

export const runtime = "nodejs";
// Must stay under the 2-minute order_adjustments claim (voiding a paid order refunds).
export const maxDuration = 60;

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const peek = request.clone();
  let whole = false;
  try {
    whole = ((await peek.json()) as { wholeOrder?: unknown })?.wholeOrder === true;
  } catch {
    // prepareAction reports the malformed body
  }
  const prepared = await prepareAction(request, id, whole ? "void_order" : "void_line");
  if (!prepared.ok) return prepared.res;
  const { body, input } = prepared.action;

  if (whole) return respond(await voidOrder(input));

  const lines = parseLineSelections(body.lines, { quantityRequired: false });
  if (!lines) {
    return NextResponse.json(
      { error: "Send lines: [{ lineId, quantity? }] or wholeOrder: true." },
      { status: 422 },
    );
  }
  return respond(
    await voidLines({
      ...input,
      selections: lines,
      newLineId: () => globalThis.crypto.randomUUID(),
    }),
  );
}
