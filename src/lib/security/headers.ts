/**
 * Security headers + Content-Security-Policy (Phase 7 hardening).
 *
 * Emitted for every route via `next.config.ts` `headers()`. Kept in `src/lib`
 * (not inline in the config) so it can be reasoned about + unit-tested and so
 * the CSP source list lives in one place.
 *
 * ── CSP approach (no nonce) ────────────────────────────────────────────────
 * The app is Next.js 15 App Router + a Serwist service worker + Supabase Auth +
 * Stripe (Terminal/Checkout) + (optionally) crypto RPC endpoints. Next's App
 * Router injects framework **inline** bootstrap/flight scripts on every page.
 * A nonce-based `script-src` would require minting a per-request nonce in
 * middleware and threading it through the document — but this app's middleware
 * intentionally runs on the protected surfaces ONLY (`/admin|/terminal|/kitchen|
 * /platform`); `/shop`, `/`, and statically-rendered routes are not matched, so
 * a nonce can't be applied uniformly without broadening middleware (out of
 * scope, and it would also break static optimisation).
 *
 * We therefore ship a **static** CSP applied at the edge via `headers()`:
 *   - `script-src` allows `'self'` + `'unsafe-inline'` (required for Next's
 *     inline runtime scripts without a nonce) + Stripe's JS origins. This is the
 *     documented trade-off: `'unsafe-inline'` for scripts is weaker than a
 *     nonce, but every other vector is locked down and the app ships no
 *     author-controlled inline scripts (no `dangerouslySetInnerHTML`, no inline
 *     `<script>`), so the practical XSS surface is small. To upgrade to nonces
 *     later, mint a nonce in middleware, broaden the matcher to all routes, set
 *     `script-src 'self' 'nonce-…' 'strict-dynamic'`, and pass the nonce to the
 *     root layout.
 *   - `style-src` allows `'unsafe-inline'` for styled-jsx / inline style attrs.
 *   - `connect-src`/`frame-src`/`img-src` enumerate the runtime integrations
 *     (Supabase, Stripe, crypto RPC, blob/data for the PWA + receipts).
 *   - `frame-ancestors 'none'` (clickjacking) — paired with `X-Frame-Options`.
 *   - `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`,
 *     `upgrade-insecure-requests`.
 *
 * Everything here is STATIC — no env vars are read — so the zero-env build is
 * unaffected. We intentionally widen `connect-src`/`frame-src` to the whole
 * `*.supabase.co` / Stripe / common Base-RPC origins rather than reading env at
 * build time, so a later env flip needs no header change.
 */

/** Build the CSP string from a directive map. */
function serializeCsp(directives: Record<string, string[]>): string {
  return Object.entries(directives)
    .map(([k, v]) => (v.length ? `${k} ${v.join(" ")}` : k))
    .join("; ");
}

/**
 * The Content-Security-Policy directive set. Exported for testing/inspection.
 * Origins are intentionally a superset of what any single deployment uses so
 * the same policy works in mock-mode and live-mode without env-dependent edits.
 */
export const CSP_DIRECTIVES: Record<string, string[]> = {
  "default-src": ["'self'"],
  // Next App Router emits inline runtime scripts; Stripe.js + Terminal are
  // loaded from Stripe origins. 'unsafe-inline' here is the documented no-nonce
  // trade-off (see file header).
  "script-src": [
    "'self'",
    "'unsafe-inline'",
    "https://js.stripe.com",
    "https://*.js.stripe.com",
  ],
  // Allow Next/styled-jsx + Tailwind inline styles + Google Fonts stylesheet.
  "style-src": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
  "img-src": ["'self'", "data:", "blob:", "https:"],
  "font-src": ["'self'", "data:", "https://fonts.gstatic.com"],
  // Runtime XHR/fetch/websocket targets: Supabase (REST + Realtime WSS),
  // Stripe API, and common Base-network RPC endpoints for onchain USDC.
  "connect-src": [
    "'self'",
    "https://*.supabase.co",
    "wss://*.supabase.co",
    "https://api.stripe.com",
    "https://*.stripe.com",
    "https://mainnet.base.org",
    "https://sepolia.base.org",
    "https://*.base.org",
  ],
  // Stripe embeds its payment/Checkout iframes; nothing else may frame-in.
  "frame-src": ["'self'", "https://js.stripe.com", "https://*.stripe.com"],
  "worker-src": ["'self'", "blob:"],
  "manifest-src": ["'self'"],
  "object-src": ["'none'"],
  "base-uri": ["'self'"],
  "form-action": ["'self'"],
  // Clickjacking defence (modern; X-Frame-Options is the legacy companion).
  "frame-ancestors": ["'none'"],
  "upgrade-insecure-requests": [],
};

/** The serialized CSP header value. */
export const CONTENT_SECURITY_POLICY = serializeCsp(CSP_DIRECTIVES);

/** Permissions-Policy: deny powerful features the POS does not use. */
const PERMISSIONS_POLICY = [
  "camera=()",
  "microphone=()",
  "geolocation=()",
  "payment=(self)",
  "usb=()",
  "interest-cohort=()",
].join(", ");

export interface SecurityHeader {
  key: string;
  value: string;
}

/**
 * The full set of security headers applied to every response. HSTS is included;
 * it is inert over plain HTTP (browsers ignore it) so it is safe on localhost
 * and only takes effect once served over HTTPS (Vercel/prod).
 */
export const SECURITY_HEADERS: SecurityHeader[] = [
  { key: "Content-Security-Policy", value: CONTENT_SECURITY_POLICY },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: PERMISSIONS_POLICY },
  // Spectre-class isolation hints (safe defaults; do not break same-origin).
  { key: "X-DNS-Prefetch-Control", value: "off" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
];
