# Phase 7 — Production Security Hardening

> Security-hardening pass on the multi-tenant SaaS pizzeria POS. Adds defense-in-depth
> on top of the existing RLS + session-gated auth, without weakening any existing
> auth/money/RLS correctness. Everything stays **zero-env safe** (build + Vitest green
> with no environment variables) and adds **no new npm dependency**.

## Scope

In: security headers + CSP, rate limiting, broadened audit logging, service-role
inventory/review, input validation hardening, threat-model doc.

Out (owned by other agents / out of this pass): the realtime layer
(`src/lib/realtime/*`), Playwright/E2E, any `package.json` change, any change to
RLS policies or the money/auth correctness model.

## Threat model addressed

| # | Threat | Vector | Mitigation in this pass |
|---|---|---|---|
| T1 | **XSS / script injection** | Reflected/stored script, malicious 3rd-party script, inline injection | Strict **CSP** (`default-src 'self'`, `object-src 'none'`, enumerated `script/connect/frame-src`), `X-Content-Type-Options: nosniff`. App ships **no** author inline scripts / `dangerouslySetInnerHTML`. |
| T2 | **Clickjacking** | App framed by an attacker page to trick staff clicks | `frame-ancestors 'none'` (CSP) + legacy `X-Frame-Options: DENY`. |
| T3 | **Protocol downgrade / MITM** | Plain-HTTP interception, mixed content | `Strict-Transport-Security` (2y, preload, subdomains) + `upgrade-insecure-requests`. Inert on localhost. |
| T4 | **Referrer / capability leakage** | URLs + powerful browser features leaking to 3rd parties | `Referrer-Policy: strict-origin-when-cross-origin`; `Permissions-Policy` denies camera/mic/geo/usb, `payment=(self)`. |
| T5 | **Credential brute-force** | Automated guessing of staff **PIN**, magic-link spam / email-bombing | Per-IP (+ per-account where sensible) **rate limiting** on PIN, magic-link, returning **429 + Retry-After**. |
| T6 | **Order / payment abuse** | Automated order spam, card-testing via repeated charge/refund attempts | Rate limiting on order-create + payment + refund endpoints. |
| T7 | **Repudiation / lack of traceability** | Sensitive action taken with no trail (refund, 86, Connect change, sign-in, go-live) | Broadened **audit_log** coverage, tenant-scoped, append-only, surfaced in `/platform`. |
| T8 | **Service-role over-reach** | Service-role key bypasses RLS; a missing tenant filter = cross-tenant leak | **Inventory + review** of every service-role call site (all in the driver); confirmed every tenant-scoped query carries an explicit `tenant_id`/`location_id` filter. Documented in PRODUCTION_READINESS §11. |
| T9 | **Malformed / oversized input** | Junk payloads, negative/NaN money, giant bodies (DoS) | Hardened validators (money = non-negative int cents; bounded ids/emails) + a **256 KB body cap** on sensitive routes (413). |
| T10 | **Broken object-level authZ** | Acting on another tenant's object by id (notably the refund endpoint had **no** auth) | Refund + Connect endpoints now resolve the target's tenant and require `requireTenantMember`/`owner|manager`. |

## Design decisions

- **No new dependency.** Rate limiting is a zero-dep in-memory fixed-window
  limiter (`src/lib/security/rate-limit.ts`). Validation uses dependency-free
  guards (no zod). CSP/headers are static.
- **Zero-env / test no-op.** Rate limiting is disabled under `VITEST` /
  `NODE_ENV=test` / `RATE_LIMIT_DISABLED`, so the suite + local dev never trip a
  limit. The limiter + validators + audit are unit-tested directly regardless.
- **Static CSP, no nonce** (trade-off documented in `src/lib/security/headers.ts`
  and PRODUCTION_READINESS §11): middleware runs on protected surfaces only, so a
  per-request nonce can't be applied uniformly without broadening the matcher
  (out of scope). `script-src` therefore allows `'unsafe-inline'`; every other
  vector is locked down and the app ships no author inline scripts.
- **Audit is fail-open.** `recordAudit` never throws — a logging hiccup must not
  fail a refund or a login. It is tenant-scoped via the existing `audit_log`.
- **Process-local rate limiter caveat:** on serverless each instance has its own
  window, so the global limit scales with concurrency. Acceptable for blunting a
  single-source brute-force without an external store; swap `defaultLimiter` for
  a shared store later with no call-site change.

## Files

New: `src/lib/security/{rate-limit,http,audit,validate,headers,index}.ts` (+ tests).
Edited: `next.config.ts` (headers), `src/lib/db/saas-types.ts` (AuditAction),
and the sensitive routes (orders, payments, payments/refund, terminal/pin,
shop/auth/magic-link, admin/overrides, connect, billing, signup, auth/callback).

## Verification

`npm run typecheck && npm run lint && npm run build && npm run test:run` all green
with **no env vars**. New tests cover the limiter, the HTTP guard/no-op,
validators, CSP/headers, and the audit helper (incl. fail-open).
