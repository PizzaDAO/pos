/**
 * GET /api/orders/open?tenantId=&locationId=
 *
 * The till's unpaid in-store orders (balance > 0, live tenders only), computed
 * server-side in two queries (orders, then all their tenders). Tenant member +
 * location scoped exactly like GET /api/orders.
 */
import { NextResponse } from "next/server";
import { getPosDriver } from "@/lib/db";
import { requireTenantMember } from "@/lib/auth/api";
import { requireLocationInTenant } from "@/lib/auth/tenant-guard";
import { selectOpenOrders } from "@/lib/payments/open-orders";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const tenantId = searchParams.get("tenantId");
  const locationId = searchParams.get("locationId");
  if (!tenantId || !locationId) {
    return NextResponse.json(
      { error: "tenantId and locationId are required." },
      { status: 400 },
    );
  }
  const auth = await requireTenantMember(tenantId);
  if (!auth.ok) return auth.res;
  const locationDenied = await requireLocationInTenant(tenantId, locationId);
  if (locationDenied) return locationDenied.res;

  const driver = getPosDriver();
  const orders = (await driver.listOrders(tenantId, locationId, { limit: 300 }))
    .filter((o) => o.channel === "in_store");
  const payments = await driver.listPaymentsForOrders(orders.map((o) => o.id));
  return NextResponse.json({ orders: selectOpenOrders(orders, payments) });
}
