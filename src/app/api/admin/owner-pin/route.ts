/**
 * First owner PIN — /api/admin/owner-pin (back-office gate bootstrap).
 *
 * Deliberately NOT behind the back-office PIN gate: it is how an owner who has
 * no PIN yet gets one, so the gate can never lock an owner out (e.g. a manager
 * PIN was set through the hub before any owner had one). Instead it requires:
 *   - an OWNER device session of the tenant (membership role owner, not
 *     manager);
 *   - a RECENT account sign-in on this browser (src/lib/auth/admin-gate.ts
 *     #recentlySignedIn, 10 minutes) — a cashier at a till left signed in as
 *     the owner can't mint the owner a PIN they would then know; the UI asks
 *     the owner to sign in again (code `reauth_required`);
 *   - the target is an ACTIVE OWNER staff row with NO PIN. It never replaces
 *     an existing PIN (that is a reset, inside the gated back office).
 *
 * GET  ?tenantId=           → { owners: [{ id, name }] } owner rows without a PIN.
 * POST { tenantId, staffId } → { pin } once (server-issued, unique in the tenant).
 */
import { NextResponse } from "next/server";
import { getPosDriver } from "@/lib/db";
import { requireTenantAccess } from "@/lib/auth/tenant-guard";
import { recentlySignedIn } from "@/lib/auth/admin-gate";
import { issueStaffPin, REAUTH_REQUIRED } from "@/lib/staff/manage";
import { enforceRateLimit, readJsonBody, recordAudit } from "@/lib/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function ownersWithoutPin(tenantId: string) {
  const driver = getPosDriver();
  const [staff, withPin] = await Promise.all([
    driver.listStaff(tenantId),
    driver.listStaffWithPin(tenantId),
  ]);
  return staff.filter(
    (s) => s.active && s.role === "owner" && !withPin.has(s.id),
  );
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const auth = await requireTenantAccess(searchParams.get("tenantId"), [
    "owner",
  ]);
  if (!auth.ok) return auth.res;
  const owners = (await ownersWithoutPin(auth.tenantId)).map((s) => ({
    id: s.id,
    name: s.name,
  }));
  return NextResponse.json(
    { owners },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(request: Request) {
  const limited = enforceRateLimit(request, "auth");
  if (limited) return limited;
  const parsed = await readJsonBody(request);
  if (!parsed.ok) {
    return NextResponse.json(
      { error: parsed.error },
      { status: parsed.status },
    );
  }
  const b = (parsed.body ?? {}) as Record<string, unknown>;
  const auth = await requireTenantAccess(
    typeof b.tenantId === "string" ? b.tenantId : null,
    ["owner"],
  );
  if (!auth.ok) return auth.res;
  if (!recentlySignedIn(auth.user)) {
    return NextResponse.json(
      {
        error: "Sign in again to set an owner PIN (for your security).",
        code: REAUTH_REQUIRED,
      },
      { status: 401 },
    );
  }
  const target = (await ownersWithoutPin(auth.tenantId)).find(
    (s) => s.id === b.staffId,
  );
  if (!target) {
    return NextResponse.json(
      { error: "Only an active owner with no PIN yet can be set up here." },
      { status: 409 },
    );
  }
  const pin = await issueStaffPin(auth.tenantId, target.id);
  if (!pin)
    return NextResponse.json({ error: "Staff not found." }, { status: 404 });
  await recordAudit({
    actor: { id: auth.user.id, label: auth.user.email },
    action: "staff_pin_reset",
    tenantId: auth.tenantId,
    detail: `Issued the first PIN for owner staff ${target.id} "${target.name}" (signed-in owner).`,
  });
  return NextResponse.json(
    { pin, staffId: target.id },
    { headers: { "Cache-Control": "no-store" } },
  );
}
