/**
 * Tenant entitlements — GET /api/entitlements?tenantId= (Phase 6).
 *
 * The single server source of truth the back office consults to gate features
 * (locations, online ordering, advanced reports). Derives the effective
 * entitlements from the tenant's subscription tier + lifecycle status, and adds
 * the current location/staff counts so the UI can show "X of N used".
 */
import { NextResponse } from "next/server";
import { getPosDriver } from "@/lib/db";
import { resolveEntitlements } from "@/lib/saas/entitlements";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const tenantId = searchParams.get("tenantId");
  if (!tenantId) {
    return NextResponse.json({ error: "tenantId is required." }, { status: 400 });
  }
  const driver = getPosDriver();
  const [subscription, locations, staff] = await Promise.all([
    driver.getSubscription(tenantId),
    driver.listLocations(tenantId),
    driver.listStaff(tenantId),
  ]);
  const entitlements = resolveEntitlements(subscription);
  return NextResponse.json({
    entitlements,
    usage: {
      locations: locations.length,
      staff: staff.length,
    },
  });
}
