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
  it("pure gate", () => {
    expect(simulatedRailsAllowed({ driverName: "mock", realAuth: false })).toBe(true);
    expect(simulatedRailsAllowed({ driverName: "supabase", realAuth: false })).toBe(false);
    expect(simulatedRailsAllowed({ driverName: "mock", realAuth: true })).toBe(false);
    expect(
      simulatedRailsAllowed({ driverName: "supabase", realAuth: true, allowFlag: "true" }),
    ).toBe(true);
  });

  it("an anonymous online order can't be 'paid' on an unkeyed rail in real mode", async () => {
    const orderId = await onlineOrder();
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
    session.user = null;
    expect((await pay(orderId, "stripe_online")).status).toBe(503);
    expect((await pay(orderId, "crypto_onchain_usdc")).status).toBe(503);
    const order = await getPosDriver().getOrder(orderId);
    expect(order?.status).not.toBe("paid");

    // Explicit opt-in (training deployment) re-enables them.
    process.env.ALLOW_SIMULATED_PAYMENTS = "true";
    expect((await pay(orderId, "stripe_online")).status).toBe(201);
  });

  it("cash (a real rail) is unaffected", async () => {
    const orderId = await onlineOrder();
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
    session.user = owner;
    expect((await pay(orderId, "cash")).status).toBe(201);
  });
});
