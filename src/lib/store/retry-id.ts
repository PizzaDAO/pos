/**
 * Client idempotency ids that SURVIVE an ambiguous failure (client-safe).
 *
 * When the server answers 503 `{ retry: true }` (the payment provider's outcome
 * is unknown) or the request itself fails on the network, the money may have
 * moved. The retry MUST reuse the same id so the provider dedupes it — a fresh
 * id could charge / refund twice. A definitive answer (success, or a 4xx
 * refusal) releases the id so the next attempt gets a new one.
 */

/** RFC-4122 v4 UUID (crypto.randomUUID needs a secure context). */
export function newUuid(): string {
  const c = typeof crypto !== "undefined" ? crypto : undefined;
  if (c && "randomUUID" in c && typeof c.randomUUID === "function") {
    return c.randomUUID();
  }
  const b = new Uint8Array(16);
  if (c && typeof c.getRandomValues === "function") c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export interface RetryIdSlot {
  current: { key: string; id: string } | null;
}

/** The id for an attempt described by `key`: reused if a prior one is unresolved. */
export function idForAttempt(slot: RetryIdSlot, key: string): string {
  if (slot.current && slot.current.key === key) return slot.current.id;
  const id = newUuid();
  slot.current = { key, id };
  return id;
}

/**
 * Settle the slot after an attempt: keep the id only when the outcome is
 * ambiguous (network error, or 503 with `retry: true`).
 */
export function settleAttempt(
  slot: RetryIdSlot,
  outcome: { networkError: true } | { status: number; retry?: boolean },
): void {
  const ambiguous =
    "networkError" in outcome ||
    (outcome.status === 503 && outcome.retry === true) ||
    outcome.status >= 500;
  if (!ambiguous) slot.current = null;
}
