import { describe, it, expect, beforeEach } from "vitest";
import { clientIp, enforceRateLimit } from "./http";
import { defaultLimiter } from "./rate-limit";

function req(headers: Record<string, string> = {}): Request {
  return new Request("https://pos.example/api/x", { method: "POST", headers });
}

describe("clientIp", () => {
  it("takes the first hop of x-forwarded-for", () => {
    expect(
      clientIp(new Headers({ "x-forwarded-for": "1.2.3.4, 5.6.7.8" })),
    ).toBe("1.2.3.4");
  });

  it("falls back to x-real-ip then 'unknown'", () => {
    expect(clientIp(new Headers({ "x-real-ip": "9.9.9.9" }))).toBe("9.9.9.9");
    expect(clientIp(new Headers())).toBe("unknown");
  });
});

describe("enforceRateLimit", () => {
  beforeEach(() => {
    defaultLimiter.clear();
  });

  it("is a no-op under tests — never throttles the zero-env suite/build", () => {
    // VITEST is set in this environment ⇒ rateLimitEnabled() is false, so even a
    // flood from one IP against the strictest bucket must always proceed (null).
    for (let i = 0; i < 1000; i++) {
      expect(
        enforceRateLimit(req({ "x-forwarded-for": "1.1.1.1" }), "pin"),
      ).toBe(null);
    }
  });

  it("returns null (proceed) for a single well-formed request", () => {
    expect(enforceRateLimit(req({ "x-real-ip": "3.3.3.3" }), "orders")).toBe(
      null,
    );
  });
});
