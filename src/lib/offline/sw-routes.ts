/**
 * Which requests the service worker must NEVER serve from a cache.
 *
 * Serwist's `defaultCache` puts same-origin `GET /api/*` behind NetworkFirst
 * (cache `apis`, 10s timeout). For payment state that is dangerous: a status
 * poll that fails while offline would be answered with a STALE cached status
 * ("still waiting" or even "approved" for a different attempt). Card payments are
 * online-only, so these paths go straight to the network and fail loudly.
 *
 * Kept as a pure module so it is unit-testable (the SW file itself isn't).
 */

/** Same-origin API paths that carry payment / card-reader state. */
const NETWORK_ONLY_PREFIXES = [
  "/api/terminal/",
  "/api/admin/terminal",
  "/api/payments",
] as const;

/** True for a path that must always hit the network (never a cached response). */
export function isNetworkOnlyPath(pathname: string): boolean {
  return NETWORK_ONLY_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

/** True for Stripe's own origins (Stripe.js / API): its scripts must load live. */
export function isStripeOrigin(hostname: string): boolean {
  return hostname === "stripe.com" || hostname.endsWith(".stripe.com");
}
