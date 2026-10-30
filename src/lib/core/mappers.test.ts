import { describe, expect, it } from "vitest";
import {
  DailySalesSchema,
  LocationSchema,
  OrderSchema,
  PaymentSchema,
  orderViolations,
} from "@openpizza/core";
import type {
  BusinessDayClose,
  Location,
  Order,
  Payment,
  StoreSettings,
} from "@/lib/db";
import {
  derivePaymentStatus,
  inferItemKind,
  inferModifierRole,
  toContractDailySales,
  toContractLocation,
  toContractOrder,
  toContractPayment,
} from "./mappers";

const T = "10000000-0000-0000-0000-000000000001";
const L = "11111111-0000-4000-8000-000000000001";

function order(over: Partial<Order> = {}): Order {
  return {
    id: "aaaaaaaa-0000-4000-8000-000000000001",
    tenant_id: T,
    location_id: L,
    status: "placed",
    channel: "online_pickup",
    currency: "USD",
    items: [
      {
        id: "l1",
        item_id: "30000000-0000-0000-0000-000000000002",
        item_name: "Pepperoni",
        size_id: null,
        size_name: "L",
        base_price_cents: 1000,
        quantity: 1,
        modifiers: [],
        notes: null,
        voided: false,
        unit_price_cents: 1000,
        line_total_cents: 1000,
      },
      {
        id: "l2",
        item_id: "30000000-0000-0000-0000-000000000001",
        item_name: "Margherita",
        size_id: null,
        size_name: "L",
        base_price_cents: 1001,
        quantity: 1,
        modifiers: [],
        notes: null,
        voided: false,
        unit_price_cents: 1001,
        line_total_cents: 1001,
      },
      {
        id: "l3",
        item_id: "30000000-0000-0000-0000-000000000001",
        item_name: "Voided",
        size_id: null,
        size_name: null,
        base_price_cents: 500,
        quantity: 2,
        modifiers: [],
        notes: null,
        voided: true,
        unit_price_cents: 500,
        line_total_cents: 0,
      },
    ],
    discount_cents: 101,
    totals: {
      subtotal_cents: 2001,
      discount_cents: 101,
      taxable_cents: 1900,
      tax_cents: 157,
      tip_cents: 200,
      total_cents: 2257,
    },
    notes: null,
    order_number: "W-1",
    created_at: "2026-06-04T23:30:00.000Z",
    updated_at: "2026-06-04T23:40:00.000Z",
    ...over,
  };
}

function pay(over: Partial<Payment> = {}): Payment {
  return {
    id: "bbbbbbbb-0000-4000-8000-000000000001",
    order_id: "aaaaaaaa-0000-4000-8000-000000000001",
    tenant_id: T,
    location_id: L,
    rail: "stripe_terminal",
    status: "captured",
    amount_cents: 2257, // online orders: the tender covers the total incl. order tip
    tip_cents: 0,
    application_fee_cents: 60,
    currency: "USD",
    charge_id: "pi_1",
    connect_account_id: null,
    crypto_tx_hash: null,
    crypto_chain: null,
    cash_tendered_cents: null,
    cash_change_cents: null,
    refunded_cents: 0,
    simulated: false,
    raw: null,
    created_at: "2026-06-04T23:31:00.000Z",
    updated_at: "2026-06-04T23:31:00.000Z",
    ...over,
  };
}

describe("order mapping", () => {
  it("splits status onto two axes and allocates discounts by largest remainder", () => {
    const o = toContractOrder({ order: order(), payments: [], timezone: "America/New_York" });
    expect(OrderSchema.parse(o)).toBeTruthy();
    expect(orderViolations(o)).toEqual([]);
    expect(o.fulfillment_status).toBe("placed");
    expect(o.payment_status).toBe("unpaid");
    expect(o.amount_due_cents).toBe(2257);
    expect(o.lines.map((l) => l.discount_cents)).toEqual([50, 51, 0]);
    expect(o.lines[2]!.line_total_cents).toBe(0);
    expect(o.channel).toBe("online");
    expect(o.source.type).toBe("web");
    // 23:30Z on Jun 4 is 19:30 in New York: same business date
    expect(o.business_date).toBe("2026-06-04");
    expect(
      toContractOrder({
        order: order({ created_at: "2026-06-05T02:30:00.000Z" }),
        payments: [],
        timezone: "America/New_York",
      }).business_date,
    ).toBe("2026-06-04");
  });

  it("maps draft to held with a hold, others to hold=null", () => {
    const held = toContractOrder({
      order: order({ status: "draft", hold: { reason: "awaiting_payment", expires_at: "2026-06-04T23:45:00.000Z" } }),
      payments: [],
      timezone: "UTC",
    });
    expect(held.fulfillment_status).toBe("held");
    expect(held.hold?.reason).toBe("awaiting_payment");
    expect(held.placed_at).toBeNull();
    expect(orderViolations(held)).toEqual([]);
    expect(toContractOrder({ order: order(), payments: [], timezone: "UTC" }).hold).toBeNull();
  });

  it("derives the payment axis from tenders, not from POS status", () => {
    const o = order({ status: "in_kitchen" });
    expect(derivePaymentStatus(o, [pay({ amount_cents: 1000, tip_cents: 0 })])).toEqual({
      payment_status: "partially_paid",
      amount_due_cents: 1257,
    });
    expect(derivePaymentStatus(o, [pay()]).payment_status).toBe("paid");
    expect(derivePaymentStatus(o, [pay({ refunded_cents: 500 })]).payment_status).toBe("partially_refunded");
    expect(derivePaymentStatus(o, [pay({ refunded_cents: 2257, status: "refunded" })]).payment_status).toBe("refunded");
    expect(derivePaymentStatus(o, [pay({ status: "failed" })]).payment_status).toBe("unpaid");
    // no payments loaded: POS `paid` / `refunded` hints win
    expect(derivePaymentStatus(order({ status: "paid" }), []).payment_status).toBe("paid");
    expect(derivePaymentStatus(order({ status: "refunded" }), []).payment_status).toBe("refunded");
  });

  it("voided -> canceled; delivery fee is reported separately and untaxed", () => {
    const o = toContractOrder({
      order: order({
        status: "voided",
        channel: "online_delivery",
        totals: { ...order().totals, total_cents: 2257 + 399 },
        fulfillment: {
          type: "delivery",
          scheduled_for: "asap",
          promised_at: "2026-06-05T00:10:00.000Z",
          delivery_fee_cents: 399,
          address: { line1: "1 A St", city: "X", region: "IL", postal_code: "62701", country: "USA" },
          contact: { name: "Dee", phone: "(555) 555-0123" },
        },
      }),
      payments: [],
      timezone: "UTC",
    });
    expect(o.fulfillment_status).toBe("canceled");
    expect(o.canceled_at).not.toBeNull();
    expect(o.totals.delivery_fee_cents).toBe(399);
    expect(orderViolations(o)).toEqual([]);
    expect(o.fulfillment.type).toBe("delivery");
    expect(o.fulfillment.address?.country).toBe("US"); // "USA" is not alpha-2
    expect(o.contact?.phone).toBeNull(); // not E.164 -> dropped, never invalid
    expect(OrderSchema.parse(o)).toBeTruthy();
  });

  it("explicit source/channel from core wins over the POS channel", () => {
    const o = toContractOrder({
      order: order({ source: { type: "agent_mcp", channel: "agent", module: "pizza_mcp", agent_client_id: "c1" } }),
      payments: [],
      timezone: "UTC",
    });
    expect(o.channel).toBe("agent");
    expect(o.source).toMatchObject({ type: "agent_mcp", module: "pizza_mcp", agent_client_id: "c1" });
  });
});

describe("payment mapping", () => {
  it("maps rails to methods/processors and refund states", () => {
    const card = PaymentSchema.parse(toContractPayment(pay()));
    expect(card.method).toBe("card");
    expect(card.processor).toBe("stripe");
    expect(card.processor_ref).toBe("pi_1");
    expect(toContractPayment(pay({ rail: "cash" })).method).toBe("cash");
    expect(toContractPayment(pay({ rail: "crypto_coinbase", charge_id: null, crypto_tx_hash: "0xabc" })).processor).toBe("coinbase");
    expect(toContractPayment(pay({ refunded_cents: 10 })).status).toBe("partially_refunded");
    expect(toContractPayment(pay({ refunded_cents: 2257 })).status).toBe("refunded");
  });
});

describe("location mapping", () => {
  const settings: StoreSettings = {
    tenant_id: T,
    location_id: L,
    currency: "USD",
    tax_rate_bps: 700,
    tip_presets_bps: [1500],
  };

  it("parses a legacy one-line address and tolerates missing fulfillment settings", () => {
    const loc: Location = {
      id: L,
      tenant_id: T,
      name: "Old Shop",
      slug: "old",
      timezone: "America/Chicago",
      address: "9 Elm St, Peoria",
      created_at: "2026-01-01T00:00:00.000Z",
    };
    const c = LocationSchema.parse(toContractLocation(loc, settings));
    expect(c.address).toMatchObject({ line1: "9 Elm St", city: "Peoria", country: "US" });
    expect(c.geo).toBeNull();
    expect(c.fulfillment.pickup_enabled).toBe(true);
    expect(c.fulfillment.delivery_enabled).toBe(false);
  });

  it("uses structured address + geo when present", () => {
    const c = LocationSchema.parse(
      toContractLocation(
        {
          id: L,
          tenant_id: T,
          name: "New",
          slug: "new",
          timezone: "America/New_York",
          address: "x",
          address_line1: "5 Main",
          address_line2: "Suite 2",
          city: "Troy",
          region: "NY",
          postal_code: "12180",
          country: "US",
          lat: 42.7,
          lng: -73.6,
          created_at: "2026-01-01T00:00:00.000Z",
        },
        settings,
      ),
    );
    expect(c.address.line2).toBe("Suite 2");
    expect(c.geo).toEqual({ lat: 42.7, lng: -73.6 });
    expect(c.jurisdiction.code).toBe("US-NY");
  });
});

describe("misc mapping", () => {
  it("infers kinds and roles from names", () => {
    expect(inferItemKind("Pizzas", "Pepperoni")).toBe("pizza");
    expect(inferItemKind("Sides", "Garlic Knots")).toBe("side");
    expect(inferItemKind("Drinks", "Fountain Soda")).toBe("drink");
    expect(inferModifierRole("Crust")).toBe("crust");
    expect(inferModifierRole("Toppings")).toBe("topping");
    expect(inferModifierRole("Allergy notes")).toBe("other");
  });

  it("maps a business-day close to DailySales", () => {
    const close = {
      id: "cccccccc-0000-4000-8000-000000000001",
      tenant_id: T,
      location_id: L,
      business_date: "2026-06-04",
      closed_at: "2026-06-05T04:00:00+00:00",
      report: {
        tenant_id: T,
        location_id: L,
        range: { from: null, to: null },
        order_count: 3,
        gross_cents: 3000,
        discount_cents: 100,
        net_cents: 2900,
        tax_cents: 240,
        tip_cents: 300,
        fees_cents: 90,
        void_count: 1,
        void_cents: 500,
        refund_count: 0,
        refund_cents: 0,
        byDay: [],
        byItem: [],
        byCategory: [],
        byChannel: [{ key: "in_store", label: "In store", count: 3, gross_cents: 3000 }],
        byLocation: [],
        paymentMix: [
          { rail: "cash", label: "Cash", count: 2, amount_cents: 1000, tip_cents: 100, application_fee_cents: 0 },
          { rail: "stripe_online", label: "Card", count: 1, amount_cents: 2000, tip_cents: 200, application_fee_cents: 90 },
        ],
      },
      drawer: {
        opening_float_cents: 0,
        cash_sales_cents: 0,
        expected_cents: 0,
        counted_cents: 0,
        over_short_cents: 0,
        shift_count: 0,
      },
    } as BusinessDayClose;
    const d = DailySalesSchema.parse(toContractDailySales(close, "USD"));
    expect(d.closed).toBe(true);
    expect(d.closed_at).toBe("2026-06-05T04:00:00.000Z");
    expect(d.payment_mix.map((m) => m.method)).toEqual(["cash", "card"]);
  });
});
