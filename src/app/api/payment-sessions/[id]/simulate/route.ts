/**
 * POST /api/payment-sessions/[id]/simulate
 *
 * Completes a SIMULATED /v1 payment session (the button on /pay/sim/[id]).
 * 404 unless card rails are simulated AND the session was created simulated, so
 * it can never settle a real Stripe session. No auth: the unguessable session id
 * is the capability, exactly like the pay link it belongs to.
 */
import { NextResponse } from "next/server";
import { completeSimulatedSession } from "@/lib/core/sim-session";
import { enforceRateLimit } from "@/lib/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const limited = enforceRateLimit(request, "payments");
  if (limited) return limited;
  const { id } = await ctx.params;
  const out = await completeSimulatedSession(id);
  if (!out.ok) {
    return NextResponse.json(
      { error: out.reason === "not_found" ? "Not found." : "This payment link is no longer open." },
      { status: out.reason === "not_found" ? 404 : 409 },
    );
  }
  // 303: the browser follows a form POST with a GET to the merchant's success page.
  return NextResponse.redirect(out.row.success_url, 303);
}
