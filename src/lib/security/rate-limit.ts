/**
 * Lightweight in-memory rate limiter (Phase 7 hardening).
 *
 * Zero-dependency, fixed-window per-key limiter for blunting brute-force /
 * abuse on sensitive endpoints (auth, order creation, payments). It is
 * deliberately simple and process-local:
 *
 *   - **No new dependency.** A `Map<string, window>` with periodic pruning.
 *   - **No-op-safe by default.** Disabled when `RATE_LIMIT_DISABLED` is truthy
 *     OR when running under a test runner (`VITEST`/`NODE_ENV==="test"`), so the
 *     build, the Vitest suite, and local dev all stay green with zero env. The
 *     limiter itself is still unit-tested directly via {@link RateLimiter}.
 *   - **Process-local caveat.** On serverless (Vercel) each instance keeps its
 *     own window, so the effective limit scales with concurrency. This is a
 *     deliberate trade-off to avoid an external store (Redis/Upstash) and a new
 *     dependency; it still meaningfully blunts a single-source brute-force. For
 *     a hard global limit, swap `defaultStore` for a shared store later — the
 *     call sites do not change.
 *
 * Identity: callers pass a key (typically `"<bucket>:<ip>"` and/or
 * `"<bucket>:<account>"`). The HTTP glue in `http.ts` derives the client IP
 * from proxy headers and returns a ready-to-send `429` with `Retry-After` +
 * `RateLimit-*` headers.
 */

export interface RateLimitRule {
  /** Max requests permitted within the window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
}

export interface RateLimitResult {
  /** Whether this request is allowed (false ⇒ caller should return 429). */
  allowed: boolean;
  /** Configured ceiling for the window. */
  limit: number;
  /** Requests remaining in the current window (never negative). */
  remaining: number;
  /** Epoch millis when the current window resets. */
  resetAt: number;
  /** Seconds until reset — for the `Retry-After` header (>= 1 when blocked). */
  retryAfterSeconds: number;
}

interface Window {
  count: number;
  resetAt: number;
}

/**
 * A fixed-window counter keyed by an arbitrary string. Pure and deterministic
 * given an injected clock, so it is straightforward to unit-test.
 */
export class RateLimiter {
  private readonly windows = new Map<string, Window>();
  private lastPrune = 0;

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Record a hit for `key` under `rule` and report whether it is allowed.
   * The window is created on first hit and reset once it elapses.
   */
  check(key: string, rule: RateLimitRule): RateLimitResult {
    const t = this.now();
    this.maybePrune(t);

    let win = this.windows.get(key);
    if (!win || win.resetAt <= t) {
      win = { count: 0, resetAt: t + rule.windowMs };
      this.windows.set(key, win);
    }

    win.count += 1;
    const allowed = win.count <= rule.limit;
    const remaining = Math.max(0, rule.limit - win.count);
    const retryAfterSeconds = allowed
      ? 0
      : Math.max(1, Math.ceil((win.resetAt - t) / 1000));

    return {
      allowed,
      limit: rule.limit,
      remaining,
      resetAt: win.resetAt,
      retryAfterSeconds,
    };
  }

  /** Forget a key (e.g. on a successful login, to not penalise the next user). */
  reset(key: string): void {
    this.windows.delete(key);
  }

  /** Test/maintenance helper: drop all state. */
  clear(): void {
    this.windows.clear();
    this.lastPrune = 0;
  }

  /** Drop elapsed windows at most ~once per window to bound memory. */
  private maybePrune(t: number): void {
    if (t - this.lastPrune < 30_000) return;
    this.lastPrune = t;
    for (const [k, w] of this.windows) {
      if (w.resetAt <= t) this.windows.delete(k);
    }
  }
}

/** Named limits for the sensitive surfaces. Tuned to be generous for humans. */
export const RATE_LIMIT_RULES = {
  /** Auth: login / magic-link / PIN — strict, per IP and per account. */
  auth: { limit: 10, windowMs: 60_000 } satisfies RateLimitRule,
  /** PIN verification — extra strict (4-8 digit space is small). */
  pin: { limit: 8, windowMs: 60_000 } satisfies RateLimitRule,
  /** Order creation — high ceiling (a busy terminal places many). */
  orders: { limit: 60, windowMs: 60_000 } satisfies RateLimitRule,
  /** Payment capture / refund — moderate. */
  payments: { limit: 30, windowMs: 60_000 } satisfies RateLimitRule,
} as const;

export type RateLimitBucket = keyof typeof RATE_LIMIT_RULES;

/** Shared process-local limiter for the app's HTTP glue. */
export const defaultLimiter = new RateLimiter();

/**
 * Whether rate limiting is active. Disabled under tests and when explicitly
 * turned off, so the zero-env build/suite/dev never trip a limit. The limiter
 * class is still unit-tested directly regardless of this flag.
 */
export function rateLimitEnabled(): boolean {
  if (process.env.RATE_LIMIT_DISABLED) return false;
  if (process.env.NODE_ENV === "test" || process.env.VITEST) return false;
  return true;
}
