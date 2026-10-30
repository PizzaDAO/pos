/**
 * POST /api/terminal/payments/[id]/cancel
 *
 * Cancel an open card tender: cancel_action on the reader, then cancel the
 * PaymentIntent. `outcome`:
 *  - `canceled`: done, the balance is restored;
 *  - `in_flight`: the customer is mid-authorization on the reader, wait (409);
 *  - `needs_review`: parked for a manager (PaymentIntent mismatch), 409;
 *  - `settled`: the card already went through (tender is `captured`; refund it
 *    if the cashier really meant to cancel).
 * Auth: owner | manager | cashier of the tender's tenant.
 */
import { NextResponse } from "next/server";
import { enforceRateLimit } from "@/lib/security";
import { cancelCardTender } from "@/lib/payments/terminal/flow";
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
  const limited = enforceRateLimit(request, "payments");
  if (limited) return limited;
  const { id } = await ctx.params;
  const auth = await authorizeTender(id, TILL_ROLES);
  if (!auth.ok) return auth.res;
  try {
    const { outcome, payment } = await cancelCardTender(id);
    return NextResponse.json(await tenderResponseBody(payment, { outcome }), {
      status: outcome === "in_flight" || outcome === "needs_review" ? 409 : 200,
    });
  } catch (err) {
    return errorResponse(err, "Could not cancel the card payment.");
  }
}
