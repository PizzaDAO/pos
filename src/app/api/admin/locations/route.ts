/**
 * Tenant locations — /api/admin/locations (Phase 6).
 *
 * GET  ?tenantId=  → the tenant's locations + entitlement usage (count vs cap).
 * PATCH { tenantId, locationId, country } → set an existing location's country.
 * PATCH { tenantId, locationId, businessDayCutoffMinutes } → when the business day starts.
 * POST { tenantId, name, address?, country? } → add a location, GATED by the plan's
 *      `max_locations` entitlement. Adding beyond the cap returns 402 with the
 *      upgrade reason — this is the canonical "plan gating blocks an over-limit
 *      action" proof point.
 *
 * All data through the DB abstraction (mock driver); no env vars.
 *
 * Auth: owner|manager of the tenant (session-derived).
 */
import { NextResponse } from "next/server";
import { getPosDriver } from "@/lib/db";
import { canAddLocation, resolveEntitlements } from "@/lib/saas/entitlements";
import { requireTenantAccess } from "@/lib/auth/tenant-guard";
import { recordAudit } from "@/lib/security";

/** What changing a location's country does to phone numbers (shown before saving). */
const COUNTRY_CHANGE_WARNING =
  "Changing a location's country changes how customers' phone numbers are read. " +
  "Numbers typed without a + country code are read as national numbers of the NEW country; " +
  "only US and CA numbers can be read that way, so for any other country they are left " +
  "unreadable until a +country-code number is given. Stored numbers are not rewritten, but " +
  "customer lookup and phone de-duplication use the new country, so the same person may stop " +
  "matching (or start matching) existing customers.";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const auth = await requireTenantAccess(searchParams.get("tenantId"), "admin");
  if (!auth.ok) return auth.res;
  const tenantId = auth.tenantId;
  const driver = getPosDriver();
  const [locations, subscription] = await Promise.all([
    driver.listLocations(tenantId),
    driver.getSubscription(tenantId),
  ]);
  const entitlements = resolveEntitlements(subscription);
  return NextResponse.json({
    locations,
    entitlements,
    gate: canAddLocation(entitlements, locations.length),
  });
}

interface AddLocationBody {
  tenantId?: string;
  name?: string;
  address?: string | null;
  timezone?: string;
  /** ISO 3166-1 alpha-2; optional. Unset reads as US for phone numbers. */
  country?: string | null;
}

/**
 * PATCH { tenantId, locationId, country } -> set (or clear, with null) the ISO
 * country of an existing location. Phones are read in this country; a location
 * with none reads as US.
 */
export async function PATCH(request: Request) {
  let body: {
    tenantId?: string;
    locationId?: string;
    country?: string | null;
    confirmPhoneEffects?: boolean;
    businessDayCutoffMinutes?: number;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  // { tenantId, locationId, businessDayCutoffMinutes } -> when the business day
  // starts (minutes after local midnight; 0-719). Reports bucket orders by it.
  if (body.businessDayCutoffMinutes !== undefined) {
    const m = body.businessDayCutoffMinutes;
    if (!body.tenantId || !body.locationId || !Number.isInteger(m) || m < 0 || m > 719) {
      return NextResponse.json(
        { error: "tenantId, locationId and businessDayCutoffMinutes (integer 0-719) are required." },
        { status: 422 },
      );
    }
    const cutoffAuth = await requireTenantAccess(body.tenantId, "admin");
    if (!cutoffAuth.ok) return cutoffAuth.res;
    const updated = await getPosDriver().setLocationBusinessDayCutoff(cutoffAuth.tenantId, body.locationId, m);
    if (!updated) return NextResponse.json({ error: "Location not found." }, { status: 404 });
    return NextResponse.json({ location: updated });
  }
  if (!body.tenantId || !body.locationId || body.country === undefined) {
    return NextResponse.json(
      { error: "tenantId, locationId and country (or null) are required." },
      { status: 422 },
    );
  }
  const country = body.country ? String(body.country).trim().toUpperCase() : null;
  if (country && !/^[A-Z]{2}$/.test(country)) {
    return NextResponse.json({ error: "country must be a 2-letter ISO code." }, { status: 422 });
  }
  const auth = await requireTenantAccess(body.tenantId, "admin");
  if (!auth.ok) return auth.res;
  const driver = getPosDriver();
  const before = (await driver.listLocations(auth.tenantId)).find((l) => l.id === body.locationId);
  if (!before) return NextResponse.json({ error: "Location not found." }, { status: 404 });
  if ((before.country ?? null) === country) return NextResponse.json({ location: before });
  if (body.confirmPhoneEffects !== true) {
    return NextResponse.json(
      { error: COUNTRY_CHANGE_WARNING, code: "confirm_required" },
      { status: 422 },
    );
  }
  const location = await driver.setLocationCountry(auth.tenantId, body.locationId, country);
  if (!location) return NextResponse.json({ error: "Location not found." }, { status: 404 });
  await recordAudit({
    actor: { id: auth.user.id, label: auth.user.email },
    action: "location_country_change",
    tenantId: auth.tenantId,
    detail: `Location ${location.id} country ${before.country ?? "(unset, read as US)"} -> ${country ?? "(unset, read as US)"}; phone numbers are read in the new country.`,
  });
  return NextResponse.json({ location });
}

export async function POST(request: Request) {
  let body: AddLocationBody;
  try {
    body = (await request.json()) as AddLocationBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (!body.tenantId || !body.name?.trim()) {
    return NextResponse.json(
      { error: "tenantId and name are required." },
      { status: 422 },
    );
  }
  const country = body.country ? String(body.country).trim().toUpperCase() : null;
  if (country && !/^[A-Z]{2}$/.test(country)) {
    return NextResponse.json({ error: "country must be a 2-letter ISO code." }, { status: 422 });
  }
  // Only an owner|manager of this tenant may add a location.
  const auth = await requireTenantAccess(body.tenantId, "admin");
  if (!auth.ok) return auth.res;

  const driver = getPosDriver();

  // --- Plan gating: block adding a location beyond the tier cap. ---
  const [existing, subscription] = await Promise.all([
    driver.listLocations(body.tenantId),
    driver.getSubscription(body.tenantId),
  ]);
  const entitlements = resolveEntitlements(subscription);
  const gate = canAddLocation(entitlements, existing.length);
  if (!gate.allowed) {
    return NextResponse.json(
      { error: gate.reason, code: "plan_limit", entitlements },
      { status: 402 },
    );
  }

  const location = await driver.createLocation({
    tenant_id: body.tenantId,
    name: body.name.trim(),
    address: body.address ?? null,
    timezone: body.timezone,
    ...(country ? { country } : {}),
  });
  return NextResponse.json({ location }, { status: 201 });
}
