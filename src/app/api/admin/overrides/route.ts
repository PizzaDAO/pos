/**
 * Per-location menu overrides — /api/admin/overrides (Phase 5).
 *
 * GET  ?tenantId=&locationId=  → the location's price/availability overrides.
 * POST { ...OverrideInput }     → upsert a price and/or availability override
 *      (availability:false = "86 an item"/size/modifier at this location).
 * DELETE ?tenantId=&locationId=&targetType=&targetId= → clear an override.
 *
 * Overrides are folded into `getMenu`, so terminal/shop reads reflect them with
 * no call-site change. No env vars; in-memory mock driver.
 *
 * Auth: owner|manager of the tenant; the location AND the override target
 * (item/size/modifier) must belong to that tenant.
 */
import { NextResponse } from "next/server";
import {
  getPosDriver,
  type OverrideInput,
  type OverrideTargetType,
} from "@/lib/db";
import { requireTenantAccess } from "@/lib/auth/tenant-guard";
import { isMoneyCents, recordAudit } from "@/lib/security";

const TARGET_TYPES: OverrideTargetType[] = ["item", "size", "modifier"];

export const runtime = "nodejs";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const auth = await requireTenantAccess(searchParams.get("tenantId"), "admin", {
    locationId: searchParams.get("locationId"),
    requireLocation: true,
  });
  if (!auth.ok) return auth.res;
  const overrides = await getPosDriver().listOverrides(
    auth.tenantId,
    auth.locationId as string,
  );
  return NextResponse.json({ overrides });
}

export async function POST(request: Request) {
  let body: OverrideInput;
  try {
    body = (await request.json()) as OverrideInput;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (
    !body.tenant_id ||
    !body.location_id ||
    !body.target_type ||
    !body.target_id
  ) {
    return NextResponse.json(
      { error: "tenant_id, location_id, target_type, target_id are required." },
      { status: 422 },
    );
  }
  if (!TARGET_TYPES.includes(body.target_type)) {
    return NextResponse.json({ error: "Unknown target_type." }, { status: 422 });
  }
  if (
    body.price_cents !== undefined &&
    body.price_cents !== null &&
    !isMoneyCents(body.price_cents)
  ) {
    return NextResponse.json(
      { error: "price_cents must be a non-negative integer." },
      { status: 422 },
    );
  }
  const auth = await requireTenantAccess(body.tenant_id, "admin", {
    locationId: body.location_id,
    requireLocation: true,
  });
  if (!auth.ok) return auth.res;
  const driver = getPosDriver();
  const targetOwner = await driver.getMenuEntityTenant(
    body.target_type,
    body.target_id,
  );
  if (targetOwner !== auth.tenantId) {
    return NextResponse.json({ error: "Target not found." }, { status: 404 });
  }
  const override = await driver.upsertOverride({
    tenant_id: auth.tenantId,
    location_id: body.location_id,
    target_type: body.target_type,
    target_id: body.target_id,
    price_cents: body.price_cents,
    available: body.available,
  });

  // Audit a menu "86" (availability turned off) — a sensitive, customer-visible
  // catalogue change worth a tenant-scoped trail.
  if (body.available === false) {
    await recordAudit({
      actor: { id: auth.user.id, label: auth.user.email },
      action: "menu_86",
      tenantId: body.tenant_id,
      detail: `86'd ${body.target_type} ${body.target_id} at location ${body.location_id}.`,
    });
  }

  return NextResponse.json({ override }, { status: 201 });
}

export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url);
  const tenantId = searchParams.get("tenantId");
  const locationId = searchParams.get("locationId");
  const targetType = searchParams.get(
    "targetType",
  ) as OverrideTargetType | null;
  const targetId = searchParams.get("targetId");
  if (!tenantId || !locationId || !targetType || !targetId) {
    return NextResponse.json(
      { error: "tenantId, locationId, targetType, targetId are required." },
      { status: 400 },
    );
  }
  const auth = await requireTenantAccess(tenantId, "admin", { locationId });
  if (!auth.ok) return auth.res;
  await getPosDriver().clearOverride(
    tenantId,
    locationId,
    targetType,
    targetId,
  );
  return NextResponse.json({ ok: true });
}
