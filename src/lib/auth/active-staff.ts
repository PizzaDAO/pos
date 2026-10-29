/**
 * Server-verified ACTIVE STAFF on a shared terminal (server-only).
 *
 * The terminal device is logged in by one user (often the owner), while the
 * person at the till switches in by PIN. Money-sensitive actions (discounts,
 * refunds, voids) must be authorized by the ACTIVE staff member's role, not the
 * device login's role — otherwise a cashier on an owner-logged-in device could
 * discount or refund freely.
 *
 * On a successful PIN check, /api/terminal/pin sets an httpOnly, HMAC-signed
 * session cookie binding (tenant, staff, expiry). Routes read it back here and
 * re-load the staff row (must still be active, same tenant). The client's
 * `staff_id` / sessionStorage copy is never trusted for authorization.
 *
 * Fallback: with no active-staff cookie, the device login's role is used ONLY
 * in the zero-env demo (mock driver, no real auth). In real mode a sensitive
 * action requires a PIN-switched staff member.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { getPosDriver, type MembershipRole, type Staff } from "@/lib/db";
import { isRealMode, signingSecret } from "./signing-secret";

export const ACTIVE_STAFF_COOKIE = "pos_active_staff";
/** Hard expiry inside the cookie (it is also a browser-session cookie). */
const TTL_MS = 12 * 60 * 60 * 1000;

function mac(payload: string): string | null {
  const key = signingSecret();
  if (!key) return null;
  return createHmac("sha256", key)
    .update(`active-staff:v1:${payload}`)
    .digest("hex");
}

/** Signed cookie value for (tenant, staff); null if no secret (fail closed). */
export function signActiveStaff(
  tenantId: string,
  staffId: string,
  now = Date.now(),
): string | null {
  const payload = `${tenantId}.${staffId}.${now + TTL_MS}`;
  const sig = mac(payload);
  return sig ? `${payload}.${sig}` : null;
}

/** Verify a cookie value → { tenantId, staffId } or null. Pure aside from secret. */
export function verifyActiveStaff(
  value: string | null | undefined,
  now = Date.now(),
): { tenantId: string; staffId: string } | null {
  if (!value) return null;
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const [tenantId, staffId, exp, sig] = parts as [string, string, string, string];
  if (!tenantId || !staffId || !sig) return null;
  if (!(Number(exp) > now)) return null;
  const expected = mac(`${tenantId}.${staffId}.${exp}`);
  if (!expected) return null;
  const a = Buffer.from(expected, "hex");
  let b: Buffer;
  try {
    b = Buffer.from(sig, "hex");
  } catch {
    return null;
  }
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return { tenantId, staffId };
}

function readCookie(request: Request, name: string): string | null {
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

/** The verified, still-active staff member switched in for `tenantId`. */
export async function getActiveStaff(
  request: Request,
  tenantId: string,
): Promise<Staff | null> {
  const claim = verifyActiveStaff(readCookie(request, ACTIVE_STAFF_COOKIE));
  if (!claim || claim.tenantId !== tenantId) return null;
  const staff = await getPosDriver().getStaffById(tenantId, claim.staffId);
  return staff && staff.active ? staff : null;
}

/**
 * The role that authorizes a money-sensitive action at the terminal: the
 * active (PIN-switched) staff member's role; without one, the device role only
 * in the zero-env demo, else null (no authority).
 */
export async function effectiveTerminalRole(
  request: Request,
  tenantId: string,
  deviceRole: MembershipRole,
): Promise<{ role: MembershipRole | null; staff: Staff | null }> {
  const staff = await getActiveStaff(request, tenantId);
  if (staff) return { role: staff.role, staff };
  return { role: isRealMode() ? null : deviceRole, staff: null };
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
