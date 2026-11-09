/**
 * Back-office PIN unlock — /api/admin/unlock (security audit M1).
 *
 * The ONE /api/admin route that is not behind the PIN gate: it is how the gate
 * is passed. It still requires an owner|manager device session of the tenant.
 *
 * GET    ?tenantId=  → { required, unlocked, staff, expiresAt }: is the gate in
 *        force, and who (if anyone) has unlocked this device for the tenant.
 * POST   { tenantId, staffId, pin, locationId? } → verify an OWNER or MANAGER
 *        PIN (same device / location / per-staff budgets as the till; see
 *        src/lib/auth/pin-attempt.ts) and open a 10-minute unlock: a server-side
 *        session of kind 'admin' + an httpOnly signed cookie. 401 wrong PIN,
 *        403 not an owner/manager, 423 locked. An OWNER is never kept out by
 *        the device/location budgets, only by their own per-staff lockout.
 *        An owner/manager PIN shorter than 6 digits is replaced first: the
 *        server issues a new 6-digit PIN, returned ONCE as `newPin`.
 * DELETE ?tenantId= → Lock: revoke the unlock and clear the cookie.
 *
 * See src/lib/auth/admin-gate.ts. No env vars required (mock driver).
 */
import { NextResponse } from "next/server";
import { requireTenantAccess } from "@/lib/auth/tenant-guard";
import { isValidPinFormat } from "@/lib/auth/pin";
import {
  DEVICE_COOKIE,
  attemptStaffPin,
  deviceCookieOptions,
} from "@/lib/auth/pin-attempt";
import { getPosDriver } from "@/lib/db";
import { ISSUED_PIN_LENGTH, issueStaffPin } from "@/lib/staff/manage";
import { readCookie } from "@/lib/auth/active-staff";
import {
  ADMIN_PIN_ROLES,
  ADMIN_UNLOCK_COOKIE,
  ADMIN_UNLOCK_TTL_MS,
  adminGateRequired,
  adminUnlockCookieOptions,
  openAdminUnlock,
  resolveAdminUnlock,
  revokeAdminUnlock,
} from "@/lib/auth/admin-gate";
import { enforceRateLimit, readJsonBody, recordAudit } from "@/lib/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const auth = await requireTenantAccess(searchParams.get("tenantId"), "admin");
  if (!auth.ok) return auth.res;
  const [required, unlock] = await Promise.all([
    adminGateRequired(auth.tenantId),
    resolveAdminUnlock(
      readCookie(request, ADMIN_UNLOCK_COOKIE),
      auth.tenantId,
      auth.user.id,
    ),
  ]);
  return NextResponse.json(
    {
      required,
      unlocked: !required || !!unlock,
      staff: unlock
        ? {
            id: unlock.staff.id,
            name: unlock.staff.name,
            role: unlock.staff.role,
          }
        : null,
      expiresAt: unlock?.expiresAt ?? null,
      ttlMs: ADMIN_UNLOCK_TTL_MS,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(request: Request) {
  const limited = enforceRateLimit(request, "pin");
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
    "admin",
  );
  if (!auth.ok) return auth.res;
  if (typeof b.staffId !== "string" || !isValidPinFormat(b.pin)) {
    return NextResponse.json({ error: "Incorrect PIN." }, { status: 401 });
  }

  const attempt = await attemptStaffPin({
    request,
    user: auth.user,
    tenantIds: [auth.tenantId],
    staffId: b.staffId,
    pin: b.pin,
    locationId: b.locationId,
    roles: ADMIN_PIN_ROLES,
    ownerBypass: true,
    context: "Back-office unlock",
  });
  if (!attempt.ok) return attempt.res;
  const staff = attempt.staff;

  // A short owner/manager PIN guards the whole back office: replace it with a
  // server-issued 6-digit one before unlocking (shown once, below).
  let newPin: string | null = null;
  if (b.pin.length < ISSUED_PIN_LENGTH) {
    newPin = await issueStaffPin(auth.tenantId, staff.id);
    if (!newPin) {
      return NextResponse.json({ error: "Staff not found." }, { status: 404 });
    }
    // The old PIN's till sessions end with it.
    await getPosDriver().revokeStaffSessionsForStaff(auth.tenantId, staff.id);
    await recordAudit({
      actor: {
        id: auth.user.id,
        label: `${auth.user.email} (PIN: ${staff.name})`,
      },
      action: "staff_pin_reset",
      tenantId: auth.tenantId,
      detail: `Replaced the short PIN of staff ${staff.id} "${staff.name}" with a 6-digit PIN at back-office unlock.`,
    });
  }

  // One unlock per device: replace any previous one.
  await revokeAdminUnlock(request);
  const opened = await openAdminUnlock({
    userId: auth.user.id,
    tenantId: auth.tenantId,
    staffId: staff.id,
  });
  if (!opened) {
    return NextResponse.json(
      { error: "The back-office lock is unavailable (server not configured)." },
      { status: 503 },
    );
  }
  await recordAudit({
    actor: { id: auth.user.id, label: auth.user.email },
    action: "admin_unlock",
    tenantId: auth.tenantId,
    detail: `Back office unlocked by ${staff.name} (${staff.role}) until ${opened.expiresAt}.`,
  });

  const res = NextResponse.json(
    {
      staff: { id: staff.id, name: staff.name, role: staff.role },
      expiresAt: opened.expiresAt,
      ...(newPin ? { newPin } : {}),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
  if (attempt.newDeviceCookie) {
    res.cookies.set(
      DEVICE_COOKIE,
      attempt.newDeviceCookie,
      deviceCookieOptions(),
    );
  }
  res.cookies.set(
    ADMIN_UNLOCK_COOKIE,
    opened.cookie,
    adminUnlockCookieOptions(opened.expiresAt),
  );
  return res;
}

export async function DELETE(request: Request) {
  await revokeAdminUnlock(request);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(ADMIN_UNLOCK_COOKIE, "", {
    ...adminUnlockCookieOptions(),
    maxAge: 0,
  });
  return res;
}
