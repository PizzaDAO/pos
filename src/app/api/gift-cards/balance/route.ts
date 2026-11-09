/**
 * POST /api/gift-cards/balance — check a gift card / store credit at the till.
 *
 * Body: { tenantId, code } -> { account: { id, kind, status, balance_cents,
 * code_last4, currency } }. Unknown codes are a uniform 404 and count toward the
 * per-IP + per-device lockout. Auth: owner | manager | cashier.
 */
import { NextResponse } from "next/server";
import { readJsonBody } from "@/lib/security";
import {
  admitLookup,
  errorResponse,
  featureOff,
  lookupIdentity,
  requireTillStaff,
  unknownCode,
} from "@/lib/giftcards/http";
import { accountView, findAccountByCode } from "@/lib/giftcards/service";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const off = featureOff();
  if (off) return off;
  const parsed = await readJsonBody(request);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: parsed.status });
  const b = parsed.body as Record<string, unknown>;
  if (typeof b.tenantId !== "string") {
    return NextResponse.json({ error: "tenantId is required." }, { status: 422 });
  }
  const auth = await requireTillStaff(request, b.tenantId);
  if (!auth.ok) return auth.res;
  const id = lookupIdentity(request, "till", auth.grant.user.id);
  const blocked = admitLookup(id);
  if (blocked) return blocked;
  try {
    const account = await findAccountByCode(auth.grant.tenantId, b.code);
    if (!account) return unknownCode(id);
    return NextResponse.json({ account: accountView(account) });
  } catch (err) {
    return errorResponse(err, "giftcard-balance");
  }
}
