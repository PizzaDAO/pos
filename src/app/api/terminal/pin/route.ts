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
 *     lockout (5 attempts without a success → 15-minute lock;
 *     staff.pin_failed_attempts / pin_locked_until). Each attempt is counted
 *     atomically BEFORE the PIN is checked (begin_pin_attempt, row lock), so
 *     concurrent guesses cannot race past the budget.
 *   - A generic 401 is returned for a wrong PIN / unknown staff (no
 *     enumeration); a locked staff member gets 423 with the unlock time.
 *   - Success opens a server-side staff session and sets a signed httpOnly
 *     cookie bound to the device login (see src/lib/auth/active-staff.ts).
 *     Switching again or DELETE revokes the previous session (on a switch the
 *     client also names its last known session id, revoked when it belongs
 *     to this device login — covers a lost cookie).
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
  revokeOwnStaffSession,
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
  /**
   * The client's last known staff-session id (from sessionStorage). Revoked
   * along with the cookie's session, so a switch-in after the cookie was lost
   * still ends the previous staff member's session.
   */
  previousSessionId?: unknown;
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

  // Per-staff lockout (persisted), ATOMIC: begin_pin_attempt counts this
  // attempt under a row lock BEFORE the PIN is checked, so N concurrent
  // guesses can't all slip past a "not locked yet" read. Refused while locked.
  const attemptState = await driver.beginPinAttempt(
    matched.tenant_id,
    matched.id,
  );
  if (!attemptState.allowed) {
    if (attemptState.justLocked) {
      await recordAudit({
        actor: { id: user.id, label: user.email },
        action: "staff_pin_switch",
        tenantId: matched.tenant_id,
        detail: `PIN locked for ${matched.name} after repeated failures (until ${attemptState.lockedUntil}).`,
      });
    }
    return NextResponse.json(
      {
        error: "Too many incorrect PINs. Try again later.",
        lockedUntil: attemptState.lockedUntil,
      },
      { status: 423 },
    );
  }

  if (!verifyPin(body.pin, matched.pin_hash)) return incorrect();
  // Reset the count — unless a concurrent burst set a lock meanwhile.
  await driver.clearPinAttempts(matched.tenant_id, matched.id);

  // Replace any previous switch-in on this device (revoke it server-side):
  // the cookie's session, and the session the client last knew about when it
  // is bound to this device login (the cookie may have been lost).
  await revokeRequestStaffSession(request);
  if (typeof body.previousSessionId === "string" && body.previousSessionId) {
    await revokeOwnStaffSession(body.previousSessionId, user.id);
  }
  const opened = await openStaffSession({
    userId: user.id,
    tenantId: matched.tenant_id,
    staffId: matched.id,
  });
  if (!opened) {
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
      // Recorded with orders queued offline under this switch-in; useless
      // without this device login (the session row is bound to its user id).
      session_id: opened.sessionId,
    },
  });
  res.cookies.set(ACTIVE_STAFF_COOKIE, opened.cookie, activeStaffCookieOptions());
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
