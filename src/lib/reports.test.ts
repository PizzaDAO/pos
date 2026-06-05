import { describe, it, expect } from "vitest";
import { buildSalesReport } from "@/lib/reports";
import type { Order, OrderItem, Payment } from "@/lib/db";

const RANGE = { from: "2026-06-01", to: "2026-06-30" };

function item(over: Partial<OrderItem>): OrderItem {
  return {
    id: "li",
    item_id: "i1",
    item_name: "Margherita",
    size_id: "s1",
    size_name: "L",
    base_price_cents: 1000,
    quantity: 1,
    modifiers: [],
    notes: null,
    voided: false,
    unit_price_cents: 1000,
    line_total_cents: 1000,
    ...over,
  };
}

function order(over: Partial<Order>): Order {
  return {
    id: "o",
    tenant_id: "t1",
    location_id: "locA",
    status: "paid",
    channel: "in_store",
    currency: "USD",
    items: [item({})],
    discount_cents: 0,
    totals: {
      subtotal_cents: 1000,
      discount_cents: 0,
      taxable_cents: 1000,
      tax_cents: 80,
      tip_cents: 0,
      total_cents: 1080,
    },
    notes: null,
    order_number: "A-0001",
    created_at: "2026-06-10T12:00:00.000Z",
    updated_at: "2026-06-10T12:00:00.000Z",
    ...over,
  };
}

function payment(over: Partial<Payment>): Payment {
  return {
    id: "p",
    order_id: "o",
    tenant_id: "t1",
    location_id: "locA",
    rail: "cash",
    status: "captured",
    amount_cents: 1080,
    tip_cents: 0,
    application_fee_cents: 0,
    currency: "USD",
    charge_id: null,
    connect_account_id: null,
    crypto_tx_hash: null,
    crypto_chain: null,
    cash_tendered_cents: null,
    cash_change_cents: null,
    refunded_cents: 0,
    simulated: true,
    raw: null,
    created_at: "2026-06-10T12:00:00.000Z",
    updated_at: "2026-06-10T12:00:00.000Z",
    ...over,
  };
}

const locationName = (id: string) =>
  ({ locA: "Downtown", locB: "Uptown" })[id] ?? id;
const categoryOf = () => ({ id: "cat1", name: "Pizza" });

describe("buildSalesReport — aggregation correctness", () => {
  it("aggregates gross, tax, payment mix, and fees on a fixed fixture", () => {
    const orders: Order[] = [
      order({ id: "o1", location_id: "locA" }),
      order({
        id: "o2",
        location_id: "locA",
        items: [item({ quantity: 2, line_total_cents: 2000 })],
        totals: {
          subtotal_cents: 2000,
          discount_cents: 0,
          taxable_cents: 2000,
          tax_cents: 165,
          tip_cents: 0,
          total_cents: 2165,
        },
      }),
    ];
    const payments: Payment[] = [
      payment({ id: "p1", order_id: "o1", rail: "cash", amount_cents: 1080 }),
      payment({
        id: "p2",
        order_id: "o2",
        rail: "stripe_terminal",
        amount_cents: 2165,
        application_fee_cents: 64,
      }),
    ];

    const r = buildSalesReport({
      tenantId: "t1",
      locationId: "locA",
      range: RANGE,
      orders,
      payments,
      categoryOf,
      locationName,
    });

    expect(r.order_count).toBe(2);
    expect(r.gross_cents).toBe(3000); // 1000 + 2000
    expect(r.tax_cents).toBe(245); // 80 + 165
    expect(r.fees_cents).toBe(64);
    // Payment mix: two rails, summed amounts.
    const cash = r.paymentMix.find((m) => m.rail === "cash");
    const card = r.paymentMix.find((m) => m.rail === "stripe_terminal");
    expect(cash?.amount_cents).toBe(1080);
    expect(card?.amount_cents).toBe(2165);
    expect(card?.application_fee_cents).toBe(64);
  });

  it("de-duplicates tips: online order-level tip is NOT double-counted with the tender tip", () => {
    // Online order carries the tip in the order total; the tender also records it.
    const orders: Order[] = [
      order({
        id: "online",
        channel: "online_pickup",
        totals: {
          subtotal_cents: 1000,
          discount_cents: 0,
          taxable_cents: 1000,
          tax_cents: 80,
          tip_cents: 300,
          total_cents: 1380,
        },
      }),
    ];
    const payments: Payment[] = [
      payment({
        id: "po",
        order_id: "online",
        rail: "stripe_online",
        amount_cents: 1080,
        tip_cents: 300,
      }),
    ];
    const r = buildSalesReport({
      tenantId: "t1",
      locationId: "locA",
      range: RANGE,
      orders,
      payments,
      categoryOf,
      locationName,
    });
    // Tip counted ONCE (order-level), not 600.
    expect(r.tip_cents).toBe(300);
  });

  it("counts an in-store tender tip when the order itself carries no tip", () => {
    const orders: Order[] = [order({ id: "instore" })]; // tip_cents 0
    const payments: Payment[] = [
      payment({
        id: "pi",
        order_id: "instore",
        rail: "stripe_terminal",
        tip_cents: 250,
      }),
    ];
    const r = buildSalesReport({
      tenantId: "t1",
      locationId: "locA",
      range: RANGE,
      orders,
      payments,
      categoryOf,
      locationName,
    });
    expect(r.tip_cents).toBe(250);
  });

  it("excludes voided orders from gross but tallies them as voids", () => {
    const orders: Order[] = [
      order({ id: "good" }),
      order({ id: "bad", status: "voided" }),
    ];
    const payments: Payment[] = [payment({ id: "pg", order_id: "good" })];
    const r = buildSalesReport({
      tenantId: "t1",
      locationId: "locA",
      range: RANGE,
      orders,
      payments,
      categoryOf,
      locationName,
    });
    expect(r.order_count).toBe(1);
    expect(r.gross_cents).toBe(1000);
    expect(r.void_count).toBe(1);
    expect(r.void_cents).toBe(1080);
  });

  it("excludes failed/canceled tenders from the payment mix and fees", () => {
    const orders: Order[] = [order({ id: "o1" })];
    const payments: Payment[] = [
      payment({ id: "ok", order_id: "o1", rail: "cash" }),
      payment({
        id: "dead",
        order_id: "o1",
        rail: "stripe_terminal",
        status: "failed",
        application_fee_cents: 99,
      }),
    ];
    const r = buildSalesReport({
      tenantId: "t1",
      locationId: "locA",
      range: RANGE,
      orders,
      payments,
      categoryOf,
      locationName,
    });
    expect(r.fees_cents).toBe(0);
    expect(
      r.paymentMix.find((m) => m.rail === "stripe_terminal"),
    ).toBeUndefined();
  });

  it("rolls up across locations when locationId is null vs scoping to one", () => {
    const orders: Order[] = [
      order({ id: "a", location_id: "locA" }),
      order({ id: "b", location_id: "locB" }),
    ];
    const payments: Payment[] = [
      payment({ id: "pa", order_id: "a", location_id: "locA" }),
      payment({ id: "pb", order_id: "b", location_id: "locB" }),
    ];

    const rollup = buildSalesReport({
      tenantId: "t1",
      locationId: null,
      range: RANGE,
      orders,
      payments,
      categoryOf,
      locationName,
    });
    expect(rollup.order_count).toBe(2);
    expect(rollup.byLocation.map((b) => b.label).sort()).toEqual([
      "Downtown",
      "Uptown",
    ]);

    // Scoped report (caller filters orders) sees only one location.
    const scoped = buildSalesReport({
      tenantId: "t1",
      locationId: "locA",
      range: RANGE,
      orders: orders.filter((o) => o.location_id === "locA"),
      payments: payments.filter((p) => p.location_id === "locA"),
      categoryOf,
      locationName,
    });
    expect(scoped.order_count).toBe(1);
    expect(scoped.byLocation).toHaveLength(1);
  });

  it("ignores orders outside the date range", () => {
    const orders: Order[] = [
      order({ id: "in", created_at: "2026-06-10T00:00:00.000Z" }),
      order({ id: "out", created_at: "2026-05-10T00:00:00.000Z" }),
    ];
    const r = buildSalesReport({
      tenantId: "t1",
      locationId: "locA",
      range: RANGE,
      orders,
      payments: [],
      categoryOf,
      locationName,
    });
    expect(r.order_count).toBe(1);
  });
});
