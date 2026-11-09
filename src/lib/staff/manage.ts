/**
 * Staff management rules + PIN issuing (server-only) for Admin > Staff.
 *
 * Rules (enforced by /api/admin/staff, tested in manage.test.ts):
 *   - only an owner or manager manages staff (the ACTING role: the PIN staff
 *     member's when the back-office gate is in force, see admin-gate.ts);
 *   - a manager can't create an owner, promote anyone to owner, or change
 *     anything about an existing owner (role, details, deactivation, PIN);
 *   - nobody can demote or deactivate the LAST active owner;
 *   - staff are never hard-deleted (orders, shifts and payments reference
 *     them): "remove" is deactivate, which also ends their sessions.
 *
 * PINs are ISSUED by the server, never chosen: a chosen PIN that collides would
 * have to be refused, and that refusal tells a manager "someone here uses this
 * PIN" — an oracle for an owner's PIN. A random 6-digit PIN is generated,
 * checked unique across the TENANT (every staff member with a PIN, active or
 * not, so moving someone to another location or reactivating them can never
 * create a clash; tenant-wide implies the per-location uniqueness that a
 * PIN-only login needs), hashed with the till's scrypt, and shown ONCE.
 */
import { randomInt, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { getPosDriver, type MembershipRole, type Staff } from "@/lib/db";
import { hashPin } from "@/lib/auth/pin";

export const STAFF_ROLES: readonly MembershipRole[] = [
  "owner",
  "manager",
  "cashier",
  "kitchen",
];

export function isStaffRole(v: unknown): v is MembershipRole {
  return (
    typeof v === "string" && (STAFF_ROLES as readonly string[]).includes(v)
  );
}

/** The change being asked for, as far as the rules care. */
export type StaffChange =
  | { kind: "create"; role: MembershipRole }
  | {
      kind: "update";
      target: Pick<Staff, "role" | "active">;
      next: { role?: MembershipRole; active?: boolean };
    }
  | { kind: "resetPin"; target: Pick<Staff, "role" | "active"> };

/**
 * null when `actorRole` may make `change`; otherwise the refusal message.
 * `activeOwners` = how many ACTIVE owner staff the tenant has right now.
 */
export function checkStaffChange(
  actorRole: MembershipRole | null,
  change: StaffChange,
  activeOwners: number,
): string | null {
  if (actorRole !== "owner" && actorRole !== "manager") {
    return "Only an owner or manager can manage staff.";
  }
  const manager = actorRole === "manager";
  if (change.kind === "create") {
    if (manager && change.role === "owner")
      return "Only an owner can add an owner.";
    return null;
  }
  if (manager && change.target.role === "owner") {
    return "Only an owner can change an owner.";
  }
  if (change.kind === "resetPin") {
    if (!change.target.active) return "Reactivate this staff member first.";
    return null;
  }
  const { target, next } = change;
  if (manager && next.role === "owner")
    return "Only an owner can make someone an owner.";
  const losesOwner =
    target.role === "owner" &&
    target.active &&
    ((next.role !== undefined && next.role !== "owner") ||
      next.active === false);
  if (losesOwner && activeOwners <= 1) {
    return "This is the last owner. Make someone else an owner first.";
  }
  return null;
}

// ---- contact fields ------------------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Trimmed email (≤254), null for blank; `false` when malformed. */
export function cleanEmail(v: unknown): string | null | false {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") return false;
  const t = v.trim();
  if (!t) return null;
  return t.length <= 254 && EMAIL_RE.test(t) ? t.toLowerCase() : false;
}

/** Trimmed phone (digits, spaces, + - ( ) . ; ≥7 digits, ≤32 chars), null for blank; `false` when malformed. */
export function cleanPhone(v: unknown): string | null | false {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") return false;
  const t = v.trim();
  if (!t) return null;
  return /^[0-9+().\s-]{7,32}$/.test(t) && t.replace(/\D/g, "").length >= 7
    ? t
    : false;
}

/** Trimmed display name, 1–80 chars; `false` when invalid. */
export function cleanName(v: unknown): string | false {
  if (typeof v !== "string") return false;
  const t = v.trim().replace(/\s+/g, " ");
  return t.length >= 1 && t.length <= 80 ? t : false;
}

// ---- PIN issuing -----------------------------------------------------------------

export const ISSUED_PIN_LENGTH = 6;

/** Obvious PINs we never issue: one repeated digit, or a straight run. */
export function isWeakPin(pin: string): boolean {
  if (/^(\d)\1+$/.test(pin)) return true;
  const d = [...pin].map(Number);
  const step = (d[1] ?? 0) - (d[0] ?? 0);
  if (Math.abs(step) !== 1) return false;
  return d.every((v, i) => i === 0 || v - (d[i - 1] ?? 0) === step);
}

const scrypt = promisify(scryptCb) as (
  pin: string,
  salt: Buffer,
  keylen: number,
  opts: { N: number },
) => Promise<Buffer>;

/** Async twin of verifyPin (pin.ts format), so many checks run in parallel. */
async function matchesHash(pin: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt" || !parts[1] || !parts[2])
    return false;
  const expected = Buffer.from(parts[2], "hex");
  if (expected.length !== 32) return false;
  try {
    const derived = await scrypt(
      pin.normalize("NFKC"),
      Buffer.from(parts[1], "hex"),
      32,
      {
        N: 16384,
      },
    );
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

/** How long a replaced short PIN keeps working (until the new one is used). */
export const SHORT_PIN_GRACE_MS = 10 * 60 * 1000;

/**
 * Generate a PIN no OTHER staff member of the tenant uses, hash it, and store
 * it on `staffId` (targeted update; also resets the lockout). Returns the
 * plaintext ONCE, or null when the staff member isn't in the tenant.
 * `random` is injectable for tests.
 */
export async function issueStaffPin(
  tenantId: string,
  staffId: string,
  random: (max: number) => number = (max) => randomInt(0, max),
  opts: { keepOldForMs?: number } = {},
): Promise<string | null> {
  const driver = getPosDriver();
  // Every other member's PIN hashes: the current one, and a replaced short
  // PIN still in its grace window (it still unlocks, so it must not repeat).
  const now = Date.now();
  const others = (await driver.listStaffPinRecords(tenantId))
    .filter((r) => r.id !== staffId)
    .flatMap((r) => [
      r.pin_hash,
      r.pin_previous_hash &&
      r.pin_previous_until &&
      new Date(r.pin_previous_until).getTime() > now
        ? r.pin_previous_hash
        : null,
    ])
    .filter((h): h is string => !!h);
  for (let tries = 0; tries < 25; tries++) {
    const pin = String(random(10 ** ISSUED_PIN_LENGTH)).padStart(
      ISSUED_PIN_LENGTH,
      "0",
    );
    if (isWeakPin(pin)) continue;
    const clashes = await Promise.all(
      others.map((h) => matchesHash(pin, h)),
    );
    if (clashes.some(Boolean)) continue;
    const ok = opts.keepOldForMs
      ? // Replacing a short PIN: the old one stays valid until the new one is
        // first used or the grace passes (a lost response can't lock anyone out).
        await driver.rotateStaffPin(
          tenantId,
          staffId,
          hashPin(pin),
          new Date(Date.now() + opts.keepOldForMs).toISOString(),
        )
      : await driver.setStaffPinHash(tenantId, staffId, hashPin(pin));
    return ok ? pin : null;
  }
  throw new Error("Could not issue a unique PIN. Try again.");
}

// ---- PIN bootstrap -----------------------------------------------------------------

/** How recent an account sign-in must be to issue the first gating PIN. */
export const RECENT_SIGN_IN_MS = 10 * 60 * 1000;

/** Machine-readable code: the UI asks the person to sign in again. */
export const REAUTH_REQUIRED = "reauth_required";

/**
 * May a PIN be issued to a member with `role`? null = yes; otherwise the
 * refusal. Bootstrap rules (the back-office gate turns on with the first
 * owner/manager PIN, see src/lib/auth/admin-gate.ts):
 *   - the first gating PIN must be an OWNER's: no manager PIN while no active
 *     owner has one (else a manager's PIN would lock the owner out);
 *   - issuing the PIN that turns the gate on needs a recent account sign-in
 *     (`recentSignIn`), so a cashier at a till left signed in as the owner
 *     can't mint the owner a PIN they then know.
 */
export function checkPinIssue(input: {
  role: MembershipRole;
  ownerHasPin: boolean;
  gateOn: boolean;
  recentSignIn: boolean;
}): { status: 401 | 409; error: string; code?: string } | null {
  if (input.role === "manager" && !input.ownerHasPin) {
    return {
      status: 409,
      error: "Give an owner a PIN first. Manager PINs come after the owner's.",
    };
  }
  const turnsGateOn =
    !input.gateOn && (input.role === "owner" || input.role === "manager");
  if (turnsGateOn && !input.recentSignIn) {
    return {
      status: 401,
      error: "Sign in again to set the first owner PIN (for your security).",
      code: REAUTH_REQUIRED,
    };
  }
  return null;
}

/** Does the tenant have an ACTIVE owner with a PIN? */
export async function ownerHasPin(tenantId: string): Promise<boolean> {
  const driver = getPosDriver();
  const [staff, withPin] = await Promise.all([
    driver.listStaff(tenantId),
    driver.listStaffWithPin(tenantId),
  ]);
  return staff.some((s) => s.active && s.role === "owner" && withPin.has(s.id));
}
