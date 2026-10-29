import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "@/lib/auth/session";

/**
 * Route-level money checks: the payment amount comes from the stored order
 * balance (client amounts must match), tenant/location come from the order,
 * and order creation re-prices tampered lines. Session is mocked; the driver
 * is the in-memory mock.
 */
const session = vi.hoisted(() => ({ user: null as SessionUser | null }));
vi.mock("@/lib/auth/session", () => ({
  getCurrentUser: vi.fn(async () => session.user),
}));

import {
  DEMO_LOCATION_DOWNTOWN_ID,
  DEMO_TENANT_ID,
  getPosDriver,
  type Order,
} from "@/lib/db";
import { POST as payPOST } from "@/app/api/payments/route";
import { POST as ordersPOST } from "@/app/api/orders/route";
import { POST as shopOrdersPOST } from "@/app/api/shop/orders/route";

const PEPPERONI = "30000000-0000-0000-0000-000000000002";
const PEPPERONI_SMALL = "40000000-0000-0000-0000-000000000011";

function owner(role: "owner" | "cashier" = "owner"): SessionUser {
  return {
    id: "pay-test-user",
    email: "pay@example.com",
    memberships: [
      {
        id: "m1",
        user_id: "pay-test-user",
        tenant_id: DEMO_TENANT_ID,
        role,
        created_at: "2025-01-01T00:00:00.000Z",
      },
    ],
    isPlatformAdmin: false,
    real: true,
  };
}

let seq = 0;
const uid = (p: string) => `${p}-${Date.now().toString(36)}-${(seq += 1)}`;

function line(overrides: Record<string, unknown> = {}) {
  return {
    id: uid("line"),
    item_id: PEPPERONI,
    item_name: "Pepperoni",
    size_id: PEPPERONI_SMALL,
    size_name: "Small",
    base_price_cents: 1, // tampered
    quantity: 1,
    modifiers: [],
    notes: null,
    voided: false,
    unit_price_cents: 1,
    line_total_cents: 1,
    ...overrides,
  };
}

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});

async function placeTerminalOrder(extra: Record<string, unknown> = {}) {
  session.user = owner();
  const res = await ordersPOST(
    new Request("http://localhost/api/orders", json({
      id: uid("order"),
      tenant_id: DEMO_TENANT_ID,
      location_id: DEMO_LOCATION_DOWNTOWN_ID,
      currency: "USD",
      channel: "online_delivery", // tampered — forced to in_store
      items: [line()],
      totals: { total_cents: 1 }, // tampered — ignored
      ...extra,
    })),
  );
  return res;
}

beforeEach(() => {
  session.user = null;
});
afterEach(() => {
  vi.useRealTimers();
});

describe("POST /api/orders (terminal) re-prices server-side", () => {
  it("ignores client prices/totals and forces the in-store channel", async () => {
    const res = await placeTerminalOrder();
    expect(res.status).toBe(201);
    const { order } = (await res.json()) as { order: Order };
    expect(order.channel).toBe("in_store");
    expect(order.items[0]!.unit_price_cents).toBe(1299);
    expect(order.totals.subtotal_cents).toBe(1299);
    expect(order.totals.total_cents).toBeGreaterThanOrEqual(1299);
  });

  it("gates discounts by role", async () => {
    session.user = owner("cashier");
    const res = await ordersPOST(
      new Request("http://localhost/api/orders", json({
        id: uid("order"),
        tenant_id: DEMO_TENANT_ID,
        location_id: DEMO_LOCATION_DOWNTOWN_ID,
        currency: "USD",
        items: [line()],
        discount_cents: 500,
        totals: {},
      })),
    );
    expect(res.status).toBe(403);

    const asOwner = await placeTerminalOrder({ discount_cents: 99_999 });
    const { order } = (await asOwner.json()) as { order: Order };
    // Clamped to the server subtotal.
    expect(order.totals.discount_cents).toBe(1299);
  });

  it("rejects unknown items with 422", async () => {
    const res = await placeTerminalOrder({ items: [line({ item_id: "nope" })] });
    expect(res.status).toBe(422);
  });
});

describe("POST /api/payments derives the amount from the order balance", () => {
  async function newOrder(): Promise<Order> {
    const res = await placeTerminalOrder();
    return ((await res.json()) as { order: Order }).order;
  }

  it("rejects an amount above the balance and a tenant mismatch", async () => {
    const order = await newOrder();
    session.user = owner();
    const over = await payPOST(
      new Request("http://localhost/api/payments", json({
        paymentId: uid("pay"),
        orderId: order.id,
        rail: "cash",
        amountCents: order.totals.total_cents + 1,
      })),
    );
    expect(over.status).toBe(422);

    const mismatch = await payPOST(
      new Request("http://localhost/api/payments", json({
        paymentId: uid("pay"),
        orderId: order.id,
        tenantId: "some-other-tenant",
        rail: "cash",
        amountCents: 100,
      })),
    );
    expect(mismatch.status).toBe(422);
  });

  it("requires a staff session for in-store orders", async () => {
    const order = await newOrder();
    session.user = null;
    const res = await payPOST(
      new Request("http://localhost/api/payments", json({
        paymentId: uid("pay"),
        orderId: order.id,
        rail: "stripe_online",
      })),
    );
    expect(res.status).toBe(401);
  });

  it("charges the full balance when no amount is sent, then refuses overpayment", async () => {
    const order = await newOrder();
    session.user = owner();
    const ok = await payPOST(
      new Request("http://localhost/api/payments", json({
        paymentId: uid("pay"),
        orderId: order.id,
        rail: "cash",
        tipCents: 200,
      })),
    );
    expect(ok.status).toBe(201);
    const body = (await ok.json()) as {
      payment: { amount_cents: number; tip_cents: number; tenant_id: string };
      balanceCents: number;
    };
    expect(body.payment.amount_cents).toBe(order.totals.total_cents);
    expect(body.payment.tip_cents).toBe(200);
    expect(body.payment.tenant_id).toBe(DEMO_TENANT_ID);
    expect(body.balanceCents).toBe(0);

    const again = await payPOST(
      new Request("http://localhost/api/payments", json({
        paymentId: uid("pay"),
        orderId: order.id,
        rail: "cash",
        amountCents: 100,
      })),
    );
    expect(again.status).toBe(409);
  });

  it("bounds tips", async () => {
    const order = await newOrder();
    session.user = owner();
    const res = await payPOST(
      new Request("http://localhost/api/payments", json({
        paymentId: uid("pay"),
        orderId: order.id,
        rail: "cash",
        tipCents: 10_000_000,
      })),
    );
    expect(res.status).toBe(422);
  });
});

describe("storefront order + anonymous payment", () => {
  it("re-prices tampered shop lines and only lets the customer pay the exact balance online", async () => {
    // Pin "now" inside the seeded store hours (11:00–22:00 America/New_York).
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-03T18:00:00.000Z"));
    session.user = null;
    const orderId = crypto.randomUUID();
    const placed = await shopOrdersPOST(
      new Request("http://localhost/api/shop/orders", json({
        id: orderId,
        tenantSlug: "tonys-pizza",
        locationSlug: "tonys-uptown",
        items: [line()],
        fulfillmentType: "pickup",
        scheduledFor: "asap",
        customer: { email: "shopper@example.com" },
        tipCents: 300,
      })),
    );
    vi.useRealTimers();
    expect(placed.status).toBe(201);
    const { order } = (await placed.json()) as { order: Order };
    expect(order.items[0]!.unit_price_cents).toBe(1299);
    expect(order.totals.subtotal_cents).toBe(1299);
    expect(order.totals.tip_cents).toBe(300);

    // Anonymous customer: cash is not allowed, partial amounts are rejected,
    // a separate tender tip is rejected (tip already on the order).
    const cash = await payPOST(
      new Request("http://localhost/api/payments", json({
        paymentId: uid("pay"),
        orderId,
        rail: "cash",
      })),
    );
    expect(cash.status).toBe(401);

    const partial = await payPOST(
      new Request("http://localhost/api/payments", json({
        paymentId: uid("pay"),
        orderId,
        rail: "stripe_online",
        amountCents: 1,
      })),
    );
    expect(partial.status).toBe(422);

    const doubleTip = await payPOST(
      new Request("http://localhost/api/payments", json({
        paymentId: uid("pay"),
        orderId,
        rail: "stripe_online",
        amountCents: order.totals.total_cents,
        tipCents: 300,
      })),
    );
    expect(doubleTip.status).toBe(422);

    const full = await payPOST(
      new Request("http://localhost/api/payments", json({
        paymentId: uid("pay"),
        orderId,
        rail: "stripe_online",
        amountCents: order.totals.total_cents,
        tipCents: 0,
      })),
    );
    expect(full.status).toBe(201);
    const driverOrder = await getPosDriver().getOrder(orderId);
    expect(driverOrder?.tenant_id).toBe(DEMO_TENANT_ID);
  });
});
