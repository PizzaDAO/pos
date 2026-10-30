/**
 * Post-auth redirect targets (sign-in, magic-link callback, sign-out) come from
 * the query string, so they are attacker-controlled. Only same-origin internal
 * paths are honoured; anything else falls back.
 *
 * A value is safe when ALL hold:
 *   - it starts with `/` (a path, not a scheme / host);
 *   - it contains no `\` (browsers + WHATWG URL treat it as `/`, so `/\evil.com`
 *     is protocol-relative) and no control characters (tab/CR/LF are stripped
 *     by the URL parser, so `/\t/evil.com` would become `//evil.com`);
 *   - resolving it against `origin` stays on `origin` (rejects `//evil.com`).
 *
 * Pure: safe on the server and in the client.
 */

/** Placeholder origin for callers that have none (e.g. a server page). */
const FALLBACK_ORIGIN = "http://localhost";

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

export function isSafeRedirectPath(
  value: string | null | undefined,
  origin: string = FALLBACK_ORIGIN,
): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  if (!value.startsWith("/")) return false;
  if (value.includes("\\") || CONTROL_CHARS.test(value)) return false;
  try {
    const base = new URL(origin).origin;
    return new URL(value, base).origin === base;
  } catch {
    return false;
  }
}

/** `value` when it is a safe internal path, else `fallback`. */
export function safeRedirectPath(
  value: string | null | undefined,
  fallback: string,
  origin: string = FALLBACK_ORIGIN,
): string {
  return isSafeRedirectPath(value, origin) ? value : fallback;
}
