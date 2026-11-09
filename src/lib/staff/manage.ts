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
): Promise<string | null> {
  const driver = getPosDriver();
  const others = (await driver.listStaffPinRecords(tenantId)).filter(
    (r) => r.id !== staffId && r.pin_hash,
  );
  for (let tries = 0; tries < 25; tries++) {
    const pin = String(random(10 ** ISSUED_PIN_LENGTH)).padStart(
      ISSUED_PIN_LENGTH,
      "0",
    );
    if (isWeakPin(pin)) continue;
    const clashes = await Promise.all(
      others.map((r) => matchesHash(pin, r.pin_hash as string)),
    );
    if (clashes.some(Boolean)) continue;
    const ok = await driver.setStaffPinHash(tenantId, staffId, hashPin(pin));
    return ok ? pin : null;
  }
  throw new Error("Could not issue a unique PIN. Try again.");
}
