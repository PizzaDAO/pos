/**
 * When may the till mint a NEW request id for a refund / void / comp? Only
 * after a DEFINITE refusal: a 4xx that says the server did nothing. A lost
 * response (offline: status 0), a timeout, a rate limit, a 5xx, or a partial /
 * pending refund may have moved money, so the retry must reuse the same id
 * (the server then resumes it and never moves money twice). Pure, client-safe.
 */
export function isDefiniteRefusal(res: {
  status: number;
  partial?: boolean;
  pending?: boolean;
}): boolean {
  if (res.partial || res.pending) return false;
  return res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429;
}
