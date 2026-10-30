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
 * used ONLY when the tenant has not set up staff PINs (no active staff with a
 * PIN) or in the zero-env demo. Once PINs are in use, a sensitive action
 * requires a PIN-switched staff member.
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
 * the signed cookie value + the session id — or null when no signing secret
 * (fail closed). The session id is handed to the terminal so an order queued
 * offline can name the session it was queued under (see effectiveTerminalRole).
 */
export async function openStaffSession(input: {
  userId: string;
  tenantId: string;
  staffId: string;
}): Promise<{ cookie: string; sessionId: string } | null> {
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
  const cookie = signActiveStaff({ ...input, sessionId }, expiresAt);
  return cookie ? { cookie, sessionId } : null;
}

/** Revoke the session named by the request's cookie (switch-out). */
export async function revokeRequestStaffSession(request: Request): Promise<void> {
  const claim = verifyActiveStaff(readCookie(request, ACTIVE_STAFF_COOKIE));
  if (claim) await getPosDriver().revokeStaffSession(claim.sessionId);
}

/**
 * The staff member of a LIVE session row: exists, belongs to `tenantId` and to
 * THIS device login (`userId`), unexpired, not revoked, staff still active (and
 * equal to `staffId` when given).
 */
async function liveSessionStaff(
  sessionId: string,
  expected: { tenantId: string; userId: string; staffId?: string },
): Promise<Staff | null> {
  const driver = getPosDriver();
  const session = await driver.getStaffSession(sessionId);
  if (
    !session ||
    session.revoked_at ||
    session.user_id !== expected.userId ||
    session.tenant_id !== expected.tenantId ||
    (expected.staffId !== undefined && session.staff_id !== expected.staffId) ||
    new Date(session.expires_at).getTime() <= Date.now()
  ) {
    return null;
  }
  const staff = await driver.getStaffById(expected.tenantId, session.staff_id);
  return staff && staff.active ? staff : null;
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
  return liveSessionStaff(claim.sessionId, {
    tenantId,
    userId,
    staffId: claim.staffId,
  });
}

/**
 * Must money-sensitive terminal actions come from a PIN-switched staff member?
 * Yes in real mode once the tenant has set up PINs (an active staff member with
 * a PIN). A tenant that never set up PINs keeps using the device login's role,
 * as does the zero-env demo.
 */
export async function requiresPinStaff(tenantId: string): Promise<boolean> {
  if (!isRealMode()) return false;
  return getPosDriver().tenantHasStaffPins(tenantId);
}

/**
 * The role that authorizes a money-sensitive action at the terminal:
 *   1. the active (PIN-switched) staff member named by the signed cookie;
 *   2. else, for an order queued offline, the staff session that was active
 *      when it was queued (`queuedSessionId`) — honoured ONLY while that
 *      session is STILL live for this device login (see below);
 *   3. else the device login's role, but only when PINs aren't in use for the
 *      tenant (requiresPinStaff false);
 *   4. else null (no authority).
 *
 * Why "still live" and not "was valid at queue time": the queue time is
 * asserted by the client, so a cashier could backdate it to before a
 * manager's switch-out and replay the manager's session id — defeating
 * revocation. A still-live session id only helps the device that opened it
 * (it is bound to the device login's user id), and switching staff or signing
 * out revokes it; it covers the real offline case where the browser-session
 * cookie was lost (terminal restarted) while the session itself is valid. A
 * queued discount whose session is gone is refused (403) and the terminal asks
 * staff to re-authorize or re-place it without the discount — it is never lost.
 */
export async function effectiveTerminalRole(
  request: Request,
  auth: { tenantId: string; role: MembershipRole; user: { id: string } },
  opts: { queuedSessionId?: string | null } = {},
): Promise<{ role: MembershipRole | null; staff: Staff | null }> {
  const staff = await getActiveStaff(request, auth.tenantId, auth.user.id);
  if (staff) return { role: staff.role, staff };
  if (opts.queuedSessionId) {
    const queued = await liveSessionStaff(opts.queuedSessionId, {
      tenantId: auth.tenantId,
      userId: auth.user.id,
    });
    if (queued) return { role: queued.role, staff: queued };
  }
  if (!(await requiresPinStaff(auth.tenantId))) {
    return { role: auth.role, staff: null };
  }
  return { role: null, staff: null };
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
