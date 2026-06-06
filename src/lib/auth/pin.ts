/**
 * Staff PIN hashing + verification (server-only).
 *
 * On a shared terminal, the device is logged into a LOCATION by a tenant user
 * (real Supabase session). Cashiers then quick-switch the *active staff member*
 * by typing a short PIN — without a full re-login — so orders/shifts are
 * attributed to whoever is at the counter. The PIN is verified SERVER-SIDE
 * against `staff.pin_hash`; the hash is NEVER sent to the client, and the
 * client only ever learns the resolved active-staff id on success.
 *
 * Hashing uses Node's built-in `scrypt` (no new dependency), with a per-PIN
 * random salt. Format: `scrypt$<saltHex>$<hashHex>`. Verification is constant
 * time (`timingSafeEqual`). This module is server-only — it imports `node:crypto`
 * and must never be bundled into a client component.
 */
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const KEYLEN = 32;
const N = 16384; // scrypt cost (CPU/memory)

/** Hash a plaintext PIN into a salted `scrypt$salt$hash` string. */
export function hashPin(pin: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(pin.normalize("NFKC"), salt, KEYLEN, { N });
  return `scrypt$${salt.toString("hex")}$${derived.toString("hex")}`;
}

/**
 * Verify a plaintext PIN against a stored `scrypt$salt$hash`. Returns false for
 * a null/empty stored hash or any malformed value (never throws). Constant-time
 * comparison so a mismatch can't be timed.
 */
export function verifyPin(pin: string, storedHash: string | null | undefined): boolean {
  if (!storedHash) return false;
  const parts = storedHash.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const saltHex = parts[1];
  const hashHex = parts[2];
  if (!saltHex || !hashHex) return false;
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(saltHex, "hex");
    expected = Buffer.from(hashHex, "hex");
  } catch {
    return false;
  }
  if (expected.length !== KEYLEN) return false;
  let derived: Buffer;
  try {
    derived = scryptSync(pin.normalize("NFKC"), salt, KEYLEN, { N });
  } catch {
    return false;
  }
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/** Basic PIN policy: 4–8 digits. Keeps quick-switch fast but not trivial. */
export function isValidPinFormat(pin: unknown): pin is string {
  return typeof pin === "string" && /^[0-9]{4,8}$/.test(pin);
}
