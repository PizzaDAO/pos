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
 */
import { NextResponse } from "next/server";
import {
  getPosDriver,
  type OverrideInput,
  type OverrideTargetType,
} from "@/lib/db";
import { requireTenantRole } from "@/lib/auth/api";
import { recordAudit } from "@/lib/security";

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
  const overrides = await getPosDriver().listOverrides(tenantId, locationId);
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
  const auth = await requireTenantRole(body.tenant_id, ["owner", "manager"]);
  if (!auth.ok) return auth.res;
  const override = await getPosDriver().upsertOverride(body);

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
  const auth = await requireTenantRole(tenantId, ["owner", "manager"]);
  if (!auth.ok) return auth.res;
  await getPosDriver().clearOverride(
    tenantId,
    locationId,
    targetType,
    targetId,
  );
  return NextResponse.json({ ok: true });
}
