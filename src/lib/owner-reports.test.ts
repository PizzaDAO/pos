import { describe, expect, it } from "vitest";
import type { Location, Order, Payment } from "@/lib/db";
import {
  addDays,
  buildOwnerBundle,
  bundleToCsv,
  businessDay,
  canonicalTimezone,
  compareSummaries,
  csvCell,
  heatmapGrid,
  isValidTimezone,
  previousRange,
  rangeError,
  reportChannel,
  splitRefund,
  summarize,
  tenderKey,
} from "./owner-reports";

const T = "t1";
const NY: Location = {
  id: "ny",
  tenant_id: T,
  name: "NY",
  slug: "ny",
  timezone: "America/New_York",
  business_day_cutoff_minutes: 240,
  address: null,
  created_at: "2026-01-01T00:00:00Z",
};
const LA: Location = { ...NY, id: "la", name: "LA", slug: "la", timezone: "America/Los_Angeles", business_day_cutoff_minutes: 0 };

let n = 0;
function order(over: Partial<Order> & { price?: number; qty?: number }): Order {
  const { price = 1000, qty = 1, ...rest } = over;
  n += 1;
  return {
    id: `o${n}`,
    tenant_id: T,
    location_id: "ny",
    status: "completed",
    channel: "in_store",
    currency: "USD",
    items: [
      {
        id: `l${n}`, item_id: "pizza", item_name: "Pizza", station: "oven", size_id: null, size_name: null,
        base_price_cents: price, quantity: qty, notes: null, voided: false, unit_price_cents: price,
        line_total_cents: price * qty, modifiers: [],
      } as unknown as Order["items"][number],
    ],
    discount_cents: 0,
    totals: { subtotal_cents: price * qty, discount_cents: 0, taxable_cents: price * qty, tax_cents: 0, tip_cents: 0, total_cents: price * qty },
    notes: null,
    order_number: String(n),
    created_at: "2026-03-10T16:00:00Z",
    updated_at: "2026-03-10T16:00:00Z",
    ...rest,
  } as Order;
}

function pay(o: Order, over: Partial<Payment> = {}): Payment {
  return {
    id: `p${o.id}${Math.random()}`,
    order_id: o.id,
    tenant_id: T,
    location_id: o.location_id,
    rail: "cash",
    status: "captured",
    amount_cents: o.totals.total_cents,
    tip_cents: 0,
    application_fee_cents: 0,
    currency: "USD",
    refunded_cents: 0,
    simulated: false,
    ...over,
  } as Payment;
}

const base = {
  tenantId: T,
  locationId: null,
  locations: [NY, LA],
  staff: [{ id: "s1", name: "Sam" }],
  categoryOf: (id: string) => (id === "pizza" ? { id: "c1", name: "Pizzas" } : null),
};

describe("businessDay (timezone + cutoff)", () => {
  it("uses the location wall clock, not UTC", () => {
    // 03:30Z on Mar 9 is 23:30 EDT on Mar 8 (DST began Mar 8 2026).
    expect(businessDay("2026-03-09T03:30:00Z", "America/New_York", 0)).toEqual({ date: "2026-03-08", dow: 0, hour: 23 });
  });
  it("is DST-aware on the spring-forward day", () => {
    // 06:30Z = 01:30 EST (before the jump); 08:00Z = 04:00 EDT (after).
    expect(businessDay("2026-03-08T06:30:00Z", "America/New_York", 0).hour).toBe(1);
    expect(businessDay("2026-03-08T08:00:00Z", "America/New_York", 0).hour).toBe(4);
  });
  it("is DST-aware on the fall-back day (25-hour day)", () => {
    // Nov 1 2026: 05:30Z = 01:30 EDT, 06:30Z = 01:30 EST: same wall hour twice.
    expect(businessDay("2026-11-01T05:30:00Z", "America/New_York", 0).hour).toBe(1);
    expect(businessDay("2026-11-01T06:30:00Z", "America/New_York", 0).hour).toBe(1);
    expect(businessDay("2026-11-02T04:59:00Z", "America/New_York", 0).date).toBe("2026-11-01");
  });
  it("a 04:00 cutoff keeps after-midnight sales on the previous business day", () => {
    const sat0130 = businessDay("2026-03-07T06:30:00Z", "America/New_York", 240); // 01:30 EST Sat
    expect(sat0130).toEqual({ date: "2026-03-06", dow: 5, hour: 1 });
    expect(businessDay("2026-03-07T09:00:00Z", "America/New_York", 240).date).toBe("2026-03-07"); // 04:00 EST
  });
  it("canonicalTimezone accepts Area/City and UTC, rejects abbreviations", () => {
    expect(canonicalTimezone("America/New_York")).toBe("America/New_York");
    expect(canonicalTimezone("utc")).toBe("UTC");
    expect(canonicalTimezone("EST")).toBeNull();
    expect(canonicalTimezone("Nope/Zone")).toBeNull();
    expect(canonicalTimezone("")).toBeNull();
  });
  it("rejects unknown zones in isValidTimezone and reads them as UTC", () => {
    expect(isValidTimezone("America/Chicago")).toBe(true);
    expect(isValidTimezone("Nope/Zone")).toBe(false);
  });
  it("falls back to UTC for an unknown zone", () => {
    expect(businessDay("2026-03-09T03:30:00Z", "Nope/Zone", 0).hour).toBe(3);
  });
});

describe("range helpers", () => {
  it("previousRange is the equally long window before", () => {
    expect(previousRange("2026-03-08", "2026-03-14")).toEqual({ from: "2026-03-01", to: "2026-03-07" });
    expect(previousRange("2026-03-01", "2026-03-01")).toEqual({ from: "2026-02-28", to: "2026-02-28" });
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });
  it("validates ranges", () => {
    expect(rangeError("2026-03-01", "2026-03-02")).toBeNull();
    expect(rangeError(null, "2026-03-02")).toMatch(/required/);
    expect(rangeError("2026-02-30", "2026-03-02")).toMatch(/valid/);
    expect(rangeError("2026-03-05", "2026-03-02")).toMatch(/after/);
    expect(rangeError("2024-01-01", "2026-03-02")).toMatch(/limited/);
  });
});

describe("buildOwnerBundle money math", () => {
  const a = order({ price: 1100, totals: { subtotal_cents: 1100, discount_cents: 100, taxable_cents: 1000, tax_cents: 80, tip_cents: 0, total_cents: 1080 }, staff_id: "s1" });
  const b = order({ price: 1000, qty: 2, channel: "online_delivery", totals: { subtotal_cents: 2000, discount_cents: 0, taxable_cents: 2000, tax_cents: 160, tip_cents: 200, total_cents: 2360 } });
  const refunded = order({ price: 500, source: { type: "kiosk", channel: "kiosk" }, status: "refunded", totals: { subtotal_cents: 500, discount_cents: 0, taxable_cents: 500, tax_cents: 40, tip_cents: 0, total_cents: 540 }, staff_id: "s1" });
  const voided = order({ status: "voided", staff_id: "s1", totals: { subtotal_cents: 700, discount_cents: 0, taxable_cents: 0, tax_cents: 0, tip_cents: 0, total_cents: 700 } });
  const unpaid = order({ status: "awaiting_payment" });
  const draft = order({ status: "draft" });
  const orders = [a, b, refunded, voided, unpaid, draft].map((o) => ({ ...o, created_at: "2026-03-10T16:00:00Z" }));
  const payments = [
    pay(a, { amount_cents: 1080 }),
    pay(b, { rail: "stripe_online", amount_cents: 2160, tip_cents: 200 }),
    pay(refunded, { rail: "external", method: "card", processor: "kiosk reader", amount_cents: 540, tip_cents: 50, refunded_cents: 590, status: "refunded" }),
    pay(unpaid, { status: "pending", amount_cents: 999 }),
  ];
  const bundle = buildOwnerBundle({ ...base, from: "2026-03-10", to: "2026-03-10", orders, payments });
  const s = summarize(bundle.daily);

  it("computes gross, discount, refund, net, tax, tips", () => {
    expect(s.orders).toBe(3);
    expect(s.gross_cents).toBe(1100 + 2000 + 500);
    expect(s.discount_cents).toBe(100);
    // the $5.90 refund = $0.50 tip + $0.40 tax + $5.00 sales
    expect(s.refund_cents).toBe(590);
    expect(s.refund_sales_cents).toBe(500);
    expect(s.net_cents).toBe(3600 - 100 - 500);
    // the fully refunded order contributes no tax and no tip
    expect(s.tax_cents).toBe(80 + 160);
    // order-level tip wins over the tender tip; refunded order's tender tip is refunded
    expect(s.tip_cents).toBe(200);
    expect(s.avg_ticket_cents).toBe(Math.round(s.net_cents / 3));
  });
  it("tallies voids separately and excludes unpaid/draft", () => {
    expect(s.void_count).toBe(1);
    expect(s.void_cents).toBe(700);
  });
  it("splits tenders by family and key", () => {
    expect(s.cash_cents).toBe(1080);
    expect(s.card_cents).toBe(2160 + 540);
    expect(bundle.tenders.map((t) => t.key).sort()).toEqual(["cash", "external:card:kiosk_reader", "stripe_online"]);
    expect(tenderKey({ rail: "external", method: null, processor: null })).toBe("external:other:");
  });
  it("splits channels", () => {
    expect(bundle.channels.map((c) => c.channel).sort()).toEqual(["delivery", "kiosk", "terminal"]);
    expect(reportChannel({ channel: "online_pickup" })).toBe("online");
    expect(reportChannel({ channel: "in_store", source: { type: "web", channel: "catering" } })).toBe("catering");
  });
  it("items and categories share a denominator", () => {
    expect(bundle.items[0]).toMatchObject({ name: "Pizza", qty: 4, revenue_cents: 3600, category: "Pizzas" });
    expect(bundle.item_total_cents).toBe(3600);
    expect(bundle.categories).toEqual([{ key: "c1", name: "Pizzas", qty: 4, revenue_cents: 3600 }]);
  });
  it("staff rows include voids and unattributed orders", () => {
    const sam = bundle.staff.find((x) => x.name === "Sam")!;
    expect(sam).toMatchObject({ orders: 2, void_count: 1, refund_cents: 590, tip_cents: 0 });
    expect(bundle.staff.find((x) => x.staff_id === null)).toMatchObject({ orders: 1, tip_cents: 200 });
  });
  it("a fully refunded order contributes $0 net, tax and tip", () => {
    const o = order({ price: 500, totals: { subtotal_cents: 500, discount_cents: 0, taxable_cents: 500, tax_cents: 40, tip_cents: 0, total_cents: 540 } });
    const p = pay(o, { amount_cents: 540, tip_cents: 50, refunded_cents: 590, status: "refunded" });
    const r = summarize(buildOwnerBundle({ ...base, from: "2026-03-10", to: "2026-03-10", orders: [o], payments: [p] }).daily);
    expect(r).toMatchObject({ net_cents: 0, tax_cents: 0, tip_cents: 0, refund_cents: 590 });
  });
  it("splits a partial refund tip-last: pro-rata over sales and tax, tip untouched", () => {
    // paid $10.80 (sales 10.00 + tax 0.80) + tip 1.00; refund $3.20 of items
    expect(splitRefund([{ amount_cents: 1080, tip_cents: 100, refunded_cents: 320 }], { sales: 1000, tax: 80, fees: 0 }, 100)).toEqual({
      total: 320, tip: 0, tax: 24, fees: 0, sales: 296,
    });
    const o = order({ price: 1000, totals: { subtotal_cents: 1000, discount_cents: 0, taxable_cents: 1000, tax_cents: 80, tip_cents: 0, total_cents: 1080 } });
    const p = pay(o, { amount_cents: 1080, tip_cents: 100, refunded_cents: 320 });
    const r = summarize(buildOwnerBundle({ ...base, from: "2026-03-10", to: "2026-03-10", orders: [o], payments: [p] }).daily);
    expect(r).toMatchObject({ net_cents: 1000 - 296, tax_cents: 80 - 24, tip_cents: 100, refund_cents: 320 });
  });
  it("only the part beyond the non-tip amount comes off the tip", () => {
    expect(splitRefund([{ amount_cents: 1080, tip_cents: 100, refunded_cents: 1130 }], { sales: 1000, tax: 80, fees: 0 }, 100)).toEqual({
      total: 1130, tip: 50, tax: 80, fees: 0, sales: 1000,
    });
  });
  it("tip-last is per tender: a fully refunded tipped card leaves the cash tender alone", () => {
    // cash $10.00 no tip + card $11.65 with $4.00 tip (card fully refunded = $15.65); order tax 1.65 on 20.00 sales
    const tenders = [
      { amount_cents: 1000, tip_cents: 0, refunded_cents: 0 },
      { amount_cents: 1165, tip_cents: 400, refunded_cents: 1565 },
    ];
    const r = splitRefund(tenders, { sales: 2000, tax: 165, fees: 0 }, 400);
    expect(r.tip).toBe(400);
    // the card's non-tip $11.65 split pro-rata: tax 165/2165 of 1165 = 89, sales 1076
    expect(r).toMatchObject({ total: 1565, tax: 89, fees: 0, sales: 1076 });
    expect(r.tip + r.tax + r.fees + r.sales).toBe(r.total);
  });
  it("caps refunded sales at gross - discount; overflow goes to the tip part", () => {
    // order tip $2 but tender tip $3; fully refunded $24.65 on $20.00 sales + $1.65 tax + $2.00 order tip
    const r = splitRefund([{ amount_cents: 2165, tip_cents: 300, refunded_cents: 2465 }], { sales: 2000, tax: 165, fees: 0 }, 200);
    expect(r.sales).toBe(2000);
    expect(r.tip + r.tax + r.fees + r.sales).toBe(2465);
    const o = order({ price: 2000, totals: { subtotal_cents: 2000, discount_cents: 0, taxable_cents: 2000, tax_cents: 165, tip_cents: 200, total_cents: 2365 } });
    const p = pay(o, { amount_cents: 2165, tip_cents: 300, refunded_cents: 2465, status: "refunded" });
    const sum = summarize(buildOwnerBundle({ ...base, from: "2026-03-10", to: "2026-03-10", orders: [o], payments: [p] }).daily);
    expect(sum.net_cents).toBe(0);
    expect(sum.tax_cents).toBe(0);
  });
  describe("delivery fees", () => {
    const delivery = () =>
      order({ price: 2000, channel: "online_delivery", totals: { subtotal_cents: 2000, discount_cents: 0, taxable_cents: 2000, tax_cents: 0, tip_cents: 0, total_cents: 2500, fees_cents: 500 } });
    it("reports fees separately from sales", () => {
      const o = delivery();
      const r = summarize(buildOwnerBundle({ ...base, from: "2026-03-10", to: "2026-03-10", orders: [o], payments: [pay(o)] }).daily);
      expect(r).toMatchObject({ gross_cents: 2000, fees_cents: 500, net_cents: 2000 });
    });
    it("a full refund zeroes net, fees, tax and tip (no negative net)", () => {
      const o = delivery();
      const b = buildOwnerBundle({ ...base, from: "2026-03-10", to: "2026-03-10", orders: [o], payments: [pay(o, { refunded_cents: 2500, status: "refunded" })] });
      expect(summarize(b.daily)).toMatchObject({ net_cents: 0, fees_cents: 0, refund_fees_cents: 500, refund_sales_cents: 2000, refund_cents: 2500 });
      expect(b.channels[0]).toMatchObject({ refund_fees_cents: 500, fees_cents: 0 });
    });
    it("a partial refund takes fees pro-rata", () => {
      const o = delivery();
      const r = summarize(buildOwnerBundle({ ...base, from: "2026-03-10", to: "2026-03-10", orders: [o], payments: [pay(o, { refunded_cents: 1250 })] }).daily);
      expect(r).toMatchObject({ refund_fees_cents: 250, refund_sales_cents: 1000, fees_cents: 250, net_cents: 1000 });
    });
  });
  it("invariant: refund parts always sum to the refund total", () => {
    const cases: [number, number, number, number, number][] = [
      // amount, tip, refunded, tax, fees
      [1080, 100, 0, 80, 0], [1080, 100, 320, 80, 0], [1080, 100, 1080, 80, 0], [1080, 100, 1180, 80, 0],
      [2500, 0, 777, 0, 500], [2165, 300, 2465, 165, 0], [1165, 400, 1565, 165, 0], [2900, 400, 2901, 160, 340], [540, 50, 590, 40, 0], [333, 0, 111, 33, 33], [100, 0, 100, 0, 0],
    ];
    for (const [amount, tip, refunded, tax, fees] of cases) {
      const r = splitRefund([{ amount_cents: amount, tip_cents: tip, refunded_cents: refunded }], { sales: amount - tax - fees, tax, fees }, tip);
      expect(r.tip + r.tax + r.fees + r.sales).toBe(r.total);
      expect(r.tip).toBeGreaterThanOrEqual(0);
    }
  });
  it("excludes voided lines from gross and counts them against staff", () => {
    const o = order({ staff_id: "s1" });
    o.items.push({ ...o.items[0]!, id: "x", voided: true, unit_price_cents: 9999 });
    const r = buildOwnerBundle({ ...base, from: "2026-03-10", to: "2026-03-10", orders: [o], payments: [] });
    expect(r.daily[0]!.gross_cents).toBe(1000);
    expect(r.staff[0]!.void_count).toBe(1);
  });
  it("limits items to topN", () => {
    const many = Array.from({ length: 5 }, (_, i) => {
      const o = order({});
      o.items[0] = { ...o.items[0]!, item_id: `i${i}`, item_name: `I${i}`, unit_price_cents: 100 * (i + 1) };
      return o;
    });
    const r = buildOwnerBundle({ ...base, from: "2026-03-10", to: "2026-03-10", orders: many, payments: [], topN: 2 });
    expect(r.items.map((i) => i.name)).toEqual(["I4", "I3"]);
  });
  it("never leaks another tenant's orders or a different location", () => {
    const foreign = { ...order({}), tenant_id: "other" };
    const la = order({ location_id: "la" });
    const r = buildOwnerBundle({ ...base, locationId: "ny", from: "2026-03-10", to: "2026-03-10", orders: [foreign, la], payments: [] });
    expect(r.daily).toEqual([]);
  });
});

describe("buildOwnerBundle day boundaries", () => {
  const sat0130 = order({ created_at: "2026-03-07T06:30:00Z" }); // NY 01:30 EST, cutoff 4h -> Fri Mar 6
  const sat0900 = order({ created_at: "2026-03-07T14:00:00Z" }); // NY 09:00 -> Sat Mar 7
  const laLate = order({ location_id: "la", created_at: "2026-03-08T07:30:00Z" }); // LA 23:30 PST Mar 7
  const run = (from: string, to: string) =>
    buildOwnerBundle({ ...base, from, to, orders: [sat0130, sat0900, laLate], payments: [] });

  it("buckets each location in its own zone and cutoff", () => {
    const r = run("2026-03-06", "2026-03-07");
    expect(r.daily.map((d) => [d.business_date, d.location_name, d.orders])).toEqual([
      ["2026-03-06", "NY", 1],
      ["2026-03-07", "LA", 1],
      ["2026-03-07", "NY", 1],
    ]);
  });
  it("a range is inclusive on both business dates", () => {
    expect(run("2026-03-06", "2026-03-06").daily).toHaveLength(1);
    expect(run("2026-03-08", "2026-03-08").daily).toHaveLength(0);
  });
  it("heatmap weekday follows the business day, hour the clock", () => {
    const g = heatmapGrid(run("2026-03-06", "2026-03-06").hourly);
    expect(g.orders[5]![1]).toBe(1); // Friday, 01:00
    expect(g.max).toBe(1000);
  });
  it("a fall-back day keeps both 01:xx hours in one cell", () => {
    const x = order({ created_at: "2026-11-01T05:30:00Z" });
    const y = order({ created_at: "2026-11-01T06:30:00Z" });
    const r = buildOwnerBundle({ ...base, locationId: "ny", locations: [{ ...NY, business_day_cutoff_minutes: 0 }], from: "2026-11-01", to: "2026-11-01", orders: [x, y], payments: [] });
    expect(r.hourly).toEqual([{ dow: 0, hour: 1, orders: 2, sales_cents: 2000 }]);
  });
});

describe("comparison + csv", () => {
  it("computes deltas with null pct against zero", () => {
    const cur = summarize([{ ...emptyDay(), orders: 4, gross_cents: 400 }]);
    const prev = summarize([{ ...emptyDay(), orders: 2, gross_cents: 0 }]);
    const d = compareSummaries(cur, prev);
    expect(d.orders).toMatchObject({ diff: 2, pct: 1 });
    expect(d.gross_cents!.pct).toBeNull();
  });
  it("escapes csv and neutralises formulas but keeps negative numbers", () => {
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvCell("-12.50")).toBe("-12.50");
    expect(csvCell(null)).toBe("");
  });
  it("accountant csv has one row per location per day in dollars", () => {
    const o = order({ totals: { subtotal_cents: 1000, discount_cents: 0, taxable_cents: 1000, tax_cents: 80, tip_cents: 0, total_cents: 1080 } });
    const bundle = buildOwnerBundle({ ...base, from: "2026-03-10", to: "2026-03-10", orders: [o], payments: [pay(o)] });
    const lines = bundleToCsv("accountant", bundle, (k) => k).trim().split("\r\n");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toBe("2026-03-10,NY,1,10.00,0.00,0.00,10.00,0.80,0.00,0.00,0,0.00,10.80,0.00,0.00,0.00");
    expect(lines[2]).toMatch(/^# Refunds are dated to the original order's business day/);
  });
});

function emptyDay() {
  return {
    location_id: "x", location_name: "x", business_date: "2026-03-10", orders: 0, gross_cents: 0, discount_cents: 0,
    refund_cents: 0, refund_sales_cents: 0, refund_tax_cents: 0, refund_fees_cents: 0, fees_cents: 0, refund_tip_cents: 0, tax_cents: 0, tip_cents: 0, void_count: 0, void_cents: 0, cash_cents: 0, card_cents: 0,
    crypto_cents: 0, other_cents: 0,
  };
}
