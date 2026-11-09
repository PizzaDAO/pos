/**
 * One staff-PIN attempt, server-side (server-only). Shared by the till's
 * quick-switch (/api/terminal/pin) and the back-office unlock
 * (/api/admin/unlock) so both enforce the same brute-force budget.
 *
 * Layers (the per-IP rate limit runs in the route):
 *   1. the per-STAFF lockout (begin_pin_attempt: 5 → 15-minute lock) — the main
 *      limit: a PIN is guessed for one person, and that person locks;
 *   2. per-DEVICE budget: this browser (a random, signed, httpOnly `pos_device`
 *      id, handed out on the first SUCCESSFUL PIN) under this device login.
 *      Every till of a shop is usually signed in as the owner, so the login
 *      alone can't be the key: one till's bad guesses would lock PIN entry on
 *      every till. A browser with no valid id gets its own SMALL budget keyed
 *      on its IP + the login, so guesses elsewhere never block a fresh till.
 *      This budget only slows one browser down: someone who clears the cookie
 *      and then enters a PIN they know (their own) does get a fresh device
 *      budget. The real limits are the per-staff lockout (layer 1) and the
 *      per-location budget (layer 3);
 *   3. per-LOCATION budget: the till's location (validated to belong to the
 *      staff member's tenant), or the tenant as a whole when none is named. Set
 *      high: it is a backstop against spraying guesses over many staff, not a
 *      way for one till to lock a whole shop.
 * Each layer counts the attempt under a row lock BEFORE the PIN is checked, so
 * concurrent guesses can't race past it. A verified PIN releases its own
 * device/location attempt (only unproven guesses spend those budgets; a cashier
 * can't refill them by also typing their own PIN, since that only un-counts
 * itself) and resets the staff counter.
 *
 * `ownerBypass` (the back-office unlock): an OWNER is never kept out of admin
 * by the device or location budget — only by their own per-staff lockout — so
 * a flood of bad guesses at a till can't lock the owner out of fixing it.
 *
 * Answers: 401 "Incorrect PIN." for a wrong PIN / unknown or inactive staff
 * (no enumeration), 423 with `lockedUntil` when a layer is locked.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { getPosDriver, type MembershipRole, type Staff } from "@/lib/db";
import { clientIp, recordAudit } from "@/lib/security";
import { readCookie } from "./active-staff";
import { matchStaffPin } from "./pin";
import type { SessionUser } from "./session";
import { signingSecret } from "./signing-secret";

/** Unproven attempts per browser (per device login) per window before a lock. */
export const PIN_DEVICE_LIMIT = { max: 10, windowMinutes: 15, lockMinutes: 15 };
/** The smaller budget of a browser with no device id yet (per IP + login). */
export const PIN_UNIDENTIFIED_LIMIT = {
  max: 5,
  windowMinutes: 15,
  lockMinutes: 15,
};
/** Unproven attempts per location (all its tills) per window before a lock. */
export const PIN_LOCATION_LIMIT = {
  max: 100,
  windowMinutes: 15,
  lockMinutes: 15,
};

/** The per-browser device id cookie (random id + HMAC). */
export const DEVICE_COOKIE = "pos_device";
const DEVICE_PURPOSE = "device:v1";

function deviceMac(id: string): string | null {
  const key = signingSecret();
  if (!key) return null;
  return createHmac("sha256", key)
    .update(`${DEVICE_PURPOSE}:${id}`)
    .digest("hex");
}

/** A new signed device id cookie value, or null with no signing secret. */
export function mintDeviceCookie(): string | null {
  const id = randomBytes(16).toString("hex");
  const sig = deviceMac(id);
  return sig ? `${id}.${sig}` : null;
}

/** The verified device id of this browser, or null (absent / forged). */
export function readDeviceId(request: Request): string | null {
  const value = readCookie(request, DEVICE_COOKIE);
  if (!value) return null;
  const [id, sig] = value.split(".");
  if (!id || !sig || !/^[0-9a-f]{32}$/.test(id)) return null;
  const expected = deviceMac(id);
  if (!expected) return null;
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(sig, "hex");
  return a.length === b.length && timingSafeEqual(a, b) ? id : null;
}

/** Long-lived, httpOnly: identifies the browser, carries no authority. */
export function deviceCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 365 * 24 * 60 * 60,
  };
}

/**
 * The device budget key: this browser under this login, or — for a browser
 * with no device id yet — its IP under this login.
 */
export function deviceKey(
  userId: string,
  deviceId: string | null,
  ip: string,
): string {
  return deviceId ? `${userId}:${deviceId}` : `${userId}:ip:${ip}`;
}

/** The location budget key: the till's location, or the whole tenant. */
export function locationKey(
  tenantId: string,
  locationId: string | null,
): string {
  return `${tenantId}:${locationId ?? "*"}`;
}

export type PinAttemptResult =
  | {
      ok: true;
      staff: Staff;
      locationId: string | null;
      /** The PIN matched was a replaced short PIN still in its grace window. */
      usedPreviousPin: boolean;
      /** Set this `pos_device` cookie value (the browser had no valid id). */
      newDeviceCookie: string | null;
    }
  | { ok: false; res: NextResponse };

const incorrect = (): PinAttemptResult => ({
  ok: false,
  res: NextResponse.json({ error: "Incorrect PIN." }, { status: 401 }),
});

const locked = (lockedUntil: string | null): PinAttemptResult => ({
  ok: false,
  res: NextResponse.json(
    { error: "Too many incorrect PINs. Try again later.", lockedUntil },
    { status: 423 },
  ),
});

/**
 * Verify `pin` for staff `staffId` within `tenantIds` (the tenants the device
 * login may operate). `roles` (optional) restricts WHICH staff may use this
 * path — checked before any PIN is verified (roles are shown on the picker
 * anyway, so this reveals nothing and spends no budget).
 */
export async function attemptStaffPin(input: {
  request: Request;
  user: SessionUser;
  tenantIds: string[];
  staffId: string;
  pin: string;
  locationId?: unknown;
  roles?: readonly MembershipRole[];
  /** Owners skip the device/location budgets (back-office unlock only). */
  ownerBypass?: boolean;
  /** Audit label for lock events, e.g. "Back-office unlock". */
  context: string;
}): Promise<PinAttemptResult> {
  const driver = getPosDriver();
  const { user } = input;
  const deviceId = readDeviceId(input.request);
  const devKey = deviceKey(user.id, deviceId, clientIp(input.request.headers));

  // Device budget first, so guesses at unknown staff ids are counted too.
  const device = await driver.beginPinLimitAttempt(
    "device",
    devKey,
    deviceId ? PIN_DEVICE_LIMIT : PIN_UNIDENTIFIED_LIMIT,
  );

  // getStaffById carries pin_hash; it never goes to the client.
  let staff: Staff | null = null;
  for (const tenantId of input.tenantIds) {
    staff = await driver.getStaffById(tenantId, input.staffId);
    if (staff) break;
  }
  const bypass =
    !!input.ownerBypass && !!staff?.active && staff.role === "owner";

  if (!device.allowed && !bypass) {
    if (device.justLocked && input.tenantIds[0]) {
      await recordAudit({
        actor: { id: user.id, label: user.email },
        action: "staff_pin_switch",
        tenantId: input.tenantIds[0],
        detail: `${input.context}: PIN entry locked on this device after repeated failures (until ${device.lockedUntil}).`,
      });
    }
    return locked(device.lockedUntil);
  }
  if (!staff || !staff.active) return incorrect();
  if (input.roles && !input.roles.includes(staff.role)) {
    if (device.allowed) await driver.releasePinLimitAttempt("device", devKey);
    return {
      ok: false,
      res: NextResponse.json(
        { error: "Only an owner or manager PIN can do this." },
        { status: 403 },
      ),
    };
  }

  // Per location (validated to be one of the staff member's tenant).
  let locationId: string | null = null;
  if (typeof input.locationId === "string" && input.locationId) {
    const locations = await driver.listLocations(staff.tenant_id);
    if (locations.some((l) => l.id === input.locationId)) {
      locationId = input.locationId;
    }
  }
  const locKey = locationKey(staff.tenant_id, locationId);
  const location = await driver.beginPinLimitAttempt(
    "location",
    locKey,
    PIN_LOCATION_LIMIT,
  );
  if (!location.allowed && !bypass) {
    if (location.justLocked) {
      await recordAudit({
        actor: { id: user.id, label: user.email },
        action: "staff_pin_switch",
        tenantId: staff.tenant_id,
        detail: `${input.context}: PIN entry locked for ${locationId ? `location ${locationId}` : "the business"} after repeated failures (until ${location.lockedUntil}).`,
      });
    }
    return locked(location.lockedUntil);
  }

  // Per staff (persisted, atomic: begin_pin_attempt) — never bypassed.
  const attemptState = await driver.beginPinAttempt(staff.tenant_id, staff.id);
  if (!attemptState.allowed) {
    if (attemptState.justLocked) {
      await recordAudit({
        actor: { id: user.id, label: user.email },
        action: "staff_pin_switch",
        tenantId: staff.tenant_id,
        detail: `PIN locked for ${staff.name} after repeated failures (until ${attemptState.lockedUntil}).`,
      });
    }
    return locked(attemptState.lockedUntil);
  }

  const matched = matchStaffPin(input.pin, staff);
  if (!matched) return incorrect();

  // Proven: un-count this attempt from the device/location budgets (a no-op
  // on a locked bucket), and reset the staff counter (unless a concurrent
  // burst set a lock meanwhile).
  await Promise.all([
    driver.releasePinLimitAttempt("device", devKey),
    driver.releasePinLimitAttempt("location", locKey),
    driver.clearPinAttempts(staff.tenant_id, staff.id),
    // The new PIN works: a replaced short PIN's grace ends now.
    matched === "current" && staff.pin_previous_hash
      ? driver.clearPreviousPin(staff.tenant_id, staff.id)
      : Promise.resolve(),
  ]);
  return {
    ok: true,
    staff,
    usedPreviousPin: matched === "previous",
    locationId,
    // First proven PIN on this browser: give it its own device budget.
    newDeviceCookie: deviceId ? null : mintDeviceCookie(),
  };
}
