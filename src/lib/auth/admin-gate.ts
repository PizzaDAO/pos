/**
 * Back-office PIN gate (server-only) — security audit M1.
 *
 * A till is often signed in with the OWNER's account, so the device session
 * alone says nothing about who is standing at it: a cashier could open /admin
 * and refund, reprice or close the day. Once the gate is in force, every /admin
 * page and every /api/admin/* route (plus the other admin-only APIs; see
 * ADMIN_GATED_ROUTES in admin-gate.test.ts) also needs a fresh OWNER or MANAGER
 * staff PIN:
 *
 *   POST /api/admin/unlock { tenantId, staffId, pin } verifies the PIN through
 *   the same budgets as the till (pin-attempt.ts) and opens a server-side
 *   session of kind 'admin' that lasts ADMIN_UNLOCK_TTL_MS (10 minutes, not
 *   extended: after that the UI re-prompts). It sets an httpOnly cookie signed
 *   under its own MAC domain ("admin-unlock:v1"), so the till cookie can't be
 *   used here and this one can't be used at the till.
 *
 * A request passes the gate only when ALL hold: the cookie's signature and
 * expiry verify; it names this tenant and THIS device login; the session row
 * exists, is kind 'admin', unexpired and not revoked; and the staff member is
 * still active and still an owner or manager — so demoting or deactivating
 * someone ends their unlock at once. What revokes it: "Lock now" (DELETE
 * /api/admin/unlock), a till switch-in or switch-out on this browser (POST /
 * DELETE /api/terminal/pin), account sign-out (/auth/signout revokes every
 * session of the login), and a role change, deactivation or PIN reset of the
 * staff member (incl. a hub PIN change through /v1).
 *
 * When is the gate in force? In real mode, as soon as the tenant has an ACTIVE
 * owner/manager staff member with a PIN. Before that (a new tenant, or the
 * zero-env demo) the device session's owner/manager role is used as before.
 * Bootstrap (src/lib/staff/manage.ts#checkPinIssue): the first gating PIN
 * must be an OWNER's and needs a recent account sign-in; and an owner device
 * session may always give an owner staff row with no PIN its first PIN
 * (/api/admin/owner-pin), so an owner can never be locked out by the gate.
 *
 * The acting role inside admin (e.g. managers can't create owners) is the PIN
 * staff member's role when the gate is in force, else the device login's role.
 */
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { getPosDriver, type MembershipRole, type Staff } from "@/lib/db";
import { readCookie, signActiveStaff, verifyActiveStaff } from "./active-staff";
import { isRealMode, signingSecret } from "./signing-secret";
import { requireTenantRole } from "./api";
import type { SessionUser } from "./session";
import {
  requireTenantAccess,
  sessionRoleIn,
  type GuardFailure,
  type TenantGrant,
} from "./tenant-guard";

export const ADMIN_UNLOCK_COOKIE = "pos_admin_unlock";
/** How long one PIN unlock lasts (absolute; then re-prompt). */
export const ADMIN_UNLOCK_TTL_MS = 10 * 60 * 1000;
/** Staff roles whose PIN unlocks the back office. */
export const ADMIN_PIN_ROLES: readonly MembershipRole[] = ["owner", "manager"];
/** Machine-readable code on a gate refusal (the UI re-prompts on it). */
export const ADMIN_PIN_REQUIRED = "admin_pin_required";

const PURPOSE = "admin-unlock:v1";

/** Who is acting inside the back office. */
export interface AdminActor {
  /** Acting role: the PIN staff member's when gated, else the device role. */
  role: MembershipRole | null;
  /** The PIN-verified staff member (gated), else null. */
  staff: Staff | null;
  /** Whether the PIN gate is in force for this tenant. */
  gated: boolean;
  /** When the current unlock ends (gated), else null. */
  expiresAt: string | null;
}

/**
 * Did this login session sign in recently (RECENT_SIGN_IN_MS)? Always true
 * outside real mode (no real sign-in to check).
 */
export function recentlySignedIn(
  user: Pick<SessionUser, "authAt">,
  windowMs = 10 * 60 * 1000,
): boolean {
  if (!isRealMode()) return true;
  return typeof user.authAt === "number" && Date.now() - user.authAt <= windowMs;
}

/** Is the PIN gate in force for this tenant (see the module comment)? */
export async function adminGateRequired(tenantId: string): Promise<boolean> {
  if (!isRealMode()) return false;
  const driver = getPosDriver();
  const [staff, withPin] = await Promise.all([
    driver.listStaff(tenantId),
    driver.listStaffWithPin(tenantId),
  ]);
  return staff.some(
    (s) => s.active && ADMIN_PIN_ROLES.includes(s.role) && withPin.has(s.id),
  );
}

/**
 * The live unlock named by `cookieValue` for (tenant, device user), or null.
 * No side effects.
 */
export async function resolveAdminUnlock(
  cookieValue: string | null | undefined,
  tenantId: string,
  userId: string,
): Promise<{ staff: Staff; expiresAt: string; sessionId: string } | null> {
  const claim = verifyActiveStaff(cookieValue, Date.now(), PURPOSE);
  if (!claim || claim.tenantId !== tenantId || claim.userId !== userId) {
    return null;
  }
  const driver = getPosDriver();
  const session = await driver.getStaffSession(claim.sessionId);
  if (
    !session ||
    session.kind !== "admin" ||
    session.revoked_at ||
    session.user_id !== userId ||
    session.tenant_id !== tenantId ||
    session.staff_id !== claim.staffId ||
    new Date(session.expires_at).getTime() <= Date.now()
  ) {
    return null;
  }
  const staff = await driver.getStaffById(tenantId, session.staff_id);
  if (!staff || !staff.active || !ADMIN_PIN_ROLES.includes(staff.role)) {
    return null;
  }
  return {
    staff: {
      ...staff,
      pin_hash: undefined,
      pin_previous_hash: undefined,
      pin_previous_until: undefined,
    },
    expiresAt: session.expires_at,
    sessionId: session.id,
  };
}

function pinRequired(): GuardFailure {
  return {
    ok: false,
    res: NextResponse.json(
      {
        error: "Enter an owner or manager PIN to use the back office.",
        code: ADMIN_PIN_REQUIRED,
      },
      { status: 403 },
    ),
  };
}

/**
 * The gate itself, for a caller that has ALREADY authorized the device session
 * as owner|manager of `tenantId` (whatever guard the route uses).
 */
export async function adminGate(
  request: Request,
  tenantId: string,
  userId: string,
  deviceRole: MembershipRole | null,
): Promise<{ ok: true; actor: AdminActor } | GuardFailure> {
  if (!(await adminGateRequired(tenantId))) {
    return {
      ok: true,
      actor: { role: deviceRole, staff: null, gated: false, expiresAt: null },
    };
  }
  const unlock = await resolveAdminUnlock(
    readCookie(request, ADMIN_UNLOCK_COOKIE),
    tenantId,
    userId,
  );
  if (!unlock) return pinRequired();
  return {
    ok: true,
    actor: {
      role: unlock.staff.role,
      staff: unlock.staff,
      gated: true,
      expiresAt: unlock.expiresAt,
    },
  };
}

/**
 * The one call an admin route makes: owner|manager device session of the
 * tenant (requireTenantAccess "admin") AND the PIN gate.
 */
export async function requireAdminAccess(
  request: Request,
  tenantId: string | null | undefined,
  opts?: { locationId?: string | null; requireLocation?: boolean },
): Promise<(TenantGrant & { actor: AdminActor }) | GuardFailure> {
  const auth = await requireTenantAccess(tenantId, "admin", opts);
  if (!auth.ok) return auth;
  const gate = await adminGate(request, auth.tenantId, auth.user.id, auth.role);
  if (!gate.ok) return gate;
  return { ...auth, actor: gate.actor };
}

/**
 * Same, for routes authorized with the legacy `requireTenantRole` (late
 * payments, card readers): `roles` on the device session AND the PIN gate.
 */
export async function requireAdminRole(
  request: Request,
  tenantId: string,
  roles: readonly MembershipRole[] = ADMIN_PIN_ROLES,
): Promise<{ ok: true; user: SessionUser; actor: AdminActor } | GuardFailure> {
  const auth = await requireTenantRole(tenantId, [...roles]);
  if (!auth.ok) return auth;
  const gate = await adminGate(
    request,
    tenantId,
    auth.user.id,
    sessionRoleIn(auth.user, tenantId),
  );
  if (!gate.ok) return gate;
  return { ok: true, user: auth.user, actor: gate.actor };
}

/**
 * Open a back-office unlock for (device user, tenant, staff): a server-side
 * session of kind 'admin' + the signed cookie value. null when no signing
 * secret (fail closed).
 */
export async function openAdminUnlock(input: {
  userId: string;
  tenantId: string;
  staffId: string;
}): Promise<{ cookie: string; expiresAt: string; sessionId: string } | null> {
  if (!signingSecret()) return null;
  const now = Date.now();
  const expiresAtMs = now + ADMIN_UNLOCK_TTL_MS;
  const sessionId = randomUUID();
  const expiresAt = new Date(expiresAtMs).toISOString();
  await getPosDriver().createStaffSession({
    id: sessionId,
    user_id: input.userId,
    tenant_id: input.tenantId,
    staff_id: input.staffId,
    created_at: new Date(now).toISOString(),
    expires_at: expiresAt,
    revoked_at: null,
    kind: "admin",
  });
  const cookie = signActiveStaff({ ...input, sessionId }, expiresAtMs, PURPOSE);
  return cookie ? { cookie, expiresAt, sessionId } : null;
}

/** Revoke the unlock named by the request's cookie (Lock / switch-out). */
export async function revokeAdminUnlock(request: Request): Promise<void> {
  const claim = verifyActiveStaff(
    readCookie(request, ADMIN_UNLOCK_COOKIE),
    Date.now(),
    PURPOSE,
  );
  if (claim) await getPosDriver().revokeStaffSession(claim.sessionId);
}

/** Cookie attributes: httpOnly, lax (the Stripe return is a top-level nav), expires with the unlock. */
export function adminUnlockCookieOptions(expiresAt?: string) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    ...(expiresAt ? { expires: new Date(expiresAt) } : {}),
  };
}
