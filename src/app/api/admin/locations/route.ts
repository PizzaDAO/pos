/**
 * Tenant locations — /api/admin/locations (Phase 6).
 *
 * GET  ?tenantId=  → the tenant's locations + entitlement usage (count vs cap).
 * POST { tenantId, name, address? } → add a location, GATED by the plan's
 *      `max_locations` entitlement. Adding beyond the cap returns 402 with the
 *      upgrade reason — this is the canonical "plan gating blocks an over-limit
 *      action" proof point.
 *
 * All data through the DB abstraction (mock driver); no env vars.
 */
import { NextResponse } from "next/server";
import { getPosDriver } from "@/lib/db";
import { canAddLocation, resolveEntitlements } from "@/lib/saas/entitlements";
import { requireTenantRole } from "@/lib/auth/api";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const tenantId = searchParams.get("tenantId");
  if (!tenantId) {
    return NextResponse.json({ error: "tenantId is required." }, { status: 400 });
  }
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
  // Only an owner|manager of this tenant may add a location.
  const auth = await requireTenantRole(body.tenantId, ["owner", "manager"]);
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
  });
  return NextResponse.json({ location }, { status: 201 });
}
