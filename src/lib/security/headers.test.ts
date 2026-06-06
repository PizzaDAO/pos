import { describe, it, expect } from "vitest";
import {
  CONTENT_SECURITY_POLICY,
  CSP_DIRECTIVES,
  SECURITY_HEADERS,
} from "./headers";

describe("CSP", () => {
  it("locks down the dangerous defaults", () => {
    expect(CSP_DIRECTIVES["default-src"]).toEqual(["'self'"]);
    expect(CSP_DIRECTIVES["object-src"]).toEqual(["'none'"]);
    expect(CSP_DIRECTIVES["frame-ancestors"]).toEqual(["'none'"]);
    expect(CSP_DIRECTIVES["base-uri"]).toEqual(["'self'"]);
    expect(CSP_DIRECTIVES["form-action"]).toEqual(["'self'"]);
  });

  it("allows the Supabase + Stripe runtime integrations in connect-src", () => {
    const connect = (CSP_DIRECTIVES["connect-src"] ?? []).join(" ");
    expect(connect).toContain("https://*.supabase.co");
    expect(connect).toContain("wss://*.supabase.co");
    expect(connect).toContain("https://api.stripe.com");
  });

  it("serializes to a single-line policy with all directives", () => {
    for (const key of Object.keys(CSP_DIRECTIVES)) {
      expect(CONTENT_SECURITY_POLICY).toContain(key);
    }
    expect(CONTENT_SECURITY_POLICY).toContain("upgrade-insecure-requests");
    expect(CONTENT_SECURITY_POLICY).not.toContain("\n");
  });
});

describe("SECURITY_HEADERS", () => {
  const byKey = Object.fromEntries(
    SECURITY_HEADERS.map((h) => [h.key, h.value]),
  );

  it("includes the standard hardening headers", () => {
    expect(byKey["Content-Security-Policy"]).toBe(CONTENT_SECURITY_POLICY);
    expect(byKey["X-Content-Type-Options"]).toBe("nosniff");
    expect(byKey["X-Frame-Options"]).toBe("DENY");
    expect(byKey["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
    expect(byKey["Strict-Transport-Security"]).toContain("max-age=");
    expect(byKey["Permissions-Policy"]).toContain("camera=()");
  });

  it("has no duplicate header keys", () => {
    const keys = SECURITY_HEADERS.map((h) => h.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
