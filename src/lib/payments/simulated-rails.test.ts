import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "@/lib/auth/session";

/**
 * Unkeyed (simulated) rails settle without moving money; they must be
 * refused whenever real auth or the real driver is active, unless
 * ALLOW_SIMULATED_PAYMENTS=true.
 */
const session = vi.hoisted(() => ({ user: null as SessionUser | null }));
vi.mock("@/lib/auth/session", () => ({
  getCurrentUser: vi.fn(async () => session.user),
}));

import {
  DEMO_LOCATION_DOWNTOWN_ID,
  DEMO_TENANT_ID,
  getPosDriver,
} from "@/lib/db";
import { POST as payPOST } from "@/app/api/payments/route";
import { simulatedRailsAllowed } from "./simulation";

const owner: SessionUser = {
  id: "sim-rail-owner",
  email: "sim@example.com",
  memberships: [
    {
      id: "m1",
      user_id: "sim-rail-owner",
      tenant_id: DEMO_TENANT_ID,
      role: "owner",
      created_at: "2025-01-01T00:00:00.000Z",
    },
  ],
  isPlatformAdmin: false,
  real: true,
};

afterEach(() => {
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  delete process.env.ALLOW_SIMULATED_PAYMENTS;
});

async function onlineOrder(): Promise<string> {
  // Ensure the mock driver is resolved BEFORE auth env is set in a test.
  const id = crypto.randomUUID();
  await getPosDriver().createOrder({
    id,
    tenant_id: DEMO_TENANT_ID,
    location_id: DEMO_LOCATION_DOWNTOWN_ID,
    channel: "online_pickup",
    currency: "USD",
    items: [],
    discount_cents: 0,
    totals: {
      subtotal_cents: 1000,
      discount_cents: 0,
      taxable_cents: 1000,
      tax_cents: 0,
      tip_cents: 0,
      total_cents: 1000,
    },
    notes: null,
  });
  return id;
}

const pay = (orderId: string, rail: string) =>
  payPOST(
    new Request("http://localhost/api/payments", {
      method: "POST",
      body: JSON.stringify({
        paymentId: crypto.randomUUID(),
        orderId,
        rail,
      }),
    }),
  );

describe("simulated rails", () => {
  it("pure gate: demo always; the opt-in flag only for staff tenders", () => {
    expect(simulatedRailsAllowed({ driverName: "mock", realAuth: false })).toBe(true);
    expect(simulatedRailsAllowed({ driverName: "supabase", realAuth: false })).toBe(false);
    expect(simulatedRailsAllowed({ driverName: "mock", realAuth: true })).toBe(false);
    expect(
      simulatedRailsAllowed({ driverName: "supabase", realAuth: true, allowFlag: "true" }),
    ).toBe(false);
    expect(
      simulatedRailsAllowed({
        driverName: "supabase",
        realAuth: true,
        allowFlag: "true",
        staff: true,
      }),
    ).toBe(true);
  });

  it("an anonymous online order can't be 'paid' on an unkeyed rail in real mode — even with the flag", async () => {
    const orderId = await onlineOrder();
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
    session.user = null;
    expect((await pay(orderId, "stripe_online")).status).toBe(503);
    expect((await pay(orderId, "crypto_onchain_usdc")).status).toBe(503);
    process.env.ALLOW_SIMULATED_PAYMENTS = "true";
    expect((await pay(orderId, "stripe_online")).status).toBe(503);
    const order = await getPosDriver().getOrder(orderId);
    expect(order?.status).not.toBe("paid");
  });

  it("the training opt-in applies to staff tenders only", async () => {
    const orderId = await onlineOrder();
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
    session.user = owner;
    expect((await pay(orderId, "stripe_terminal")).status).toBe(503);
    process.env.ALLOW_SIMULATED_PAYMENTS = "true";
    expect((await pay(orderId, "stripe_terminal")).status).toBe(201);
  });

  it("cash (a real rail) is unaffected", async () => {
    const orderId = await onlineOrder();
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
    session.user = owner;
    expect((await pay(orderId, "cash")).status).toBe(201);
  });

  it("the storefront hides unusable rails and refuses to create an order it can't take payment for", async () => {
    const { GET: locationGET } = await import("@/app/api/shop/location/route");
    const { POST: shopOrdersPOST } = await import("@/app/api/shop/orders/route");
    const { GET: readyGET } = await import("@/app/api/ready/route");
    const body = (rail?: string) => ({
      id: crypto.randomUUID(),
      tenantSlug: "tonys-pizza",
      locationSlug: "tonys-uptown",
      items: [
        {
          id: "l1",
          item_id: "30000000-0000-0000-0000-000000000010",
          size_id: "40000000-0000-0000-0000-000000000021",
          quantity: 1,
          modifiers: [],
        },
      ],
      fulfillmentType: "pickup",
      scheduledFor: "asap",
      customer: { email: "rails@example.com" },
      rail,
    });
    const place = (rail?: string) =>
      shopOrdersPOST(
        new Request("http://localhost/api/shop/orders", {
          method: "POST",
          body: JSON.stringify(body(rail)),
        }),
      );

    // Demo: rails offered.
    let loc = await locationGET(
      new Request("http://localhost/api/shop/location?tenant=tonys-pizza&location=tonys-uptown"),
    );
    expect(((await loc.json()) as { onlineRails: string[] }).onlineRails).toContain(
      "stripe_online",
    );

    // Real auth, no keys: nothing offered; order creation refused up front.
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
    process.env.ALLOW_SIMULATED_PAYMENTS = "true"; // never applies to customers
    loc = await locationGET(
      new Request("http://localhost/api/shop/location?tenant=tonys-pizza&location=tonys-uptown"),
    );
    expect(((await loc.json()) as { onlineRails: string[] }).onlineRails).toEqual([]);
    const before = (await getPosDriver().listOrders(DEMO_TENANT_ID, "10000000-0000-0000-0000-000000000102")).length;
    expect((await place("stripe_online")).status).toBe(503);
    expect((await place()).status).toBe(503);
    const after = (await getPosDriver().listOrders(DEMO_TENANT_ID, "10000000-0000-0000-0000-000000000102")).length;
    expect(after).toBe(before);

    const ready = (await (
      await readyGET(new Request("http://localhost/api/ready"))
    ).json()) as {
      simulatedPayments: {
        allowSimulatedPaymentsFlag: boolean;
        simulatedAllowedForStaff: boolean;
        simulatedAllowedForCustomers: boolean;
      };
    };
    expect(ready.simulatedPayments).toMatchObject({
      allowSimulatedPaymentsFlag: true,
      simulatedAllowedForStaff: true,
      simulatedAllowedForCustomers: false,
    });
  });
});
