/**
 * GET /api/gift-cards?tenantId=&kind=gift_card|store_credit — list a tenant's
 * gift cards / store credit (last 4 only, never codes) plus the outstanding
 * liability. Owner | manager.
 */
import { NextResponse } from "next/server";
import { requireTenantAccess } from "@/lib/auth/tenant-guard";
import { featureOff } from "@/lib/giftcards/http";
import { getStoredValueStore } from "@/lib/giftcards/store";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const off = featureOff();
  if (off) return off;
  const { searchParams } = new URL(request.url);
  const auth = await requireTenantAccess(searchParams.get("tenantId"), ["owner", "manager"]);
  if (!auth.ok) return auth.res;
  const kindParam = searchParams.get("kind");
  const kind = kindParam === "gift_card" || kindParam === "store_credit" ? kindParam : undefined;
  const store = await getStoredValueStore();
  const accounts = await store.listAccounts(auth.tenantId, { kind, limit: 500 });
  const outstandingCents = accounts
    .filter((a) => a.status === "active")
    .reduce((n, a) => n + a.balance_cents, 0);
  return NextResponse.json({ accounts, outstandingCents });
}
