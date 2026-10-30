/**
 * Server-verified ACTIVE STAFF on a shared terminal (server-only).
 *
 * The terminal device is logged in by one user (often the owner), while the
 * person at the till switches in by PIN. Money-sensitive actions (discounts,
 * refunds, voids) are authorized by the ACTIVE staff member's role, not the
 * device login's role.
 *
 * On a successful PIN check, /api/terminal/pin records a server-side
 * `terminal_staff_sessions` row and sets an httpOnly, HMAC-signed cookie
 * carrying (tenant, staff, device auth user, session id, expiry). A request
 * honours it only when ALL hold:
 *   - the signature and expiry verify;
 *   - the cookie's user id equals the CURRENT device login (getCurrentUser) —
 *     a cookie copied into another login's browser is useless;
 *   - the session row exists, matches, is unexpired and NOT revoked — switch-out
 *     (DELETE /api/terminal/pin) and sign-out revoke it server-side, so a copied
 *     cookie dies with them;
 *   - the staff member is still active in that tenant.
 *
 * Fallback: with no valid active-staff session, the device login's role is
 * used ONLY in the zero-env demo (mock driver, no real auth). In real mode a
 * sensitive action requires a PIN-switched staff member.
 */
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { getPosDriver, type MembershipRole, type Staff } from "@/lib/db";
import { isRealMode, signingSecret } from "./signing-secret";

export const ACTIVE_STAFF_COOKIE = "pos_active_staff";
/** Hard expiry (also enforced on the session row); browser-session cookie. */
const TTL_MS = 12 * 60 * 60 * 1000;

export interface ActiveStaffClaim {
  tenantId: string;
  staffId: string;
  userId: string;
  sessionId: string;
}

function mac(payload: string): string | null {
  const key = signingSecret();
  if (!key) return null;
  return createHmac("sha256", key)
    .update(`active-staff:v2:${payload}`)
    .digest("hex");
}

/** Signed cookie value for a claim; null if no secret (fail closed). */
export function signActiveStaff(
  claim: ActiveStaffClaim,
  expiresAtMs: number,
): string | null {
  const parts = [claim.tenantId, claim.staffId, claim.userId, claim.sessionId];
  if (parts.some((p) => !p || p.includes("."))) return null;
  const payload = `${parts.join(".")}.${expiresAtMs}`;
  const sig = mac(payload);
  return sig ? `${payload}.${sig}` : null;
}

/** Verify a cookie value's signature + expiry (no I/O). */
export function verifyActiveStaff(
  value: string | null | undefined,
  now = Date.now(),
): ActiveStaffClaim | null {
  if (!value) return null;
  const parts = value.split(".");
  if (parts.length !== 6) return null;
  const [tenantId, staffId, userId, sessionId, exp, sig] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  if (!tenantId || !staffId || !userId || !sessionId || !sig) return null;
  if (!(Number(exp) > now)) return null;
  const expected = mac(`${tenantId}.${staffId}.${userId}.${sessionId}.${exp}`);
  if (!expected) return null;
  const a = Buffer.from(expected, "hex");
  let b: Buffer;
  try {
    b = Buffer.from(sig, "hex");
  } catch {
    return null;
  }
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return { tenantId, staffId, userId, sessionId };
}

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) {
      try {
        return decodeURIComponent(part.slice(idx + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * Open a server-side staff session for (device user, tenant, staff) and return
 * the signed cookie value — or null when no signing secret (fail closed).
 */
export async function openStaffSession(input: {
  userId: string;
  tenantId: string;
  staffId: string;
}): Promise<string | null> {
  if (!signingSecret()) return null;
  const now = Date.now();
  const expiresAt = now + TTL_MS;
  const sessionId = randomUUID();
  await getPosDriver().createStaffSession({
    id: sessionId,
    user_id: input.userId,
    tenant_id: input.tenantId,
    staff_id: input.staffId,
    created_at: new Date(now).toISOString(),
    expires_at: new Date(expiresAt).toISOString(),
    revoked_at: null,
  });
  return signActiveStaff({ ...input, sessionId }, expiresAt);
}

/** Revoke the session named by the request's cookie (switch-out). */
export async function revokeRequestStaffSession(request: Request): Promise<void> {
  const claim = verifyActiveStaff(readCookie(request, ACTIVE_STAFF_COOKIE));
  if (claim) await getPosDriver().revokeStaffSession(claim.sessionId);
}

/**
 * The verified, still-active staff member switched in for `tenantId` on THIS
 * device login (`userId` = the current session's auth user id).
 */
export async function getActiveStaff(
  request: Request,
  tenantId: string,
  userId: string,
): Promise<Staff | null> {
  const claim = verifyActiveStaff(readCookie(request, ACTIVE_STAFF_COOKIE));
  if (!claim || claim.tenantId !== tenantId || claim.userId !== userId) {
    return null;
  }
  const driver = getPosDriver();
  const session = await driver.getStaffSession(claim.sessionId);
  if (
    !session ||
    session.revoked_at ||
    session.user_id !== userId ||
    session.tenant_id !== tenantId ||
    session.staff_id !== claim.staffId ||
    new Date(session.expires_at).getTime() <= Date.now()
  ) {
    return null;
  }
  const staff = await driver.getStaffById(tenantId, claim.staffId);
  return staff && staff.active ? staff : null;
}

/**
 * The role that authorizes a money-sensitive action at the terminal: the
 * active (PIN-switched) staff member's role; without one, the device role only
 * in the zero-env demo, else null (no authority).
 */
export async function effectiveTerminalRole(
  request: Request,
  auth: { tenantId: string; role: MembershipRole; user: { id: string } },
): Promise<{ role: MembershipRole | null; staff: Staff | null }> {
  const staff = await getActiveStaff(request, auth.tenantId, auth.user.id);
  if (staff) return { role: staff.role, staff };
  return { role: isRealMode() ? null : auth.role, staff: null };
}

/** Cookie attributes for the active-staff cookie (browser-session cookie). */
export function activeStaffCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
  };
}
