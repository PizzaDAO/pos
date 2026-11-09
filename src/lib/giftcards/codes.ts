/**
 * Gift card / store credit CODES (server-only).
 *
 *  - Generated codes are 16 Crockford base-32 characters = 80 bits of entropy,
 *    shown as `XXXX-XXXX-XXXX-XXXX`. The alphabet drops I, L, O and U, and input
 *    normalization maps the look-alikes back (O -> 0, I/L -> 1), so a code read
 *    off a receipt still matches.
 *  - Pre-printed PHYSICAL card numbers are accepted as entered (letters and
 *    digits, 12 to 32 characters after removing spaces and dashes).
 *  - Codes are NEVER stored. The database holds HMAC-SHA256(pepper, tenant +
 *    code) and the last 4 characters. The pepper (GIFT_CARD_CODE_PEPPER) is not
 *    in the database, so a database dump alone cannot be brute forced offline,
 *    even for low-entropy printed card numbers.
 *  - Online purchases DERIVE their code from the account id under the pepper, so
 *    the server can re-derive it to deliver it after payment without storing it.
 *
 * The pepper must be stable: rotating it orphans every existing card. In real
 * mode it is REQUIRED (gift cards stay off without it, see `giftCardsEnabled`);
 * only the zero-env demo falls back to a per-process random pepper, matching
 * its per-process mock state.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { isRealMode } from "@/lib/auth/signing-secret";

/** Crockford base-32 (no I, L, O, U). 32 symbols: one byte & 31 is unbiased. */
export const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const GENERATED_CODE_LENGTH = 16;
export const MIN_CODE_LENGTH = 12;
export const MAX_CODE_LENGTH = 32;

let processPepper: string | null = null;

/** The code pepper, or null when gift cards must stay off (real mode, unset). */
export function codePepper(): string | null {
  const configured = process.env.GIFT_CARD_CODE_PEPPER;
  if (configured && configured.length >= 32) return configured;
  if (isRealMode()) return null;
  if (!processPepper) processPepper = randomBytes(32).toString("hex");
  return processPepper;
}

/** Thrown when a code operation runs without a pepper (fail closed). */
export class GiftCardsUnavailableError extends Error {
  constructor() {
    super("Gift cards are not available.");
    this.name = "GiftCardsUnavailableError";
  }
}

function requirePepper(pepper?: string | null): string {
  const p = pepper ?? codePepper();
  if (!p) throw new GiftCardsUnavailableError();
  return p;
}

function encode(bytes: Buffer, length: number): string {
  let out = "";
  for (let i = 0; i < length; i += 1) out += CODE_ALPHABET[bytes[i]! & 31];
  return out;
}

/** A fresh random code (80 bits), normalized form (no dashes). */
export function generateCode(): string {
  return encode(randomBytes(GENERATED_CODE_LENGTH), GENERATED_CODE_LENGTH);
}

/** The code of an ONLINE-purchased card, derived from its account id. */
export function deriveCode(accountId: string, pepper?: string | null): string {
  const mac = createHmac("sha256", requirePepper(pepper))
    .update(`giftcard-derive:v1:${accountId}`)
    .digest();
  return encode(mac, GENERATED_CODE_LENGTH);
}

/** `ABCD-EFGH-JKMN-PQRS` for display (any length, groups of 4). */
export function formatCode(code: string): string {
  return code.match(/.{1,4}/g)?.join("-") ?? code;
}

/**
 * Normalize user input: uppercase, drop spaces/dashes, map Crockford look-alikes
 * (O -> 0, I/L -> 1). Returns null for anything that is not 12-32 letters/digits.
 * `U` is kept (a physical card number may contain it).
 */
export function normalizeCode(input: unknown): string | null {
  if (typeof input !== "string") return null;
  if (input.length > 64) return null;
  const s = input
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  if (s.length < MIN_CODE_LENGTH || s.length > MAX_CODE_LENGTH) return null;
  if (!/^[0-9A-Z]+$/.test(s)) return null;
  return s;
}

/** Peppered, tenant-scoped hash of a NORMALIZED code (hex). */
export function hashCode(
  tenantId: string,
  normalized: string,
  pepper?: string | null,
): string {
  return createHmac("sha256", requirePepper(pepper))
    .update(`giftcard-code:v1:${tenantId}:${normalized}`)
    .digest("hex");
}

/** Constant-time compare of two hex hashes (defense in depth on lookups). */
export function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

/** Last 4 characters of a normalized code. */
export function codeLast4(normalized: string): string {
  return normalized.slice(-4);
}

/** `•••• 1234` style mask for staff screens and receipts. */
export function maskedCode(last4: string): string {
  return `•••• ${last4}`;
}
