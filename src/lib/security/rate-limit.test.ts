import { describe, it, expect } from "vitest";
import { RateLimiter, RATE_LIMIT_RULES } from "./rate-limit";

describe("RateLimiter", () => {
  it("allows requests up to the limit, then blocks", () => {
    const rl = new RateLimiter(() => 1_000);
    const rule = { limit: 3, windowMs: 60_000 };
    expect(rl.check("k", rule).allowed).toBe(true);
    expect(rl.check("k", rule).allowed).toBe(true);
    const third = rl.check("k", rule);
    expect(third.allowed).toBe(true);
    expect(third.remaining).toBe(0);
    const fourth = rl.check("k", rule);
    expect(fourth.allowed).toBe(false);
    expect(fourth.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  it("reports decreasing remaining and a stable reset within a window", () => {
    let now = 0;
    const rl = new RateLimiter(() => now);
    const rule = { limit: 5, windowMs: 10_000 };
    const a = rl.check("k", rule);
    expect(a.remaining).toBe(4);
    expect(a.resetAt).toBe(10_000);
    now = 5_000;
    const b = rl.check("k", rule);
    expect(b.remaining).toBe(3);
    expect(b.resetAt).toBe(10_000); // same window
  });

  it("resets the window after it elapses", () => {
    let now = 0;
    const rl = new RateLimiter(() => now);
    const rule = { limit: 1, windowMs: 1_000 };
    expect(rl.check("k", rule).allowed).toBe(true);
    expect(rl.check("k", rule).allowed).toBe(false);
    now = 1_001; // window elapsed
    const after = rl.check("k", rule);
    expect(after.allowed).toBe(true);
    expect(after.resetAt).toBe(1_001 + 1_000);
  });

  it("tracks keys independently", () => {
    const rl = new RateLimiter(() => 0);
    const rule = { limit: 1, windowMs: 1_000 };
    expect(rl.check("a", rule).allowed).toBe(true);
    expect(rl.check("b", rule).allowed).toBe(true); // different key, fresh
    expect(rl.check("a", rule).allowed).toBe(false);
  });

  it("reset() forgets a key so the next caller starts fresh", () => {
    const rl = new RateLimiter(() => 0);
    const rule = { limit: 1, windowMs: 1_000 };
    expect(rl.check("a", rule).allowed).toBe(true);
    expect(rl.check("a", rule).allowed).toBe(false);
    rl.reset("a");
    expect(rl.check("a", rule).allowed).toBe(true);
  });

  it("retryAfterSeconds reflects time left in the window", () => {
    let now = 0;
    const rl = new RateLimiter(() => now);
    const rule = { limit: 1, windowMs: 30_000 };
    rl.check("k", rule); // consume
    now = 5_000;
    const blocked = rl.check("k", rule);
    expect(blocked.allowed).toBe(false);
    // 25s left → ceil(25000/1000) = 25
    expect(blocked.retryAfterSeconds).toBe(25);
  });

  it("named rules are sane (positive limits + windows)", () => {
    for (const rule of Object.values(RATE_LIMIT_RULES)) {
      expect(rule.limit).toBeGreaterThan(0);
      expect(rule.windowMs).toBeGreaterThan(0);
    }
  });
});
