/**
 * Refund / comp / void approval thresholds per location --
 * /api/admin/adjustment-policy.
 *
 * GET  ?tenantId=&locationId=  -> the location's policy (defaults applied).
 * POST { tenantId, locationId, refund_approval_cents, comp_approval_cents,
 *        void_approval_cents } -> set it. OWNER only (a manager must not raise
 *        the limit a cashier may refund without them): the back-office PIN
 *        gate's unlocked staff role (requireAdminAccess), not the device login.
 *
 * A cashier may refund / comp / void fired food up to the threshold alone;
 * above it an owner or manager approves by PIN at the till. 0 = always.
 */
import { NextResponse } from "next/server";
import { getPosDriver } from "@/lib/db";
import { requireAdminAccess } from "@/lib/auth/admin-gate";
import { parsePolicy, resolvePolicy } from "@/lib/adjustments/policy";
import { readJsonBody, recordAudit } from "@/lib/security";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const auth = await requireAdminAccess(request, searchParams.get("tenantId"), {
    locationId: searchParams.get("locationId"),
    requireLocation: true,
  });
  if (!auth.ok) return auth.res;
  const settings = await getPosDriver().getStoreSettings(auth.tenantId, auth.locationId as string);
  return NextResponse.json({ policy: resolvePolicy(settings.adjustment_policy) });
}

export async function POST(request: Request) {
  const parsed = await readJsonBody(request);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: parsed.status });
  const body = (parsed.body ?? {}) as Record<string, unknown>;
  const auth = await requireAdminAccess(
    request,
    typeof body.tenantId === "string" ? body.tenantId : null,
    { locationId: typeof body.locationId === "string" ? body.locationId : null, requireLocation: true },
  );
  if (!auth.ok) return auth.res;
  // The UNLOCKED staff member's role (PIN gate), not the device login's.
  if (auth.actor.role !== "owner") {
    return NextResponse.json({ error: "Only the owner can change approval limits." }, { status: 403 });
  }
  const policy = parsePolicy(body);
  if (!policy) {
    return NextResponse.json(
      { error: "Thresholds must be whole cents between 0 and 10,000,000." },
      { status: 422 },
    );
  }
  const settings = await getPosDriver().setAdjustmentPolicy(
    auth.tenantId,
    auth.locationId as string,
    policy,
  );
  await recordAudit({
    actor: { id: auth.user.id, label: auth.user.email },
    action: "adjustment_policy_change",
    tenantId: auth.tenantId,
    detail: `Approval limits for location ${auth.locationId}: refund ${policy.refund_approval_cents}c, comp ${policy.comp_approval_cents}c, void ${policy.void_approval_cents}c.`,
  });
  return NextResponse.json({ policy: resolvePolicy(settings.adjustment_policy) });
}
