/**
 * POST /api/terminal/payments/[id]/simulate  { outcome: "approve"|"decline", tipCents? }
 *
 * Drive the SIMULATED reader (sandbox / demo only). Simulated mode records the
 * outcome; Stripe test mode calls the `present_payment_method` test helper
 * (decline uses 4000000000000002, a tip uses `amount_tip`). Live mode: 404.
 * Auth: owner | manager | cashier of the tender's tenant.
 */
import { NextResponse } from "next/server";
import { cardReaderMode, isStripeLiveKey } from "@/lib/payments/env";
import { enforceRateLimit, isMoneyCents, readJsonBody } from "@/lib/security";
import { simulateCardTender } from "@/lib/payments/terminal/flow";
import {
  TILL_ROLES,
  authorizeTender,
  errorResponse,
  tenderResponseBody,
} from "@/lib/payments/terminal/http";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  // A deployment with a live key has no simulator (whatever the mode, even
  // training): indistinguishable from a missing route.
  if (cardReaderMode() === "stripe_live" || isStripeLiveKey()) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  const limited = enforceRateLimit(request, "payments");
  if (limited) return limited;
  const { id } = await ctx.params;
  const auth = await authorizeTender(id, TILL_ROLES);
  if (!auth.ok) return auth.res;
  const parsed = await readJsonBody(request);
  const b = (parsed.ok ? parsed.body : null) as Record<string, unknown> | null;
  if (
    !b ||
    (b.outcome !== "approve" && b.outcome !== "decline") ||
    (b.tipCents !== undefined && !isMoneyCents(b.tipCents))
  ) {
    return NextResponse.json({ error: "outcome must be approve or decline." }, { status: 422 });
  }
  try {
    const { payment, readerAction } = await simulateCardTender(id, {
      outcome: b.outcome,
      tipCents: b.tipCents as number | undefined,
    });
    return NextResponse.json(await tenderResponseBody(payment, { readerAction }));
  } catch (err) {
    return errorResponse(err);
  }
}
