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
import { requireAdminAccess } from "@/lib/auth/admin-gate";
import { giftCardsEnabled } from "@/lib/giftcards/limits";
import { getStoredValueStore } from "@/lib/giftcards/store";
import { captureError } from "@/lib/observability";
import { isRangeBound, normaliseRangeBound } from "@/lib/reports";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const locationParam = searchParams.get("locationId");
  const auth = await requireAdminAccess(request, searchParams.get("tenantId"), {
    locationId:
      !locationParam || locationParam === "all" ? null : locationParam,
  });
  if (!auth.ok) return auth.res;
  const { tenantId, locationId } = auth;
  const from = searchParams.get("from");
  const to = searchParams.get("to");
  if ((from && !isRangeBound(from)) || (to && !isRangeBound(to))) {
    return NextResponse.json(
      { error: "from / to must be yyyy-mm-dd or an ISO timestamp." },
      { status: 400 },
    );
  }

  const report = await getPosDriver().getSalesReport(tenantId, locationId, {
    from: from || null,
    to: to || null,
  });
  // Store credit issued has no order: add it from the stored-value ledger.
  if (report.stored_value && giftCardsEnabled()) {
    try {
      const store = await getStoredValueStore();
      // As dates: an ISO bound is reduced to its (UTC) date first.
      const fromDay = normaliseRangeBound(from);
      const toDay = normaliseRangeBound(to);
      const fromIso = fromDay ? `${fromDay}T00:00:00.000Z` : "1970-01-01T00:00:00.000Z";
      const toIso = toDay
        ? new Date(Date.parse(`${toDay}T00:00:00.000Z`) + 86_400_000).toISOString()
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
