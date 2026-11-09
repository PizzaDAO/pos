/**
 * One staff-PIN attempt, server-side (server-only). Shared by the till's
 * quick-switch (/api/terminal/pin) and the back-office unlock
 * (/api/admin/unlock) so both enforce the same brute-force budget.
 *
 * Layers, outermost first (the per-IP rate limit runs in the route):
 *   1. per-DEVICE budget: the device login (auth user id) — a copied or cleared
 *      cookie can't reset it, because it is keyed on the signed-in account;
 *   2. per-LOCATION budget: the till's location (validated to belong to the
 *      staff member's tenant), or the tenant as a whole when none is named;
 *   3. the per-staff lockout (begin_pin_attempt: 5 → 15-minute lock).
 * Each layer counts the attempt under a row lock BEFORE the PIN is checked, so
 * concurrent guesses can't race past it. A verified PIN releases its own
 * device/location attempt (only unproven guesses spend those budgets; a cashier
 * can't refill them by also typing their own PIN, since that only un-counts
 * itself) and resets the staff counter.
 *
 * Answers: 401 "Incorrect PIN." for a wrong PIN / unknown or inactive staff
 * (no enumeration), 423 with `lockedUntil` when any layer is locked.
 */
import { NextResponse } from "next/server";
import { getPosDriver, type MembershipRole, type Staff } from "@/lib/db";
import { recordAudit } from "@/lib/security";
import { verifyPin } from "./pin";
import type { SessionUser } from "./session";

/** Unproven attempts per device login per window before a lock. */
export const PIN_DEVICE_LIMIT = { max: 10, windowMinutes: 15, lockMinutes: 15 };
/** Unproven attempts per location (all its tills) per window before a lock. */
export const PIN_LOCATION_LIMIT = {
  max: 30,
  windowMinutes: 15,
  lockMinutes: 15,
};

export type PinAttemptResult =
  | { ok: true; staff: Staff; locationId: string | null }
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

/** The location budget key: the till's location, or the whole tenant. */
export function locationKey(
  tenantId: string,
  locationId: string | null,
): string {
  return `${tenantId}:${locationId ?? "*"}`;
}

/**
 * Verify `pin` for staff `staffId` within `tenantIds` (the tenants the device
 * login may operate). `roles` (optional) restricts WHICH staff may use this
 * path — checked before any PIN is verified (roles are shown on the picker
 * anyway, so this reveals nothing and spends no budget).
 */
export async function attemptStaffPin(input: {
  user: SessionUser;
  tenantIds: string[];
  staffId: string;
  pin: string;
  locationId?: unknown;
  roles?: readonly MembershipRole[];
  /** Audit label for lock events, e.g. "Back-office unlock". */
  context: string;
}): Promise<PinAttemptResult> {
  const driver = getPosDriver();
  const { user } = input;

  // 1. Per device (the device login). Counted even for an unknown staff id.
  const device = await driver.beginPinLimitAttempt(
    "device",
    user.id,
    PIN_DEVICE_LIMIT,
  );
  if (!device.allowed) {
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

  // getStaffById carries pin_hash; it never goes to the client.
  let staff: Staff | null = null;
  for (const tenantId of input.tenantIds) {
    staff = await driver.getStaffById(tenantId, input.staffId);
    if (staff) break;
  }
  if (!staff || !staff.active) return incorrect();
  if (input.roles && !input.roles.includes(staff.role)) {
    await driver.releasePinLimitAttempt("device", user.id);
    return {
      ok: false,
      res: NextResponse.json(
        { error: "Only an owner or manager PIN can do this." },
        { status: 403 },
      ),
    };
  }

  // 2. Per location (validated to be one of the staff member's tenant).
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
  if (!location.allowed) {
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

  // 3. Per staff (persisted, atomic: begin_pin_attempt).
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

  if (!verifyPin(input.pin, staff.pin_hash)) return incorrect();

  // Proven: un-count this attempt from the device/location budgets, and reset
  // the staff counter (unless a concurrent burst set a lock meanwhile).
  await Promise.all([
    driver.releasePinLimitAttempt("device", user.id),
    driver.releasePinLimitAttempt("location", locKey),
    driver.clearPinAttempts(staff.tenant_id, staff.id),
  ]);
  return { ok: true, staff, locationId };
}
