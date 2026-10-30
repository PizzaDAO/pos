/**
 * GET /api/terminal/payments/[id]
 *
 * Sync a card tender with Stripe (or the simulated reader) and return it. The
 * till polls this every ~1.5s while the tender is `requires_action`/`pending`.
 * Settling goes through `applyRailStatus`, which also marks the order paid.
 * Response: `{ payment, readerAction, balanceCents, orderStatus }`; a decline or
 * customer cancel shows as `payment.raw.last_error` with the tender still open.
 * Auth: owner | manager | cashier of the tender's tenant.
 */
import { NextResponse } from "next/server";
import { enforceRateLimit } from "@/lib/security";
import { syncCardTender } from "@/lib/payments/terminal/flow";
import {
  TILL_ROLES,
  authorizeTender,
  errorResponse,
  tenderResponseBody,
} from "@/lib/payments/terminal/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const limited = enforceRateLimit(request, "payments");
  if (limited) return limited;
  const { id } = await ctx.params;
  const auth = await authorizeTender(id, TILL_ROLES);
  if (!auth.ok) return auth.res;
  try {
    const { payment, readerAction } = await syncCardTender(id);
    return NextResponse.json(await tenderResponseBody(payment, { readerAction }), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    return errorResponse(err, "Could not check the card payment.");
  }
}
