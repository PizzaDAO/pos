import { describe, it, expect } from "vitest";
import type { Order, Payment } from "@/lib/db";
import { isFullyRefunded } from "./refund-state";
import { selectOpenOrders } from "./open-orders";
import { buildReceipt } from "./receipt";

const pay = (o: Partial<Payment>): Payment =>
  ({
    id: "p",
    order_id: "o1",
    rail: "cash",
    status: "captured",
    amount_cents: 1000,
    tip_cents: 0,
    refunded_cents: 0,
    currency: "USD",
    application_fee_cents: 0,
    cash_tendered_cents: null,
    cash_change_cents: null,
    simulated: false,
    raw: null,
    ...o,
  }) as unknown as Payment;

const order = (o: Partial<Order> & { total?: number } = {}): Order =>
  ({
    id: "o1",
    status: "paid",
    channel: "in_store",
    currency: "USD",
    items: [],
    order_number: "1",
    totals: {
      subtotal_cents: 1000,
      discount_cents: 0,
      tax_cents: 0,
      tip_cents: 0,
      total_cents: o.total ?? 1000,
    },
    ...o,
  }) as unknown as Order;

describe("isFullyRefunded", () => {
  it("is true when every live tender is refunded", () => {
    expect(isFullyRefunded(order(), [pay({ status: "refunded" })])).toBe(true);
  });
  it("ignores failed/canceled attempts", () => {
    expect(
      isFullyRefunded(order(), [
        pay({ id: "a", status: "failed" }),
        pay({ id: "b", status: "canceled" }),
        pay({ id: "c", status: "refunded" }),
      ]),
    ).toBe(true);
  });
  it("is false with no live tender (only failed/canceled, or none)", () => {
    expect(isFullyRefunded(order(), [])).toBe(false);
    expect(
      isFullyRefunded(order(), [pay({ status: "failed" }), pay({ status: "canceled" })]),
    ).toBe(false);
  });
  it("is false when one live tender is still captured", () => {
    expect(
      isFullyRefunded(order(), [pay({ status: "refunded" }), pay({ id: "q" })]),
    ).toBe(false);
  });
  it("trusts an order already marked refunded", () => {
    expect(isFullyRefunded(order({ status: "refunded" }), [])).toBe(true);
  });
});

describe("receipt refund fields", () => {
  it("sums refundedCents over live tenders and flags full refunds", () => {
    const r = buildReceipt(order(), [
      pay({ status: "failed", refunded_cents: 999 }),
      pay({ id: "b", status: "refunded", refunded_cents: 1000 }),
    ]);
    expect(r.refundedCents).toBe(1000);
    expect(r.fullyRefunded).toBe(true);
  });
  it("reports a partial refund without marking the order refunded", () => {
    const r = buildReceipt(order(), [pay({ refunded_cents: 300 })]);
    expect(r.refundedCents).toBe(300);
    expect(r.fullyRefunded).toBe(false);
  });
  it("a refunded order that once had a failed card tender is fully refunded", () => {
    const r = buildReceipt(order(), [
      pay({ id: "x", rail: "stripe_terminal", status: "failed" }),
      pay({ id: "y", status: "refunded", refunded_cents: 1000 }),
    ]);
    expect(r.fullyRefunded).toBe(true);
  });
});

describe("selectOpenOrders", () => {
  const map = (e: [string, Payment[]][]) => new Map(e);
  it("lists orders with a balance, including completed ones", () => {
    const orders = [
      order({ id: "a", status: "placed" }),
      order({ id: "b", status: "completed" }),
      order({ id: "c", status: "paid" }),
    ];
    const rows = selectOpenOrders(
      orders,
      map([["c", [pay({ order_id: "c" })]]]),
    );
    expect(rows.map((r) => r.id)).toEqual(["a", "b"]);
    expect(rows[0]!.balanceCents).toBe(1000);
  });
  it("excludes fully refunded orders, even after a failed card attempt", () => {
    const rows = selectOpenOrders(
      [order({ id: "a", status: "in_kitchen" })],
      map([
        [
          "a",
          [
            pay({ id: "f", order_id: "a", status: "failed" }),
            pay({ id: "r", order_id: "a", status: "refunded", refunded_cents: 1000 }),
          ],
        ],
      ]),
    );
    expect(rows).toEqual([]);
  });
  it("applies the cap after the balance filter", () => {
    const paid = Array.from({ length: 5 }, (_, i) =>
      order({ id: `p${i}`, status: "paid" }),
    );
    const owing = order({ id: "old", status: "placed" });
    const m = new Map(
      paid.map((o) => [o.id, [pay({ order_id: o.id })]] as [string, Payment[]]),
    );
    expect(selectOpenOrders([...paid, owing], m, 2).map((r) => r.id)).toEqual(["old"]);
  });
  it("skips non in-store, voided and refunded orders", () => {
    const rows = selectOpenOrders(
      [
        order({ id: "a", channel: "online_pickup" }),
        order({ id: "b", status: "voided" }),
        order({ id: "c", status: "refunded" }),
      ],
      new Map(),
    );
    expect(rows).toEqual([]);
  });
});
