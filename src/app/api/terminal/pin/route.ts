/**
 * Staff PIN quick-switch — /api/terminal/pin
 *
 * On a shared terminal, the DEVICE is logged into a location by a tenant user
 * (real Supabase session). Cashiers then switch the ACTIVE STAFF member by PIN,
 * without a full re-login, so orders/shifts attribute to whoever is at the till
 * and money-sensitive actions are authorized by THEIR role.
 *
 * Security:
 *   - The caller must hold an operational role (owner|manager|cashier|kitchen)
 *     on the tenant — enforced server-side from the session, NOT trusted from
 *     the body.
 *   - The PIN is verified SERVER-SIDE against `staff.pin_hash`; the hash never
 *     leaves the server.
 *   - Brute force: a strict per-IP rate limit PLUS a persisted per-staff
 *     lockout (5 failures → 15-minute lock; staff.pin_failed_attempts /
 *     pin_locked_until, atomic in record_pin_failure()).
 *   - A generic 401 is returned for a wrong PIN / unknown staff (no
 *     enumeration); a locked staff member gets 423 with the unlock time.
 *   - Success opens a server-side staff session and sets a signed httpOnly
 *     cookie bound to the device login (see src/lib/auth/active-staff.ts).
 *     Switching again or DELETE revokes the previous session.
 *
 * No env vars required (works on the mock driver).
 */
import { NextResponse } from "next/server";
import { getPosDriver } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth/session";
import { tenantsForSurface } from "@/lib/auth/roles";
import { requireTenantAccess } from "@/lib/auth/tenant-guard";
import { isValidPinFormat, verifyPin } from "@/lib/auth/pin";
import { enforceRateLimit, readJsonBody, recordAudit } from "@/lib/security";
import {
  ACTIVE_STAFF_COOKIE,
  activeStaffCookieOptions,
  openStaffSession,
  revokeRequestStaffSession,
} from "@/lib/auth/active-staff";

export const runtime = "nodejs";

/**
 * GET /api/terminal/pin?tenantId= — the active-staff PICKER for ONE terminal
 * tenant (the caller's sole terminal tenant when omitted): active staff with
 * only what the picker renders (id, name, role). No PIN hash, no tenant ids,
 * never other tenants' staff.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const auth = await requireTenantAccess(searchParams.get("tenantId"), "terminal");
  if (!auth.ok) return auth.res;
  const staff = (await getPosDriver().listStaff(auth.tenantId))
    .filter((s) => s.active)
    .map((s) => ({ id: s.id, name: s.name, role: s.role }));
  return NextResponse.json({ staff });
}

interface Body {
  staffId: string;
  pin: string;
}

function isValid(b: unknown): b is Body {
  if (!b || typeof b !== "object") return false;
  const r = b as Record<string, unknown>;
  return typeof r.staffId === "string" && typeof r.pin === "string";
}

const incorrect = () =>
  NextResponse.json({ error: "Incorrect PIN." }, { status: 401 });

export async function POST(request: Request) {
  // Brute-force defence on PIN verification — strict per-IP rate limit.
  const limited = enforceRateLimit(request, "pin");
  if (limited) return limited;

  // The device session authorizes WHICH tenant the PIN switch applies to.
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const parsed = await readJsonBody(request);
  if (!parsed.ok) {
    return NextResponse.json(
      { error: parsed.error },
      { status: parsed.status },
    );
  }
  const body = parsed.body;
  if (!isValid(body) || !isValidPinFormat(body.pin)) {
    return NextResponse.json({ error: "Invalid PIN." }, { status: 401 });
  }

  // Tenants the device user may operate a terminal for (operational roles).
  const allowedTenants = tenantsForSurface(user.memberships, "terminal");
  if (allowedTenants.length === 0) {
    return NextResponse.json({ error: "Not authorized." }, { status: 403 });
  }

  const driver = getPosDriver();
  // Find the staff member among the device user's authorized tenants.
  // getStaffById carries pin_hash; it never goes to the client.
  let matched: Awaited<ReturnType<typeof driver.getStaffById>> = null;
  for (const tenantId of allowedTenants) {
    const staff = await driver.getStaffById(tenantId, body.staffId);
    if (staff) {
      matched = staff;
      break;
    }
  }
  if (!matched || !matched.active) return incorrect();

  // Per-staff lockout (persisted): refuse while locked, BEFORE checking.
  const lock = await driver.getPinLockState(matched.tenant_id, matched.id);
  if (lock.lockedUntil) {
    return NextResponse.json(
      {
        error: "Too many incorrect PINs. Try again later.",
        lockedUntil: lock.lockedUntil,
      },
      { status: 423 },
    );
  }

  if (!verifyPin(body.pin, matched.pin_hash)) {
    const after = await driver.recordPinFailure(matched.tenant_id, matched.id);
    if (after.lockedUntil) {
      await recordAudit({
        actor: { id: user.id, label: user.email },
        action: "staff_pin_switch",
        tenantId: matched.tenant_id,
        detail: `PIN locked for ${matched.name} after repeated failures (until ${after.lockedUntil}).`,
      });
    }
    return incorrect();
  }
  await driver.clearPinFailures(matched.tenant_id, matched.id);

  // Replace any previous switch-in on this device (revoke it server-side).
  await revokeRequestStaffSession(request);
  const signed = await openStaffSession({
    userId: user.id,
    tenantId: matched.tenant_id,
    staffId: matched.id,
  });
  if (!signed) {
    return NextResponse.json(
      { error: "Staff switching is unavailable (server not configured)." },
      { status: 503 },
    );
  }

  // Audit the active-staff switch (tenant-scoped) — who took over the till.
  await recordAudit({
    actor: { id: user.id, label: user.email },
    action: "staff_pin_switch",
    tenantId: matched.tenant_id,
    detail: `Active staff switched to ${matched.name} (${matched.role}).`,
  });

  const res = NextResponse.json({
    activeStaff: {
      id: matched.id,
      tenant_id: matched.tenant_id,
      name: matched.name,
      role: matched.role,
    },
  });
  res.cookies.set(ACTIVE_STAFF_COOKIE, signed, activeStaffCookieOptions());
  return res;
}

/** DELETE /api/terminal/pin — switch the active staff out (revoke + clear). */
export async function DELETE(request: Request) {
  await revokeRequestStaffSession(request);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(ACTIVE_STAFF_COOKIE, "", {
    ...activeStaffCookieOptions(),
    maxAge: 0,
  });
  return res;
}
