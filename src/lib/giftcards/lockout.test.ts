import { describe, expect, it } from "vitest";
import { LOOKUP_RULES, LookupGuard } from "./lockout";

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

const A = { ip: "1.1.1.1", device: "dev-a", surface: "shop" as const };

describe("LookupGuard", () => {
  it("caps lookups per window, per IP and per device", () => {
    const c = clock();
    const g = new LookupGuard(c.now);
    for (let i = 0; i < LOOKUP_RULES.requests.limit; i += 1) expect(g.admit(A)).toBe(0);
    expect(g.admit(A)).toBeGreaterThan(0);
    // Rotating IPs does not escape the device limit...
    expect(g.admit({ ...A, ip: "2.2.2.2" })).toBeGreaterThan(0);
    // ...and rotating devices does not escape the IP limit.
    expect(g.admit({ ...A, device: "dev-b" })).toBeGreaterThan(0);
    c.advance(LOOKUP_RULES.requests.windowMs);
    expect(g.admit(A)).toBe(0);
  });

  it("locks a key out after too many unknown codes, even for a correct code", () => {
    const c = clock();
    const g = new LookupGuard(c.now);
    for (let i = 0; i < LOOKUP_RULES.failures.limit; i += 1) {
      expect(g.admit(A)).toBe(0);
      g.fail(A);
      c.advance(10_000); // stay under the request ceiling
    }
    expect(g.admit(A)).toBe(0); // at the limit, not over it
    g.fail(A);
    const wait = g.admit(A);
    expect(wait).toBeGreaterThan(0);
    expect(g.admit({ ...A, ip: "9.9.9.9" })).toBeGreaterThan(0); // device still locked
    c.advance(LOOKUP_RULES.failures.windowMs);
    expect(g.admit(A)).toBe(0);
  });

  it("keeps the till and the storefront apart", () => {
    const g = new LookupGuard(clock().now);
    for (let i = 0; i <= LOOKUP_RULES.failures.limit; i += 1) g.fail(A);
    expect(g.admit(A)).toBeGreaterThan(0);
    expect(g.admit({ ...A, surface: "till" })).toBe(0);
  });
});
