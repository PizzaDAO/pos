/**
 * POST /api/shop/gift-cards/reveal — the buyer's ONE-TIME look at an online
 * gift card's code after paying.
 *
 * Body: { orderId }. Needs the signed, short-lived `gc_reveal_<order>` cookie that the
 * purchase response set in the buyer's browser (bound to this order). Answers:
 *   200 { code }        the first time, once the card is active (cookie cleared);
 *   202 { pending }     the payment has not settled yet: try again shortly;
 *   410                 already revealed;
 *   403                 no valid token for this order.
 */
import { NextResponse } from "next/server";
import { readCookie } from "@/lib/auth/active-staff";
import { getPosDriver } from "@/lib/db";
import { verifyRevealToken } from "@/lib/giftcards/codes";
import { errorResponse, featureOff, revealCookieName } from "@/lib/giftcards/http";
import { revealOnlineCode } from "@/lib/giftcards/service";
import { enforceRateLimit, isUuid, readJsonBody } from "@/lib/security";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const off = featureOff();
  if (off) return off;
  const limited = enforceRateLimit(request, "paySync");
  if (limited) return limited;
  const parsed = await readJsonBody(request);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: parsed.status });
  const b = parsed.body as Record<string, unknown>;
  if (!isUuid(b.orderId)) return NextResponse.json({ error: "Malformed request." }, { status: 422 });
  if (!verifyRevealToken(readCookie(request, revealCookieName(b.orderId)), b.orderId)) {
    return NextResponse.json({ error: "This code can only be shown in the browser that bought it." }, { status: 403 });
  }
  const order = await getPosDriver().getOrder(b.orderId);
  if (!order) return NextResponse.json({ error: "Gift card not found." }, { status: 404 });
  try {
    const out = await revealOnlineCode(order.tenant_id, order.id);
    if (!out) return NextResponse.json({ pending: true }, { status: 202 });
    const res = NextResponse.json({ code: out.code, balanceCents: out.account.balance_cents });
    res.cookies.set(revealCookieName(order.id), "", { path: "/api/shop/gift-cards", maxAge: 0 });
    return res;
  } catch (err) {
    return errorResponse(err, "shop-giftcard-reveal");
  }
}
