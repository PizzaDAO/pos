/**
 * Menu endpoint — GET /api/menu?tenantId=&locationId=
 *
 * Returns the assembled menu graph + store settings for a location via the DB
 * abstraction (mock driver in Phase 1). Cached by the service worker so the
 * terminal can load the menu while offline.
 *
 * Auth: an operational role (terminal surface) of the tenant. When params are
 * omitted the caller's single authorized tenant + its first location are used
 * (never a hardcoded demo tenant). Public storefronts use /api/shop/location.
 */
import { NextResponse } from "next/server";
import { getPosDriver } from "@/lib/db";
import { requireTenantAccess } from "@/lib/auth/tenant-guard";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const auth = await requireTenantAccess(searchParams.get("tenantId"), "terminal", {
    locationId: searchParams.get("locationId"),
  });
  if (!auth.ok) return auth.res;
  const tenantId = auth.tenantId;
  const driver = getPosDriver();
  const locationId =
    auth.locationId ?? (await driver.listLocations(tenantId))[0]?.id;
  if (!locationId) {
    return NextResponse.json(
      { error: "This tenant has no locations." },
      { status: 404 },
    );
  }

  const [menu, settings, paymentSettings] = await Promise.all([
    driver.getMenu(tenantId, locationId),
    driver.getStoreSettings(tenantId, locationId),
    driver.getPaymentSettings(tenantId, locationId),
  ]);

  return NextResponse.json({
    menu,
    settings,
    paymentSettings,
    driver: driver.name,
  });
}
