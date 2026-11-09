/**
 * GET /api/gift-cards?tenantId=&kind=gift_card|store_credit — list a tenant's
 * gift cards / store credit (last 4 only, never codes) plus the outstanding
 * liability (aggregated in SQL; the list shows the newest 500). Back office: owner | manager behind the PIN gate (requireAdminAccess).
 */
import { NextResponse } from "next/server";
import { requireAdminAccess } from "@/lib/auth/admin-gate";
import { featureOff } from "@/lib/giftcards/http";
import { getStoredValueStore } from "@/lib/giftcards/store";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const off = featureOff();
  if (off) return off;
  const { searchParams } = new URL(request.url);
  const auth = await requireAdminAccess(request, searchParams.get("tenantId"));
  if (!auth.ok) return auth.res;
  const kindParam = searchParams.get("kind");
  const kind = kindParam === "gift_card" || kindParam === "store_credit" ? kindParam : undefined;
  const store = await getStoredValueStore();
  const accounts = await store.listAccounts(auth.tenantId, { kind, limit: 500 });
  // Aggregated by the store (SQL), not from the (capped) listing.
  const outstandingCents = (
    await store.summary(auth.tenantId, null, "1970-01-01T00:00:00.000Z", "1970-01-01T00:00:00.000Z")
  ).outstanding_cents;
  return NextResponse.json({ accounts, outstandingCents });
}
