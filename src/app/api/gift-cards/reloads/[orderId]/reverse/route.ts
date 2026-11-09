/**
 * POST /api/gift-cards/reloads/[orderId]/reverse — refund a paid reload.
 *
 * Body: { tenantId, reason }. Takes the reload amount back off the card (only if
 * the card still holds it) and refunds the reload's tenders. Owner/manager only
 * (the active PIN-switched staff member on a shared till).
 */
import { NextResponse } from "next/server";
import { enforceRateLimit, readJsonBody } from "@/lib/security";
import {
  cleanText,
  errorResponse,
  featureOff,
  requireManagerRole,
  requireTillStaff,
} from "@/lib/giftcards/http";
import { reverseReload } from "@/lib/giftcards/service";

export const runtime = "nodejs";

export async function POST(request: Request, ctx: { params: Promise<{ orderId: string }> }) {
  const off = featureOff();
  if (off) return off;
  const limited = enforceRateLimit(request, "payments");
  if (limited) return limited;
  const { orderId } = await ctx.params;
  const parsed = await readJsonBody(request);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: parsed.status });
  const b = parsed.body as Record<string, unknown>;
  const reason = cleanText(b.reason, 300);
  if (typeof b.tenantId !== "string" || !reason) {
    return NextResponse.json({ error: "tenantId and a reason are required." }, { status: 422 });
  }
  const auth = await requireTillStaff(request, b.tenantId);
  if (!auth.ok) return auth.res;
  const denied = requireManagerRole(auth.grant);
  if (denied) return denied;
  try {
    return NextResponse.json(
      await reverseReload({ tenantId: auth.grant.tenantId, orderId, reason, actor: auth.grant.actor }),
    );
  } catch (err) {
    return errorResponse(err, "giftcard-reverse");
  }
}
