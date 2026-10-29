/**
 * Stable tender ids across retries.
 *
 * `/api/payments` is idempotent on the client-supplied `paymentId`, but only if
 * the client SENDS THE SAME ID when it retries. Minting a fresh UUID on every
 * Charge press defeats that: a retry after a lost response would create a second
 * tender (and a second charge). This helper hands out one id per distinct pending
 * tender (order + rail + amount + tip + cash tendered) and keeps handing out the
 * same id until the caller `clear()`s it on success. Changing any part of the
 * tender (amount, rail, ...) is a different tender and gets a new id.
 */
export interface PendingTenderIds {
  /** The id for the tender described by `signature` (minted on first use). */
  get(signature: string): string;
  /** Forget the current id (call after the tender is recorded). */
  clear(): void;
}

export function createPendingTenderIds(newId: () => string): PendingTenderIds {
  let currentSignature: string | null = null;
  let currentId: string | null = null;
  return {
    get(signature) {
      if (currentId === null || currentSignature !== signature) {
        currentSignature = signature;
        currentId = newId();
      }
      return currentId;
    },
    clear() {
      currentSignature = null;
      currentId = null;
    },
  };
}

/** Canonical signature for a tender, for use with `get`. */
export function tenderSignature(parts: {
  orderId: string;
  rail: string;
  amountCents: number;
  tipCents: number;
  cashTenderedCents?: number;
}): string {
  return [
    parts.orderId,
    parts.rail,
    parts.amountCents,
    parts.tipCents,
    parts.cashTenderedCents ?? "",
  ].join("|");
}
