import { describe, expect, it } from "vitest";
import { DEMO_LOCATION_UPTOWN_ID, DEMO_TENANT_ID, getPosDriver } from "@/lib/db";
import LegacyShopPage from "@/app/(shop)/shop/[tenant]/page";
import LegacyTrackPage from "@/app/(shop)/shop/[tenant]/track/[orderId]/page";
import { withSearchParams } from "./storefront";

/** Legacy storefront / tracking redirects keep the query string. */

/** The URL a Next.js `redirect()` threw, or null. */
async function redirectTarget(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (err) {
    const digest = (err as { digest?: string }).digest ?? "";
    if (!digest.startsWith("NEXT_REDIRECT")) throw err;
    return digest.split(";")[2] ?? null;
  }
}

describe("withSearchParams", () => {
  it("appends Next searchParams (incl. repeated keys) and URLSearchParams", () => {
    expect(withSearchParams("/shop/a/b", { utm: "x", tag: ["1", "2"], none: undefined })).toBe(
      "/shop/a/b?utm=x&tag=1&tag=2",
    );
    expect(withSearchParams("/p?a=1", new URLSearchParams("b=2"))).toBe("/p?a=1&b=2");
    expect(withSearchParams("/p", {})).toBe("/p");
    expect(withSearchParams("/p", undefined)).toBe("/p");
    expect(withSearchParams("/p", { q: "a b&c" })).toBe("/p?q=a+b%26c");
  });
});

describe("legacy redirects preserve the query string", () => {
  it("/shop/{locationSlug}?… → /shop/{tenant}/{location}?…", async () => {
    // tonys-uptown is held by exactly one location → redirect.
    const target = await redirectTarget(() =>
      LegacyShopPage({
        params: Promise.resolve({ tenant: "tonys-uptown" }),
        searchParams: Promise.resolve({ utm_source: "flyer", ref: "qr" }),
      }),
    );
    expect(target).toBe("/shop/tonys-pizza/tonys-uptown?utm_source=flyer&ref=qr");
  });

  it("/shop/{slug}/track/{id}?… → canonical track URL with the query", async () => {
    const driver = getPosDriver();
    const order = await driver.createOrder({
      id: `legacy-track-${Date.now()}`,
      tenant_id: DEMO_TENANT_ID,
      location_id: DEMO_LOCATION_UPTOWN_ID,
      channel: "online_pickup",
      currency: "USD",
      items: [],
      discount_cents: 0,
      totals: {
        subtotal_cents: 0,
        discount_cents: 0,
        taxable_cents: 0,
        tax_cents: 0,
        tip_cents: 0,
        total_cents: 0,
      },
      notes: null,
    });
    const target = await redirectTarget(() =>
      LegacyTrackPage({
        params: Promise.resolve({ tenant: "tonys-uptown", orderId: order.id }),
        searchParams: Promise.resolve({ payment: "return", session: "abc" }),
      }),
    );
    expect(target).toBe(
      `/shop/tonys-pizza/tonys-uptown/track/${encodeURIComponent(order.id)}?payment=return&session=abc`,
    );
  });
});
