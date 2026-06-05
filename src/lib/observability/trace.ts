/**
 * Request/trace id helpers (Phase 7 observability).
 *
 * Every API route can derive a correlation id from an inbound request — reusing
 * an upstream `x-request-id` / `x-trace-id` / W3C `traceparent` when present, or
 * minting a fresh one — and echo it back on the response so a single request can
 * be followed end-to-end across logs and client/server boundaries.
 *
 * No env, no I/O, browser/edge/node safe.
 */

export const REQUEST_ID_HEADER = "x-request-id";
export const TRACE_ID_HEADER = "x-trace-id";

/** Generate a fresh request id (UUID where available, else a random token). */
export function newRequestId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/** Extract the W3C trace id (the middle segment) from a `traceparent` header. */
export function parseTraceparent(traceparent: string | null): string | null {
  if (!traceparent) return null;
  const parts = traceparent.split("-");
  // version-traceid-spanid-flags ; traceid is 32 hex chars.
  if (parts.length >= 2 && parts[1] && /^[0-9a-f]{32}$/i.test(parts[1])) {
    return parts[1];
  }
  return null;
}

/**
 * Resolve the correlation id for a request: prefer an upstream id so a trace is
 * continuous, otherwise mint a new one. Header lookup is case-insensitive (the
 * Headers API normalizes), and a bare `{ get }` shape is accepted so this works
 * with `Request`, `NextRequest`, and plain test doubles.
 */
export function resolveRequestId(headers: {
  get(name: string): string | null;
}): string {
  return (
    headers.get(REQUEST_ID_HEADER) ||
    headers.get(TRACE_ID_HEADER) ||
    parseTraceparent(headers.get("traceparent")) ||
    newRequestId()
  );
}

/** Headers to merge onto a response so the caller sees the correlation id. */
export function traceResponseHeaders(
  requestId: string,
): Record<string, string> {
  return { [REQUEST_ID_HEADER]: requestId };
}
