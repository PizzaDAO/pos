/** Signature helpers shared by the adapters. Node `crypto` only (routes run on the nodejs runtime). */
import { createHmac, timingSafeEqual } from "node:crypto";

export function hmacSha256Hex(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload, "utf8").digest("hex");
}

/** Constant-time compare of two hex strings (false on any length/format mismatch). */
export function safeEqualHex(a: string, b: string): boolean {
  const norm = (v: string) =>
    v
      .trim()
      .toLowerCase()
      .replace(/^sha256=/, "");
  const x = norm(a);
  const y = norm(b);
  if (!/^[0-9a-f]+$/.test(x) || x.length !== y.length) return false;
  return timingSafeEqual(Buffer.from(x, "hex"), Buffer.from(y, "hex"));
}

/** `HMAC-SHA256(secret, rawBody)` in hex, compared in constant time. */
export function verifyBodyHmac(
  rawBody: string,
  signature: string | undefined,
  secret: string,
): boolean {
  if (!signature || !secret) return false;
  return safeEqualHex(hmacSha256Hex(secret, rawBody), signature);
}

/** OAuth2 client-credentials token (used by the real adapters' callbacks). */
export async function fetchClientToken(
  doFetch: typeof fetch,
  url: string,
  clientId: string,
  clientSecret: string,
  scope?: string,
): Promise<string> {
  const res = await doFetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "client_credentials",
      ...(scope ? { scope } : {}),
    }).toString(),
  });
  if (!res.ok) throw new Error(`token request failed (${res.status})`);
  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) throw new Error("token response had no access_token");
  return json.access_token;
}

export function parseJson(rawBody: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(rawBody);
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim()
    ? v.trim()
    : typeof v === "number"
      ? String(v)
      : null;

/** A non-negative integer (cents / quantity), or `fallback`. */
export const int = (v: unknown, fallback = 0): number =>
  typeof v === "number" && Number.isFinite(v)
    ? Math.max(0, Math.round(v))
    : fallback;
