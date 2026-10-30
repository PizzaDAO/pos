import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { isNetworkOnlyPath, isStripeOrigin } from "./sw-routes";

describe("service worker NetworkOnly matchers", () => {
  it("never caches terminal, payment or admin-terminal API state", () => {
    expect(isNetworkOnlyPath("/api/terminal/payments/abc")).toBe(true);
    expect(isNetworkOnlyPath("/api/terminal/readers")).toBe(true);
    expect(isNetworkOnlyPath("/api/admin/terminal")).toBe(true);
    expect(isNetworkOnlyPath("/api/admin/terminal/readers/tmr_1")).toBe(true);
    expect(isNetworkOnlyPath("/api/payments/status")).toBe(true);
    expect(isNetworkOnlyPath("/api/payments/refund")).toBe(true);
  });

  it("keeps the staff picker and the checkout balance load on defaultCache", () => {
    expect(isNetworkOnlyPath("/api/terminal/pin")).toBe(false);
    expect(isNetworkOnlyPath("/api/payments")).toBe(false);
  });

  it("leaves the menu (StaleWhileRevalidate) and pages alone", () => {
    expect(isNetworkOnlyPath("/api/menu")).toBe(false);
    expect(isNetworkOnlyPath("/terminal")).toBe(false);
    expect(isNetworkOnlyPath("/api/orders")).toBe(false);
  });

  it("matches Stripe origins only", () => {
    expect(isStripeOrigin("js.stripe.com")).toBe(true);
    expect(isStripeOrigin("api.stripe.com")).toBe(true);
    expect(isStripeOrigin("stripe.com")).toBe(true);
    expect(isStripeOrigin("notstripe.com")).toBe(false);
    expect(isStripeOrigin("stripe.com.evil.test")).toBe(false);
  });

  it("sw.ts registers the NetworkOnly rules before defaultCache", () => {
    const src = readFileSync(join(process.cwd(), "src/app/sw.ts"), "utf8");
    const networkOnly = src.indexOf("isNetworkOnlyPath(url.pathname)");
    const stripe = src.indexOf("isStripeOrigin(url.hostname)");
    const spread = src.indexOf("...defaultCache");
    expect(networkOnly).toBeGreaterThan(-1);
    expect(stripe).toBeGreaterThan(networkOnly);
    expect(spread).toBeGreaterThan(stripe);
  });
});
