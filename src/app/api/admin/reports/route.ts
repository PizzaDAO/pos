/**
 * Sales reports — /api/admin/reports (Phase 5).
 *
 * GET ?tenantId=&locationId=&from=&to=
 *   - locationId omitted (or "all") → TENANT ROLLUP across all locations.
 *   - locationId set                 → scoped to that location.
 *   - from/to are inclusive "yyyy-mm-dd"; omit for open-ended.
 *
 * Returns a {@link SalesReport}: sliced by day/item/category/channel/location,
 * payment mix (cash/card/crypto), tips, fees, and void/refund tallies. Derived
 * from orders/payments via the DB abstraction. No env vars; mock driver.
 *
 * Auth: owner|manager of the tenant. tenantId defaults to the caller's single
 * authorized tenant (never to a hardcoded demo tenant); locationId must belong
 * to it.
 */
import { NextResponse } from "next/server";
import { getPosDriver } from "@/lib/db";
import { requireTenantAccess } from "@/lib/auth/tenant-guard";
import { giftCardsEnabled } from "@/lib/giftcards/limits";
import { getStoredValueStore } from "@/lib/giftcards/store";
import { captureError } from "@/lib/observability";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const locationParam = searchParams.get("locationId");
  const auth = await requireTenantAccess(searchParams.get("tenantId"), "admin", {
    locationId:
      !locationParam || locationParam === "all" ? null : locationParam,
  });
  if (!auth.ok) return auth.res;
  const { tenantId, locationId } = auth;
  const from = searchParams.get("from");
  const to = searchParams.get("to");

  const report = await getPosDriver().getSalesReport(tenantId, locationId, {
    from: from || null,
    to: to || null,
  });
  // Store credit issued has no order: add it from the stored-value ledger.
  if (report.stored_value && giftCardsEnabled()) {
    try {
      const store = await getStoredValueStore();
      const fromIso = from ? `${from}T00:00:00.000Z` : "1970-01-01T00:00:00.000Z";
      const toIso = to
        ? new Date(Date.parse(`${to}T00:00:00.000Z`) + 86_400_000).toISOString()
        : "9999-12-31T00:00:00.000Z";
      const sum = await store.summary(tenantId, locationId, fromIso, toIso);
      report.stored_value.store_credit_issued_count = sum.store_credit_issued_count;
      report.stored_value.store_credit_issued_cents = sum.store_credit_issued_cents;
      report.stored_value.outstanding_cents = sum.outstanding_cents;
    } catch (err) {
      captureError(err, { scope: "reports-store-credit", tenantId });
    }
  }
  return NextResponse.json({ report });
}
