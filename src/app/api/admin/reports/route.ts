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
 */
import { NextResponse } from "next/server";
import { DEMO_TENANT_ID, getPosDriver } from "@/lib/db";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const tenantId = searchParams.get("tenantId") ?? DEMO_TENANT_ID;
  const locationParam = searchParams.get("locationId");
  const locationId =
    !locationParam || locationParam === "all" ? null : locationParam;
  const from = searchParams.get("from");
  const to = searchParams.get("to");

  const report = await getPosDriver().getSalesReport(tenantId, locationId, {
    from: from || null,
    to: to || null,
  });
  return NextResponse.json({ report });
}
