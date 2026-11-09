/**
 * Menu endpoint — GET /api/menu?tenantId=&locationId=
 *
 * Returns the assembled menu graph + store settings for a location via the DB
 * abstraction (mock driver in Phase 1). Cached by the service worker so the
 * terminal can load the menu while offline.
 *
 * The menu INCLUDES items/sizes/modifiers 86'd at this location, with their ids
 * listed in `unavailable`, so the till shows them as "Sold out" (disabled)
 * instead of letting a stale menu ring them up. Place order still re-prices
 * against the customer menu and refuses an 86'd line.
 *
 * Auth: an operational role (terminal surface) of the tenant. When params are
 * omitted the caller's single authorized tenant + its first location are used
 * (never a hardcoded demo tenant). Public storefronts use /api/shop/location.
 */
import { NextResponse } from "next/server";
import { getPosDriver } from "@/lib/db";
import { requireTenantAccess } from "@/lib/auth/tenant-guard";
import { availabilityFromOverrides } from "@/lib/menu-availability";

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

  const [menu, settings, paymentSettings, overrides] = await Promise.all([
    driver.getMenu(tenantId, locationId, { includeUnavailable: true }),
    driver.getStoreSettings(tenantId, locationId),
    driver.getPaymentSettings(tenantId, locationId),
    driver.listOverrides(tenantId, locationId),
  ]);

  return NextResponse.json({
    menu,
    unavailable: availabilityFromOverrides(overrides),
    settings,
    paymentSettings,
    driver: driver.name,
  });
}
