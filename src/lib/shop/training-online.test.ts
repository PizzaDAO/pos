/**
 * Audit H3: in training mode on a LIVE database, anonymous simulated online
 * payments are refused unless the tenant is the demo tenant or listed in
 * TRAINING_ONLINE_TENANTS. Staff-side tenders (in-store, cash) are untouched.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getPosDriver,
  type CreateOrderInput,
  type OrderChannel,
} from "@/lib/db";

// The "live database" switch. Only the gate's view of the driver changes; the
// data itself stays on the in-memory mock driver.
const live = vi.hoisted(() => ({ on: false }));
vi.mock("@/lib/payments/env", async (orig) => {
  const actual = await orig<typeof import("@/lib/payments/env")>();
  return { ...actual, usingMockDriver: () => !live.on };
});

// A storefront that belongs to a non-demo tenant (the mock seed has only Tony's).
vi.mock("@/lib/shop/resolve-location", async (orig) => {
  const actual = await orig<typeof import("@/lib/shop/resolve-location")>();
  return {
    ...actual,
    resolveStorefrontLocation: async (input: {
      tenantSlug?: string | null;
      locationSlug?: string | null;
    }) =>
      input.locationSlug === "real-store"
        ? {
            ok: true,
            location: {
              id: "20000000-0000-4000-8000-0000000000bb",
              tenant_id: "20000000-0000-4000-8000-0000000000aa",
              slug: "real-store",
            },
          }
        : actual.resolveStorefrontLocation(input as never),
  };
});

const requireTenantRole = vi.fn();
vi.mock("@/lib/auth/api", () => ({
  requireTenantMember: vi.fn(),
  requireTenantRole: (...a: unknown[]) => requireTenantRole(...a),
}));

import {
  anyOnlinePaymentAllowed,
  onlinePaymentAllowed,
  onlineRailSimulated,
  trainingOnlineTenants,
} from "./training-online";
import { POST as paymentsPOST } from "@/app/api/payments/route";
import { POST as shopOrdersPOST } from "@/app/api/shop/orders/route";

const DEMO = "10000000-0000-0000-0000-000000000001";
const DEMO_LOCATION = "10000000-0000-0000-0000-000000000101";
const REAL = "20000000-0000-4000-8000-0000000000aa";
const REAL_LOCATION = "20000000-0000-4000-8000-0000000000bb";

let seq = 0;

async function seedOrder(
  tenant: string,
  location: string,
  channel: OrderChannel,
): Promise<string> {
  seq += 1;
  const id = `h3-${seq}-${Math.random().toString(36).slice(2)}`;
  const input: CreateOrderInput = {
    id,
    tenant_id: tenant,
    location_id: location,
    channel,
    currency: "USD",
    items: [
      {
        id: "l1",
        item_id: "i1",
        item_name: "Pizza",
        size_id: null,
        size_name: null,
        base_price_cents: 1000,
        quantity: 1,
        modifiers: [],
        notes: null,
        voided: false,
        unit_price_cents: 1000,
        line_total_cents: 1000,
      },
    ],
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
    status: "placed",
  };
  await getPosDriver().createOrder(input);
  return id;
}

function pay(orderId: string, tenant: string, location: string, rail: string) {
  return paymentsPOST(
    new Request("http://localhost/api/payments", {
      method: "POST",
      headers: { "x-forwarded-for": `10.3.${seq % 250}.${seq % 200}` },
      body: JSON.stringify({
        paymentId: crypto.randomUUID(),
        orderId,
        tenantId: tenant,
        locationId: location,
        rail,
        amountCents: 1000,
        currency: "USD",
      }),
    }),
  );
}

beforeEach(() => {
  live.on = false;
  vi.stubEnv("TRAINING_MODE", "1");
  vi.stubEnv("TRAINING_ONLINE_TENANTS", "");
  vi.stubEnv("STRIPE_SECRET_KEY", "");
  vi.stubEnv("BASE_RPC_URL", "");
  vi.stubEnv("COINBASE_COMMERCE_API_KEY", "");
  requireTenantRole.mockResolvedValue({ ok: true, session: {}, role: "cashier" });
});
afterEach(() => {
  vi.unstubAllEnvs();
  requireTenantRole.mockReset();
});

describe("training-online gate (pure)", () => {
  it("allows everything on the mock driver", () => {
    expect(onlinePaymentAllowed(REAL, "stripe_online")).toBe(true);
    expect(anyOnlinePaymentAllowed(REAL)).toBe(true);
  });

  it("refuses a simulated rail at a non-demo tenant on a live driver", () => {
    live.on = true;
    expect(onlineRailSimulated("stripe_online")).toBe(true);
    expect(onlinePaymentAllowed(REAL, "stripe_online")).toBe(false);
    expect(onlinePaymentAllowed(REAL, "crypto_onchain_usdc")).toBe(false);
    expect(onlinePaymentAllowed(REAL, "crypto_coinbase")).toBe(false);
    expect(anyOnlinePaymentAllowed(REAL)).toBe(false);
  });

  it("keeps the demo tenant and TRAINING_ONLINE_TENANTS allowed", () => {
    live.on = true;
    expect(onlinePaymentAllowed(DEMO, "stripe_online")).toBe(true);
    vi.stubEnv("TRAINING_ONLINE_TENANTS", ` other , ${REAL.toUpperCase()} `);
    expect(trainingOnlineTenants().has(REAL)).toBe(true);
    expect(onlinePaymentAllowed(REAL, "stripe_online")).toBe(true);
  });

  it("never gates a rail that would really charge, or cash", () => {
    live.on = true;
    vi.stubEnv("BASE_RPC_URL", "https://rpc.example");
    expect(onlineRailSimulated("crypto_onchain_usdc")).toBe(false);
    expect(onlinePaymentAllowed(REAL, "crypto_onchain_usdc")).toBe(true);
    expect(anyOnlinePaymentAllowed(REAL)).toBe(true);
    expect(onlinePaymentAllowed(REAL, "cash")).toBe(true);
  });
});

describe("POST /api/payments with the training gate", () => {
  it("refuses an anonymous simulated online card tender at a real tenant (503)", async () => {
    const id = await seedOrder(REAL, REAL_LOCATION, "online_pickup");
    live.on = true;
    const res = await pay(id, REAL, REAL_LOCATION, "stripe_online");
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe("online_payment_unavailable");
    expect(body.error).toMatch(/online payment is unavailable/i);
    expect(await getPosDriver().listPaymentsForOrder(id)).toHaveLength(0);
    expect((await getPosDriver().getOrder(id))?.status).toBe("placed");
  });

  it("still takes a simulated online tender at the demo tenant", async () => {
    const id = await seedOrder(DEMO, DEMO_LOCATION, "online_pickup");
    live.on = true;
    const res = await pay(id, DEMO, DEMO_LOCATION, "stripe_online");
    expect(res.status).toBe(201);
  });

  it("still takes it for a tenant listed in TRAINING_ONLINE_TENANTS", async () => {
    const id = await seedOrder(REAL, REAL_LOCATION, "online_pickup");
    live.on = true;
    vi.stubEnv("TRAINING_ONLINE_TENANTS", REAL);
    const res = await pay(id, REAL, REAL_LOCATION, "stripe_online");
    expect(res.status).not.toBe(503);
  });

  it("leaves staff-side simulated tenders alone (in-store card)", async () => {
    const id = await seedOrder(REAL, REAL_LOCATION, "in_store");
    live.on = true;
    const res = await pay(id, REAL, REAL_LOCATION, "stripe_terminal");
    expect(res.status).not.toBe(503);
    expect(requireTenantRole).toHaveBeenCalled();
  });
});

describe("POST /api/shop/orders with the training gate", () => {
  function intake(locationSlug: string) {
    seq += 1;
    return shopOrdersPOST(
      new Request("http://localhost/api/shop/orders", {
        method: "POST",
        headers: { "x-forwarded-for": `10.9.${seq % 250}.9` },
        body: JSON.stringify({
          id: crypto.randomUUID(),
          locationSlug,
          items: [],
          fulfillmentType: "pickup",
          scheduledFor: "asap",
          customer: { email: `h3-${seq}@example.com` },
        }),
      }),
    );
  }

  it("refuses intake at a real tenant before an order is created (503)", async () => {
    live.on = true;
    const res = await intake("real-store");
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("online_payment_unavailable");
  });

  it("does not refuse the demo tenant (fails later, on the empty cart)", async () => {
    live.on = true;
    const res = await intake("tonys-uptown");
    expect(res.status).not.toBe(503);
  });
});
