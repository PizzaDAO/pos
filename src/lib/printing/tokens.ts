/**
 * Per-printer device tokens. The token is `<printerId>.<secret>`; only
 * sha256(secret) is stored, and the full token is shown to the admin once.
 * It travels in the URL path of the printer's server URL (CloudPRNT / Epson SDP
 * printers can only be given a URL), so it is a bearer credential: HTTPS only,
 * revocable by deleting the printer.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export function generatePrinterSecret(): { secret: string; hash: string } {
  const secret = randomBytes(32).toString("base64url");
  return { secret, hash: hashSecret(secret) };
}

export function formatToken(printerId: string, secret: string): string {
  return `${printerId}.${secret}`;
}

export function parseToken(token: string): { printerId: string; secret: string } | null {
  const i = token.indexOf(".");
  if (i <= 0 || i === token.length - 1) return null;
  const printerId = token.slice(0, i);
  const secret = token.slice(i + 1);
  if (!/^[0-9a-f-]{36}$/i.test(printerId) || secret.length > 200) return null;
  return { printerId, secret };
}

export function secretMatches(secret: string, storedHash: string): boolean {
  const a = Buffer.from(hashSecret(secret), "hex");
  const b = Buffer.from(storedHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
