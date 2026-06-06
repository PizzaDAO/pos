/**
 * HTTP glue for rate limiting (Phase 7 hardening).
 *
 * Turns the pure {@link RateLimiter} into a drop-in route-handler guard:
 *   - derives a best-effort client IP from proxy headers (Vercel sets
 *     `x-forwarded-for` / `x-real-ip`);
 *   - applies the named rule to one or more identity keys (per-IP and, where
 *     sensible, per-account) — the strictest result wins;
 *   - returns a ready `429` `NextResponse` with `Retry-After` + `RateLimit-*`
 *     headers when blocked, or `null` to proceed.
 *
 * No-op when {@link rateLimitEnabled} is false (tests / disabled), so the
 * zero-env build + Vitest suite are never throttled.
 */
import { NextResponse } from "next/server";
import {
  defaultLimiter,
  rateLimitEnabled,
  RATE_LIMIT_RULES,
  type RateLimitBucket,
  type RateLimitResult,
} from "./rate-limit";

/** Best-effort client IP from proxy headers; falls back to a constant. */
export function clientIp(headers: Headers): string {
  const fwd = headers.get("x-forwarded-for");
  if (fwd) {
    // First hop is the original client; the rest are proxies.
    const first = fwd.split(",")[0]?.trim();
    if (first) return first;
  }
  return headers.get("x-real-ip")?.trim() || "unknown";
}

/** Attach `RateLimit-*` headers (draft IETF naming) to a response/headers bag. */
function applyHeaders(headers: Headers, r: RateLimitResult): void {
  headers.set("RateLimit-Limit", String(r.limit));
  headers.set("RateLimit-Remaining", String(r.remaining));
  headers.set(
    "RateLimit-Reset",
    String(Math.ceil((r.resetAt - Date.now()) / 1000)),
  );
}

export interface RateLimitOptions {
  /** Extra identity keys to limit on (e.g. an email/account/staff id). */
  keys?: Array<string | null | undefined>;
}

/**
 * Enforce the `bucket` rule for `request`. Returns a `429` response to return
 * as-is when any identity key is over the limit, else `null` (proceed).
 *
 * Always limits per-IP; additional `keys` (e.g. the login email) are limited
 * under the same rule so an attacker can't dodge the IP limit by rotating IPs
 * against one account, nor pivot across accounts from one IP.
 */
export function enforceRateLimit(
  request: Request,
  bucket: RateLimitBucket,
  options: RateLimitOptions = {},
): NextResponse | null {
  if (!rateLimitEnabled()) return null;

  const rule = RATE_LIMIT_RULES[bucket];
  const ip = clientIp(request.headers);
  const identities = [
    `${bucket}:ip:${ip}`,
    ...(options.keys ?? [])
      .filter((k): k is string => typeof k === "string" && k.length > 0)
      .map((k) => `${bucket}:key:${k.toLowerCase()}`),
  ];

  let blocked: RateLimitResult | null = null;
  let tightest: RateLimitResult | null = null;
  for (const id of identities) {
    const res = defaultLimiter.check(id, rule);
    if (!tightest || res.remaining < tightest.remaining) tightest = res;
    if (!res.allowed) blocked = res;
  }

  if (blocked) {
    const res = NextResponse.json(
      { error: "Too many requests. Please slow down and try again shortly." },
      { status: 429 },
    );
    res.headers.set("Retry-After", String(blocked.retryAfterSeconds));
    applyHeaders(res.headers, blocked);
    return res;
  }

  // Not blocked: nothing to return. (Informational headers are most useful on
  // the 429; we keep the success path header-free to avoid coupling callers.)
  void tightest;
  return null;
}
