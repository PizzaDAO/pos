/**
 * GET /api/gift-cards/[id]?tenantId= — one account and its full ledger (oldest
 * first), with an integrity check of the cached balance. Back office: owner | manager behind the PIN gate (requireAdminAccess).
 */
import { NextResponse } from "next/server";
import { requireAdminAccess } from "@/lib/auth/admin-gate";
import { featureOff } from "@/lib/giftcards/http";
import { verifyLedger } from "@/lib/giftcards/ledger";
import { getStoredValueStore } from "@/lib/giftcards/store";

export const runtime = "nodejs";

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const off = featureOff();
  if (off) return off;
  const { id } = await ctx.params;
  const { searchParams } = new URL(request.url);
  const auth = await requireAdminAccess(request, searchParams.get("tenantId"));
  if (!auth.ok) return auth.res;
  const store = await getStoredValueStore();
  const account = await store.getAccount(auth.tenantId, id);
  if (!account) return NextResponse.json({ error: "Gift card not found." }, { status: 404 });
  const ledger = await store.listLedger(auth.tenantId, id);
  const check = verifyLedger(ledger, account);
  return NextResponse.json({ account, ledger, ledgerOk: check.ok });
}
