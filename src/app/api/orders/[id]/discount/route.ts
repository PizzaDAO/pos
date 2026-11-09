/**
 * POST /api/orders/[id]/discount -- comp an item or discount the order
 * (before payment), or remove one.
 *
 * Body: {
 *   requestId, reasonCode, reasonText?, approval?: { staffId, pin },
 *   type: "comp" | "discount",
 *   lineId?, quantity?,          // comp: the item (+ units, default all)
 *   amountCents? | percentBps?,  // discount: fixed cents or basis points (1..10000)
 *   removeId?,                   // remove an applied comp/discount instead
 * }
 *
 * Above the location's comp threshold a non-manager needs `approval`. A paid
 * order is refused with 409 `use_refund`.
 */
import { NextResponse } from "next/server";
import { optCents, prepareAction, respond } from "@/lib/adjustments/route";
import { compOrDiscount } from "@/lib/adjustments/service";

export const runtime = "nodejs";

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const peek = request.clone();
  let type: "comp" | "discount" = "discount";
  try {
    const t = ((await peek.json()) as { type?: unknown })?.type;
    if (t === "comp") type = "comp";
  } catch {
    // prepareAction reports the malformed body
  }
  const prepared = await prepareAction(request, id, type);
  if (!prepared.ok) return prepared.res;
  const { body, input } = prepared.action;

  if (body.type !== "comp" && body.type !== "discount") {
    return NextResponse.json({ error: 'type must be "comp" or "discount".' }, { status: 422 });
  }
  if (!optCents(body.amountCents)) {
    return NextResponse.json({ error: "amountCents must be non-negative integer cents." }, { status: 422 });
  }
  const pct = body.percentBps;
  if (
    pct !== undefined &&
    !(typeof pct === "number" && Number.isSafeInteger(pct) && pct >= 1 && pct <= 10_000)
  ) {
    return NextResponse.json({ error: "percentBps must be 1..10000." }, { status: 422 });
  }
  const qty = body.quantity;
  if (qty !== undefined && !(typeof qty === "number" && Number.isSafeInteger(qty) && qty > 0)) {
    return NextResponse.json({ error: "quantity must be a positive whole number." }, { status: 422 });
  }
  const str = (v: unknown) => (typeof v === "string" && v.length <= 64 ? v : undefined);
  return respond(
    await compOrDiscount({
      ...input,
      type: body.type,
      lineId: str(body.lineId),
      quantity: qty as number | undefined,
      amountCents: body.amountCents as number | undefined,
      percentBps: pct as number | undefined,
      removeId: str(body.removeId),
    }),
  );
}
