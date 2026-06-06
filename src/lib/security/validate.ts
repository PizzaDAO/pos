/**
 * Input-validation helpers (Phase 7 hardening).
 *
 * Dependency-free guards (no zod — the constraint is to avoid new deps) for the
 * sensitive order/payment/auth routes. They harden the existing hand-written
 * type guards by rejecting malformed, out-of-range, and **oversized** payloads
 * BEFORE they reach the domain layer.
 *
 * `readJsonBody` additionally enforces a byte cap so a giant body can't be used
 * to exhaust memory/CPU; it returns a typed result the caller turns into a 400.
 */

/** Default max request-body size (256 KB) — generous for an order, tiny for abuse. */
export const MAX_BODY_BYTES = 256 * 1024;

export type JsonResult =
  | { ok: true; body: unknown }
  | { ok: false; status: number; error: string };

/**
 * Parse a JSON request body with a hard size cap. Prefers the `Content-Length`
 * header for a cheap early reject, then re-checks the actual decoded length
 * (the header can lie / be absent on chunked bodies).
 */
export async function readJsonBody(
  request: Request,
  maxBytes: number = MAX_BODY_BYTES,
): Promise<JsonResult> {
  const declared = request.headers.get("content-length");
  if (declared && Number(declared) > maxBytes) {
    return { ok: false, status: 413, error: "Request body too large." };
  }
  let text: string;
  try {
    text = await request.text();
  } catch {
    return { ok: false, status: 400, error: "Could not read request body." };
  }
  // Byte length (UTF-8 aware) — re-check after decoding.
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    return { ok: false, status: 413, error: "Request body too large." };
  }
  if (text.trim().length === 0) {
    return { ok: false, status: 400, error: "Empty request body." };
  }
  try {
    return { ok: true, body: JSON.parse(text) };
  } catch {
    return { ok: false, status: 400, error: "Invalid JSON body." };
  }
}

// -- Scalar guards -----------------------------------------------------------

export function isNonEmptyString(v: unknown, maxLen = 1024): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= maxLen;
}

/** A finite, non-negative, integer amount of money in minor units (cents). */
export function isMoneyCents(v: unknown, max = 100_000_000): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= max;
}

/**
 * A plausible client/UUID id: bounded length, allowlisted charset only
 * (alphanumerics, hyphen, underscore). This both rejects control characters /
 * whitespace and keeps ids safe to log + use as map keys.
 */
export function isClientId(v: unknown): v is string {
  return (
    typeof v === "string" &&
    v.length >= 8 &&
    v.length <= 128 &&
    /^[A-Za-z0-9_-]+$/.test(v)
  );
}

/**
 * An RFC-4122 UUID (any version). Used to reject malformed ids BEFORE they
 * reach a `uuid`-typed Supabase column (which would otherwise surface as a 500
 * `invalid input syntax for type uuid` instead of a clean 422).
 */
export function isUuid(v: unknown): v is string {
  return (
    typeof v === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
  );
}

/** A minimal, length-bounded email shape (server is the source of truth). */
export function isEmail(v: unknown, maxLen = 254): v is string {
  return (
    typeof v === "string" &&
    v.length <= maxLen &&
    /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.trim())
  );
}
