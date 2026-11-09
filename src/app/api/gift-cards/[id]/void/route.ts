/**
 * POST /api/gift-cards/[id]/void — void a gift card / store credit.
 *
 * Body: { tenantId, reason }. Only an UNREDEEMED card can be voided. A sold gift
 * card's sale is then refunded (cash back from the drawer / card back through
 * Stripe); an unpaid card is just closed with its sale. Owner/manager only (the
 * active PIN-switched staff member on a shared till). Audited.
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
import { voidStoredValue } from "@/lib/giftcards/service";

export const runtime = "nodejs";

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const off = featureOff();
  if (off) return off;
  const limited = enforceRateLimit(request, "payments");
  if (limited) return limited;
  const { id } = await ctx.params;
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
    const out = await voidStoredValue({
      tenantId: auth.grant.tenantId,
      accountId: id,
      locationId: auth.grant.locationId,
      reason,
      actor: auth.grant.actor,
    });
    return NextResponse.json(out);
  } catch (err) {
    return errorResponse(err, "giftcard-void");
  }
}
