/**
 * Brute-force limits on code lookups (balance checks and redemptions).
 *
 * Two layers, both keyed per IP AND per device (the till's device login, or the
 * storefront's `gc_device` cookie), the strictest wins:
 *   - a request ceiling (every lookup counts), and
 *   - a FAILURE lockout: unknown codes count separately and lock the key out for
 *     the rest of the window once over the limit, even for a correct code, so a
 *     guesser cannot keep trying between successes.
 *
 * This class is the process-local layer (the burst cap; the routes use only
 * `admit`). The failure lockout the routes rely on lives in the DATABASE
 * (stored_value_guard via StoredValueStore.guardFail/guardCheck), shared across
 * instances and keyed on IP + tenant and device + tenant (giftcards/http.ts).
 * Disabled under tests/RATE_LIMIT_DISABLED like the other limiters; the classes
 * are unit-tested directly.
 */
import { RateLimiter, rateLimitEnabled, type RateLimitRule } from "@/lib/security/rate-limit";

export const LOOKUP_RULES = {
  /** Lookups per key per minute (staff tills check a few cards a minute). */
  requests: { limit: 30, windowMs: 60_000 } satisfies RateLimitRule,
  /** Unknown codes per key per 15 minutes before the key is locked out. */
  failures: { limit: 10, windowMs: 15 * 60_000 } satisfies RateLimitRule,
} as const;

export interface LookupIdentity {
  ip: string;
  /** Till device login id, or the storefront device cookie; null if none. */
  device: string | null;
  /** Till only: the PIN-switched staff member, if any. */
  staff?: string | null;
  /** Bucket prefix so storefront and till keys never share a window. */
  surface: "till" | "shop";
}

/**
 * The authenticated till is NOT keyed by IP (every tablet of a shop shares one
 * NAT address: one cashier's typos must not lock the whole shop out); it is
 * keyed by device login and by staff member. The anonymous storefront is keyed
 * by IP and by device cookie.
 */
export function identityKeys(id: LookupIdentity): string[] {
  const out: string[] = [];
  if (id.surface === "shop") out.push(`ip:${id.ip}`);
  if (id.device) out.push(`dev:${id.device}`);
  if (id.surface === "till" && id.staff) out.push(`staff:${id.staff}`);
  if (out.length === 0) out.push(`ip:${id.ip}`);
  return out.map((k) => `${id.surface}:${k}`);
}

function keys(id: LookupIdentity): string[] {
  return identityKeys(id).map((k) => `gc:${k}`);
}

export class LookupGuard {
  private readonly requests: RateLimiter;
  private readonly failures: RateLimiter;
  private readonly lockedUntil = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {
    this.requests = new RateLimiter(now);
    this.failures = new RateLimiter(now);
  }

  /** Count one lookup. Returns seconds to wait when refused, else 0. */
  admit(id: LookupIdentity): number {
    const t = this.now();
    let wait = 0;
    for (const k of keys(id)) {
      const until = this.lockedUntil.get(k);
      if (until && until > t) wait = Math.max(wait, Math.ceil((until - t) / 1000));
      else if (until) this.lockedUntil.delete(k);
    }
    if (wait > 0) return wait;
    for (const k of keys(id)) {
      const r = this.requests.check(k, LOOKUP_RULES.requests);
      if (!r.allowed) wait = Math.max(wait, r.retryAfterSeconds);
    }
    return wait;
  }

  /** Record an unknown / invalid code; locks the keys out once over the limit. */
  fail(id: LookupIdentity): void {
    for (const k of keys(id)) {
      const r = this.failures.check(k, LOOKUP_RULES.failures);
      if (!r.allowed) this.lockedUntil.set(k, r.resetAt);
    }
  }

  clear(): void {
    this.requests.clear();
    this.failures.clear();
    this.lockedUntil.clear();
  }
}

const shared = new LookupGuard();

/** The app's guard: a no-op when rate limiting is disabled (tests/dev flag). */
export const lookupGuard = {
  admit(id: LookupIdentity): number {
    return rateLimitEnabled() ? shared.admit(id) : 0;
  },
  fail(id: LookupIdentity): void {
    if (rateLimitEnabled()) shared.fail(id);
  },
};
