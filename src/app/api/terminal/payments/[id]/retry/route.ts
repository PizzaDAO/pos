/**
 * POST /api/terminal/payments/[id]/retry  { readerId? }
 *
 * After a decline / customer cancel / offline reader: run
 * `process_payment_intent` again on the SAME PaymentIntent (Stripe: never
 * recreate the PI after a decline), optionally on another reader. The tender is
 * synced first, so a card that actually went through is never charged twice.
 * Auth: owner | manager | cashier of the tender's tenant.
 */
import { NextResponse } from "next/server";
import { enforceRateLimit, readJsonBody } from "@/lib/security";
import { retryCardTender } from "@/lib/payments/terminal/flow";
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
  const parsed = await readJsonBody(request);
  const body = (parsed.ok ? parsed.body : {}) as { readerId?: unknown } | null;
  const readerId = typeof body?.readerId === "string" && body.readerId ? body.readerId : undefined;
  try {
    const { payment, readerAction } = await retryCardTender(id, readerId);
    return NextResponse.json(await tenderResponseBody(payment, { readerAction }));
  } catch (err) {
    return errorResponse(err);
  }
}
