/**
 * Menu endpoint — GET /api/menu?tenantId=&locationId=
 *
 * Returns the assembled menu graph + store settings for a location via the DB
 * abstraction (mock driver in Phase 1). Cached by the service worker so the
 * terminal can load the menu while offline. Falls back to the demo context when
 * params are omitted.
 */
import { NextResponse } from "next/server";
import {
  DEMO_LOCATION_DOWNTOWN_ID,
  DEMO_TENANT_ID,
  getPosDriver,
} from "@/lib/db";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const tenantId = searchParams.get("tenantId") ?? DEMO_TENANT_ID;
  const locationId =
    searchParams.get("locationId") ?? DEMO_LOCATION_DOWNTOWN_ID;

  const driver = getPosDriver();
  const [menu, settings] = await Promise.all([
    driver.getMenu(tenantId, locationId),
    driver.getStoreSettings(tenantId, locationId),
  ]);

  return NextResponse.json({ menu, settings, driver: driver.name });
}
