/**
 * pos-v1-gaps phase 3: read models (sales.hourly, sales.items, tips.list,
 * kitchen.load) and the tip.recorded / tip.adjusted events. Mock driver; the SQL
 * twin of the event rules runs on PGlite (supabase/tests/phase3_tip_events.sql).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EVENT_TYPES,
  TipFactSchema,
  canPublishEvent,
  type Order as CoreOrder,
  type Principal,
} from "@openpizza/core";
import {
  getPosDriver,
  DEMO_LOCATION_DOWNTOWN_ID,
  DEMO_LOCATION_UPTOWN_ID,
  DEMO_TENANT_ID,
  type CreateOrderInput,
  type Payment,
} from "@/lib/db";
import { resetMockOnline, resetMockOrders, resetMockPayments } from "@/lib/db/mock";
import { handleV1 } from "./v1";
import { hydrateEvent, memoryOutbox } from "./outbox";
import { buildHourlySales, localDateHour } from "./sales";
import { buildKitchenLoad } from "./kitchen-load";
import { tipFactsForOrder } from "./tips";

const DOWNTOWN = DEMO_LOCATION_DOWNTOWN_ID;
const UPTOWN = DEMO_LOCATION_UPTOWN_ID;
const ID = (n: number) => `e3000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

async function call(
  method: string,
  path: string,
  opts: { scopes?: string[]; who?: Partial<Principal> } = {},
) {
  const url = `https://pos.test/api/v1${path}`;
  const segments = new URL(url).pathname.replace(/^\/api\/v1\/?/, "").split("/").filter(Boolean);
  const principal: Principal = {
    kind: "service",
    id: "hub:test-client",
    tenant_id: DEMO_TENANT_ID,
    location_ids: null,
    scopes: opts.scopes ?? ["*"],
    module: "workforce",
    ...opts.who,
  };
  const res = await handleV1(new Request(url, { method }), segments, { principal });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

interface MkOrder {
  at: string;
  location?: string;
  subtotal?: number;
  discount?: number;
  tip?: number;
  status?: CreateOrderInput["status"];
  hold?: boolean;
  lines?: { item: string; name: string; qty: number; price: number; size?: string; voided?: boolean }[];
}

/** Create an order "at" an instant (the mock stamps created_at from the clock). */
async function mk(id: string, o: MkOrder) {
  vi.setSystemTime(new Date(o.at));
  const subtotal = o.subtotal ?? 2000;
  const discount = o.discount ?? 0;
  const tip = o.tip ?? 0;
  const lines = o.lines ?? [{ item: "30000000-0000-0000-0000-000000000002", name: "Pepperoni", qty: 1, price: subtotal }];
  return getPosDriver().createOrder({
    id,
    tenant_id: DEMO_TENANT_ID,
    location_id: o.location ?? DOWNTOWN,
    channel: "in_store",
    currency: "USD",
    items: lines.map((l, i) => ({
      id: `${id.slice(0, 24)}${String(i).padStart(12, "0")}`,
      item_id: l.item,
      item_name: l.name,
      size_id: l.size ? `size-${l.size}` : null,
      size_name: l.size ?? null,
      base_price_cents: l.price,
      quantity: l.qty,
      modifiers: [],
      notes: null,
      voided: l.voided ?? false,
      unit_price_cents: l.price,
      line_total_cents: l.price * l.qty,
    })),
    discount_cents: discount,
    totals: {
      subtotal_cents: subtotal,
      discount_cents: discount,
      taxable_cents: subtotal - discount,
      tax_cents: 0,
      tip_cents: tip,
      total_cents: subtotal - discount + tip,
    },
    notes: null,
    status: o.status ?? "placed",
    ...(o.hold ? { hold: { reason: "awaiting_payment", expires_at: null } } : {}),
  });
}

function pay(orderId: string, id: string, over: Partial<Payment> = {}): Payment {
  return {
    id,
    order_id: orderId,
    tenant_id: DEMO_TENANT_ID,
    location_id: DOWNTOWN,
    rail: "stripe_online",
    status: "captured",
    amount_cents: 2000,
    tip_cents: 0,
    application_fee_cents: 0,
    currency: "USD",
    charge_id: `pi_${id.slice(-4)}`,
    connect_account_id: "acct_1",
    crypto_tx_hash: null,
    crypto_chain: null,
    cash_tendered_cents: null,
    cash_change_cents: null,
    refunded_cents: 0,
    simulated: true,
    raw: null,
    created_at: "2026-06-04T22:00:00.000Z",
    updated_at: "2026-06-04T22:00:00.000Z",
    ...over,
  };
}

beforeEach(async () => {
  vi.useFakeTimers();
  // The mock lazily seeds demo kitchen orders relative to "now": seed them in
  // 2020, far outside every window below.
  vi.setSystemTime(new Date("2020-01-01T12:00:00.000Z"));
  resetMockOrders();
  resetMockPayments();
  resetMockOnline();
  await getPosDriver().listOrdersPage(DEMO_TENANT_ID, DOWNTOWN, { limit: 1 });
  await getPosDriver().listOrdersPage(DEMO_TENANT_ID, UPTOWN, { limit: 1 });
  vi.setSystemTime(new Date("2026-06-04T22:00:00.000Z"));
  memoryOutbox.clear();
});
afterEach(() => vi.useRealTimers());

describe("localDateHour (location zone, DST)", () => {
  it("crosses the local midnight, not the UTC one", () => {
    expect(localDateHour("2026-06-05T03:30:00Z", "America/New_York")).toEqual({ date: "2026-06-04", hour: 23 });
    expect(localDateHour("2026-06-05T04:00:00Z", "America/New_York")).toEqual({ date: "2026-06-05", hour: 0 });
    expect(localDateHour("2026-06-05T07:30:00Z", "America/Los_Angeles")).toEqual({ date: "2026-06-05", hour: 0 });
  });
  it("spring forward has no hour 2; fall back folds the repeated hour", () => {
    // NY 2026-03-08: 01:59 EST -> 03:00 EDT
    expect(localDateHour("2026-03-08T06:59:00Z", "America/New_York")).toEqual({ date: "2026-03-08", hour: 1 });
    expect(localDateHour("2026-03-08T07:00:00Z", "America/New_York")).toEqual({ date: "2026-03-08", hour: 3 });
    // NY 2026-11-01: 01:30 EDT, then 01:30 EST an hour later
    expect(localDateHour("2026-11-01T05:30:00Z", "America/New_York")).toEqual({ date: "2026-11-01", hour: 1 });
    expect(localDateHour("2026-11-01T06:30:00Z", "America/New_York")).toEqual({ date: "2026-11-01", hour: 1 });
    // midnight is hour 0, never 24
    expect(localDateHour("2026-11-01T04:00:00Z", "America/New_York").hour).toBe(0);
  });
  it("buckets each location in its own zone", () => {
    const order = (loc: string) =>
      ({
        location_id: loc,
        business_date: "2026-06-05",
        fulfillment_status: "placed",
        placed_at: "2026-06-05T03:30:00Z",
        created_at: "2026-06-05T03:30:00Z",
        totals: { subtotal_cents: 1000, discount_cents: 100, tip_cents: 50 },
      }) as unknown as CoreOrder;
    const rows = buildHourlySales({
      from: "2026-06-04",
      to: "2026-06-05",
      orders: [order("ny"), order("la")],
      timezones: new Map([
        ["ny", "America/New_York"],
        ["la", "America/Los_Angeles"],
      ]),
    });
    expect(rows.map((r) => [r.location_id, r.date, r.hour])).toEqual([
      ["la", "2026-06-04", 20],
      ["ny", "2026-06-04", 23],
    ]);
    expect(rows[0]).toMatchObject({ order_count: 1, gross_cents: 1000, net_cents: 900, tip_cents: 50 });
  });
});

describe("GET /locations/{id}/sales/hourly", () => {
  const url = (from: string, to: string, loc = DOWNTOWN) =>
    `/locations/${loc}/sales/hourly?from=${from}&to=${to}`;

  it("buckets in the location zone across the local midnight", async () => {
    await mk(ID(1), { at: "2026-06-05T03:30:00Z", subtotal: 2000, discount: 200, tip: 100 }); // 23:30 Jun 4
    await mk(ID(2), { at: "2026-06-05T04:10:00Z", subtotal: 1000 }); // 00:10 Jun 5
    const r = await call("GET", url("2026-06-04", "2026-06-05"));
    expect(r.status).toBe(200);
    expect(r.json.data).toEqual([
      expect.objectContaining({ date: "2026-06-04", business_date: "2026-06-04", hour: 23, order_count: 1, gross_cents: 2000, net_cents: 1800, tip_cents: 100 }),
      expect.objectContaining({ date: "2026-06-05", business_date: "2026-06-05", hour: 0, order_count: 1, gross_cents: 1000, net_cents: 1000 }),
    ]);
  });

  it("a DST day: no hour 2, and the rows tie to sales.daily", async () => {
    await mk(ID(1), { at: "2026-03-08T06:59:00Z", subtotal: 1500 }); // 01:59 EST
    await mk(ID(2), { at: "2026-03-08T07:00:00Z", subtotal: 2500, discount: 500 }); // 03:00 EDT
    await mk(ID(3), { at: "2026-03-08T07:20:00Z", subtotal: 1000, tip: 200 });
    const hourly = (await call("GET", url("2026-03-08", "2026-03-08"))).json.data as {
      hour: number; net_cents: number; gross_cents: number; order_count: number; tip_cents: number;
    }[];
    expect(hourly.map((h) => h.hour)).toEqual([1, 3]);
    expect(hourly.map((h) => h.hour)).not.toContain(2);
    const daily = (await call("GET", `/locations/${DOWNTOWN}/sales/daily?from=2026-03-08&to=2026-03-08`)).json
      .data[0];
    const sum = (k: "net_cents" | "gross_cents" | "order_count" | "tip_cents") =>
      hourly.reduce((n, h) => n + h[k], 0);
    expect(sum("net_cents")).toBe(daily.net_cents);
    expect(sum("gross_cents")).toBe(daily.gross_cents);
    expect(sum("order_count")).toBe(daily.order_count);
    expect(sum("tip_cents")).toBe(daily.tip_cents);
  });

  it("excludes voided, held and unpaid online orders (the sales.daily rules)", async () => {
    await mk(ID(1), { at: "2026-06-04T15:00:00Z" });
    await mk(ID(2), { at: "2026-06-04T15:05:00Z", status: "voided" });
    await mk(ID(3), { at: "2026-06-04T15:10:00Z", status: "draft", hold: true });
    await mk(ID(4), { at: "2026-06-04T15:15:00Z", status: "awaiting_payment" });
    await mk(ID(5), { at: "2026-06-04T15:20:00Z", status: "abandoned" });
    const r = await call("GET", url("2026-06-04", "2026-06-04"));
    expect(r.json.data).toHaveLength(1);
    expect(r.json.data[0]).toMatchObject({ hour: 11, order_count: 1 });
    const daily = (await call("GET", `/locations/${DOWNTOWN}/sales/daily?from=2026-06-04&to=2026-06-04`)).json.data[0];
    expect(daily.order_count).toBe(1);
    expect(daily.void_count).toBe(1);
  });

  it("validates the range and the location", async () => {
    expect((await call("GET", `/locations/${DOWNTOWN}/sales/hourly`)).status).toBe(422);
    expect((await call("GET", url("2026-06-05", "2026-06-04"))).status).toBe(422);
    expect((await call("GET", url("2026-01-01", "2026-12-31"))).status).toBe(422);
    expect((await call("GET", url("06/04/2026", "2026-06-05"))).status).toBe(422);
    expect((await call("GET", url("2026-06-04", "2026-06-05", ID(999)))).status).toBe(404);
  });

  it("foreign tenants see nothing; limited tokens cannot reach another location; scope is required", async () => {
    await mk(ID(1), { at: "2026-06-04T15:00:00Z" });
    const foreign = await call("GET", url("2026-06-04", "2026-06-04"), {
      who: { tenant_id: "99999999-0000-4000-8000-000000000001" },
    });
    expect(foreign.status).toBe(404);
    const limited = await call("GET", url("2026-06-04", "2026-06-04"), { who: { location_ids: [UPTOWN] } });
    expect(limited.status).toBe(403);
    expect((await call("GET", url("2026-06-04", "2026-06-04"), { scopes: ["orders:read"] })).status).toBe(403);
    expect((await call("GET", url("2026-06-04", "2026-06-04"), { scopes: ["sales:read"] })).status).toBe(200);
  });
});

describe("GET /sales/items", () => {
  it("groups by business date x item x size, skips voided lines and cancels, keeps line names", async () => {
    const PEP = "30000000-0000-0000-0000-000000000002";
    await mk(ID(1), {
      at: "2026-06-04T15:00:00Z",
      subtotal: 5000,
      lines: [
        { item: PEP, name: "Pepperoni", qty: 2, price: 1000, size: "Large" },
        { item: PEP, name: "Pepperoni", qty: 1, price: 800, size: "Small" },
        { item: PEP, name: "Pepperoni", qty: 5, price: 1000, size: "Large", voided: true },
      ],
    });
    await mk(ID(2), { at: "2026-06-04T16:00:00Z", subtotal: 1000, lines: [{ item: PEP, name: "Pepperoni (old name)", qty: 1, price: 1000, size: "Large" }] });
    await mk(ID(3), { at: "2026-06-04T17:00:00Z", status: "voided", lines: [{ item: PEP, name: "Pepperoni", qty: 9, price: 1000, size: "Large" }] });
    const r = await call("GET", "/sales/items?from=2026-06-04&to=2026-06-04");
    expect(r.status).toBe(200);
    const rows = r.json.data as Record<string, unknown>[];
    const large = rows.find((x) => x.size_name === "Large")!;
    expect(large).toMatchObject({ units: 3, order_count: 2, gross_cents: 3000, location_id: DOWNTOWN, business_date: "2026-06-04" });
    expect(rows.find((x) => x.size_name === "Small")).toMatchObject({ units: 1, order_count: 1 });
    expect(rows).toHaveLength(2);
  });

  it("honours location_id, foreign tenants and limited tokens", async () => {
    await mk(ID(1), { at: "2026-06-04T15:00:00Z", location: DOWNTOWN });
    await mk(ID(2), { at: "2026-06-04T15:00:00Z", location: UPTOWN });
    const all = await call("GET", "/sales/items?from=2026-06-04&to=2026-06-04");
    expect(all.json.data.map((x: { location_id: string }) => x.location_id).sort()).toEqual([DOWNTOWN, UPTOWN].sort());
    const one = await call("GET", `/sales/items?from=2026-06-04&to=2026-06-04&location_id=${UPTOWN}`);
    expect(one.json.data.map((x: { location_id: string }) => x.location_id)).toEqual([UPTOWN]);
    // a limited token without location_id is cut to its locations
    const limited = await call("GET", "/sales/items?from=2026-06-04&to=2026-06-04", { who: { location_ids: [UPTOWN] } });
    expect(limited.json.data.map((x: { location_id: string }) => x.location_id)).toEqual([UPTOWN]);
    // and a location outside the limit does not exist for it
    expect(
      (await call("GET", `/sales/items?from=2026-06-04&to=2026-06-04&location_id=${DOWNTOWN}`, { who: { location_ids: [UPTOWN] } })).status,
    ).toBe(404);
    const foreign = await call("GET", "/sales/items?from=2026-06-04&to=2026-06-04", {
      who: { tenant_id: "99999999-0000-4000-8000-000000000001" },
    });
    expect(foreign.json.data).toEqual([]);
  });
});

describe("tip facts (the core rule)", () => {
  const order = (over: Partial<{ tip: number; id: string }> = {}) => ({
    id: over.id ?? ID(50),
    tenant_id: DEMO_TENANT_ID,
    location_id: DOWNTOWN,
    business_date: "2026-06-04",
    currency: "USD",
    totals: { tip_cents: over.tip ?? 0 },
  });
  const cash = (id: string, over: Partial<Payment> = {}) =>
    pay(ID(50), id, { rail: "cash", ...over });
  const A = ID(201);
  const B = ID(202);
  const C = ID(203);

  it("tender tips are the truth: one fact per tipped tender, the order tip is ignored", () => {
    const facts = tipFactsForOrder(order({ tip: 999 }), [
      cash(A, { tip_cents: 300, created_at: "2026-06-04T22:00:00.000Z" }),
      pay(ID(50), B, { tip_cents: 200, created_at: "2026-06-04T22:01:00.000Z", staff_id: ID(300) }),
      cash(C, { tip_cents: 0 }),
    ]);
    expect(facts.map((f) => [f.id, f.kind, f.amount_cents])).toEqual([
      [`tip_${A}`, "cash_on_tender", 300],
      [`tip_${B}`, "card", 200],
    ]);
    expect(facts[1]!.staff_id).toBe(ID(300));
    for (const f of facts) expect(TipFactSchema.safeParse(f).success).toBe(true);
  });

  it("no tender tip: the order tip is ONE online fact; unpaid orders have none", () => {
    expect(
      tipFactsForOrder(order({ tip: 500 }), [cash(A), cash(B)]).map((f) => [f.id, f.kind, f.amount_cents, f.payment_id]),
    ).toEqual([[`tip_online_${ID(50)}`, "online", 500, null]]);
    expect(tipFactsForOrder(order({ tip: 500 }), [])).toEqual([]);
    expect(tipFactsForOrder(order({ tip: 500 }), [cash(A, { status: "pending" })])).toEqual([]);
    expect(tipFactsForOrder(order({ tip: 0 }), [cash(A)])).toEqual([]);
  });

  it("refunds come off the tip first, as signed adjustments that never rewrite the fact", () => {
    const refund = (id: string, n: number, at: string) => ({ id, amount_cents: n, at, processor_ref: null, reason: null });
    const p = cash(A, {
      amount_cents: 1000,
      tip_cents: 300,
      refunded_cents: 800,
      status: "refunded",
      refunds: [refund("r1", 100, "2026-06-04T23:00:00.000Z"), refund("r2", 700, "2026-06-04T23:30:00.000Z")],
    });
    const facts = tipFactsForOrder(order(), [p]);
    expect(facts.map((f) => [f.id, f.kind, f.amount_cents, f.adjusts ?? null])).toEqual([
      [`tip_${A}`, "cash_on_tender", 300, null],
      [`tipadj_${A}_c100`, "adjustment", -100, `tip_${A}`],
      [`tipadj_${A}_c300`, "adjustment", -200, `tip_${A}`],
    ]);
    // Σ facts = the tip that survives (0); the base refund (500) never touches it
    expect(facts.reduce((n, f) => n + f.amount_cents, 0)).toBe(0);
    // the same state yields the same facts (replay)
    expect(tipFactsForOrder(order(), [p])).toEqual(facts);
    // refund still inside the base: no adjustment
    const small = tipFactsForOrder(order(), [cash(A, { tip_cents: 300, refunded_cents: 0 })]);
    expect(small).toHaveLength(1);
  });

  it("an online tip is hit only by the refund BEYOND the base (matches netSettledBaseCents)", () => {
    const refund = (id: string, n: number, at: string) => ({ id, amount_cents: n, at, processor_ref: null, reason: null });
    const facts = tipFactsForOrder(order({ tip: 500 }), [
      cash(A, { amount_cents: 1000, refunded_cents: 1200, refunds: [refund("r1", 1200, "2026-06-04T23:00:00.000Z")] }),
      cash(B, { amount_cents: 1500, refunded_cents: 1500, refunds: [refund("r2", 1500, "2026-06-04T23:10:00.000Z")], created_at: "2026-06-04T22:05:00.000Z" }),
    ]);
    // base 2500; refunds 1200 + 1500 = 2700 -> 200 of the tip is gone
    expect(facts.map((f) => [f.kind, f.amount_cents])).toEqual([
      ["online", 500],
      ["adjustment", -200],
    ]);
    expect(facts[1]!.adjusts).toBe(`tip_online_${ID(50)}`);
  });
});

describe("GET /tips", () => {
  async function seed() {
    await mk(ID(1), { at: "2026-06-04T15:00:00Z" });
    await getPosDriver().upsertPayment(pay(ID(1), ID(101), { rail: "cash", amount_cents: 2000, tip_cents: 300, created_at: "2026-06-04T15:01:00.000Z" }));
    await mk(ID(2), { at: "2026-06-04T16:00:00Z", tip: 400 });
    await getPosDriver().upsertPayment(pay(ID(2), ID(102), { created_at: "2026-06-04T16:01:00.000Z" }));
    await mk(ID(3), { at: "2026-06-04T17:00:00Z", tip: 700, status: "awaiting_payment" }); // unpaid: no facts
    await mk(ID(4), { at: "2026-06-04T18:00:00Z", location: UPTOWN });
    await getPosDriver().upsertPayment(pay(ID(4), ID(104), { location_id: UPTOWN, rail: "cash", tip_cents: 50, created_at: "2026-06-04T18:01:00.000Z" }));
  }

  it("lists the facts in range, validated against TipFactSchema, and pages by cursor", async () => {
    await seed();
    const all = await call("GET", "/tips?from=2026-06-04&to=2026-06-04");
    expect(all.status).toBe(200);
    const facts = all.json.data as { id: string; kind: string; amount_cents: number; location_id: string }[];
    expect(facts.map((f) => [f.kind, f.amount_cents])).toEqual([
      ["cash_on_tender", 300],
      ["online", 400],
      ["cash_on_tender", 50],
    ]);
    for (const f of facts) expect(TipFactSchema.safeParse(f).success).toBe(true);
    const p1 = await call("GET", "/tips?from=2026-06-04&to=2026-06-04&limit=2");
    expect(p1.json.data).toHaveLength(2);
    expect(p1.json.next_cursor).toBeTruthy();
    const p2 = await call("GET", `/tips?from=2026-06-04&to=2026-06-04&limit=2&cursor=${p1.json.next_cursor}`);
    expect(p2.json.data.map((f: { id: string }) => f.id)).toEqual([facts[2]!.id]);
    expect(p2.json.next_cursor).toBeNull();
    // paging never repeats or skips
    expect([...p1.json.data, ...p2.json.data].map((f: { id: string }) => f.id)).toEqual(facts.map((f) => f.id));
  });

  it("filters by location, honours limited tokens and foreign tenants", async () => {
    await seed();
    const up = await call("GET", `/tips?from=2026-06-04&to=2026-06-04&location_id=${UPTOWN}`);
    expect(up.json.data.map((f: { location_id: string }) => f.location_id)).toEqual([UPTOWN]);
    const limited = await call("GET", "/tips?from=2026-06-04&to=2026-06-04", { who: { location_ids: [UPTOWN] } });
    expect(limited.json.data).toHaveLength(1);
    expect(
      (await call("GET", `/tips?from=2026-06-04&to=2026-06-04&location_id=${DOWNTOWN}`, { who: { location_ids: [UPTOWN] } })).status,
    ).toBe(404);
    expect(
      (await call("GET", "/tips?from=2026-06-04&to=2026-06-04", { who: { tenant_id: "99999999-0000-4000-8000-000000000001" } })).json.data,
    ).toEqual([]);
    expect((await call("GET", "/tips?from=2026-06-04&to=2026-06-04", { scopes: ["sales:read"] })).status).toBe(403);
    expect((await call("GET", "/tips?from=2026-06-04&to=2026-06-04&limit=0")).status).toBe(422);
    expect((await call("GET", "/tips?from=2026-06-04")).status).toBe(422);
  });

  it("a refund adds a signed adjustment fact; the list equals the facts the events carry", async () => {
    await seed();
    const d = getPosDriver();
    await d.reservePaymentRefund(ID(101), 2100, "ref-1", { at: "2026-06-04T20:00:00.000Z" } as never);
    const facts = (await call("GET", "/tips?from=2026-06-04&to=2026-06-04")).json.data as {
      id: string; kind: string; amount_cents: number; adjusts?: string;
    }[];
    const adj = facts.filter((f) => f.kind === "adjustment");
    expect(adj).toHaveLength(1);
    expect(adj[0]).toMatchObject({ amount_cents: -300, adjusts: `tip_${ID(101)}` });
  });
});

describe("GET /locations/{id}/kitchen-load", () => {
  it("counts active orders, items, statuses and the quoted time", async () => {
    vi.setSystemTime(new Date("2026-06-04T18:00:00Z"));
    for (let i = 1; i <= 5; i++) await mk(ID(i), { at: `2026-06-04T17:${50 + i}:00Z` });
    await mk(ID(6), { at: "2026-06-04T17:30:00Z", status: "completed" });
    await mk(ID(7), { at: "2026-06-04T17:40:00Z", status: "voided" });
    await mk(ID(8), { at: "2026-06-04T17:45:00Z", status: "draft", hold: true });
    await mk(ID(9), { at: "2026-06-04T17:46:00Z", status: "awaiting_payment" });
    await mk(ID(10), { at: "2026-06-04T17:00:00Z", location: UPTOWN });
    vi.setSystemTime(new Date("2026-06-04T18:00:00Z"));
    const r = await call("GET", `/locations/${DOWNTOWN}/kitchen-load`);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      location_id: DOWNTOWN,
      active_orders: 5,
      active_items: 5,
      level: "busy",
      accepting_orders: true,
      orders_last_15m: 5,
      as_of: "2026-06-04T18:00:00.000Z",
    });
    expect(r.json.by_status).toEqual({ placed: 5 });
    expect(r.json.quoted_ready_minutes).toBeGreaterThanOrEqual(6);
    expect(r.json.oldest_active_placed_at).toBe("2026-06-04T17:51:00.000Z");
  });

  it("an idle kitchen, a window cut-off, 404 for foreign and limited tokens", async () => {
    await mk(ID(1), { at: "2026-06-03T20:00:00Z" }); // > 12 h old: off the board
    vi.setSystemTime(new Date("2026-06-04T18:00:00Z"));
    const r = await call("GET", `/locations/${DOWNTOWN}/kitchen-load`);
    expect(r.json).toMatchObject({ active_orders: 0, level: "idle", oldest_active_placed_at: null });
    expect((await call("GET", `/locations/${DOWNTOWN}/kitchen-load`, { who: { tenant_id: "99999999-0000-4000-8000-000000000001" } })).status).toBe(404);
    expect((await call("GET", `/locations/${DOWNTOWN}/kitchen-load`, { who: { location_ids: [UPTOWN] } })).status).toBe(403);
    expect((await call("GET", `/locations/${DOWNTOWN}/kitchen-load`, { scopes: ["sales:read"] })).status).toBe(403);
  });

  it("levels follow the reference thresholds; not accepting orders is slammed", () => {
    const mkOrders = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        id: String(i), fulfillment_status: "preparing", placed_at: "2026-06-04T17:59:00Z",
        lines: [{ quantity: 2, voided: false }, { quantity: 9, voided: true }],
      })) as unknown as CoreOrder[];
    const level = (n: number, accepting = true) =>
      buildKitchenLoad({ location_id: "l", orders: mkOrders(n), prep_minutes: 15, accepting_orders: accepting, now: new Date("2026-06-04T18:00:00Z") });
    expect([0, 1, 2, 4, 5, 8, 9].map((n) => level(n).level)).toEqual(["idle", "idle", "normal", "normal", "busy", "busy", "slammed"]);
    expect(level(3).active_items).toBe(6);
    expect(level(1, false).level).toBe("slammed");
    expect(level(6).quoted_ready_minutes).toBe(15 + 4 * 2);
  });
});

describe("tip events (mock outbox twin of core_trg_payments)", () => {
  const tipRows = () => memoryOutbox.rows.filter((r) => r.event_type.startsWith("tip."));

  it("tip.recorded once per tipped capture; replays and re-captures emit nothing", async () => {
    const d = getPosDriver();
    await mk(ID(1), { at: "2026-06-04T15:00:00Z" });
    await d.upsertPayment(pay(ID(1), ID(101), { status: "pending", tip_cents: 300 }));
    expect(tipRows()).toHaveLength(0);
    await d.upsertPayment(pay(ID(1), ID(101), { tip_cents: 300 }));
    await d.upsertPayment(pay(ID(1), ID(101), { tip_cents: 300 }));
    await d.upsertPayment(pay(ID(1), ID(101), { tip_cents: 300, updated_at: "2026-06-04T23:00:00.000Z" }));
    expect(tipRows().map((r) => [r.event_type, r.row_snapshot?.fact_id])).toEqual([["tip.recorded", `tip_${ID(101)}`]]);
  });

  it("the online fact comes from the FIRST settled tender only", async () => {
    const d = getPosDriver();
    await mk(ID(2), { at: "2026-06-04T15:00:00Z", tip: 500 });
    await d.upsertPayment(pay(ID(2), ID(102), { amount_cents: 1000 }));
    await d.upsertPayment(pay(ID(2), ID(103), { amount_cents: 1500 }));
    expect(tipRows().map((r) => r.row_snapshot?.fact_id)).toEqual([`tip_online_${ID(2)}`]);
  });

  it("refunds emit tip.adjusted with cumulative ids; a replayed refund state emits nothing new", async () => {
    const d = getPosDriver();
    await mk(ID(1), { at: "2026-06-04T15:00:00Z" });
    await d.upsertPayment(pay(ID(1), ID(101), { rail: "cash", tip_cents: 300 }));
    await d.reservePaymentRefund(ID(101), 100, "r1", {} as never);
    await d.reservePaymentRefund(ID(101), 100, "r1", {} as never); // replay of the same request
    await d.reservePaymentRefund(ID(101), 1500, "r2", {} as never); // lands mostly on the base
    const adj = tipRows().filter((r) => r.event_type === "tip.adjusted").map((r) => r.row_snapshot?.fact_id);
    expect(adj).toEqual([`tipadj_${ID(101)}_c100`, `tipadj_${ID(101)}_c300`]);
  });

  it("hydrates to a valid TipFact equal to the one GET /tips returns; a vanished fact is dropped", async () => {
    const d = getPosDriver();
    await mk(ID(1), { at: "2026-06-04T15:00:00Z" });
    await d.upsertPayment(pay(ID(1), ID(101), { rail: "cash", tip_cents: 300, created_at: "2026-06-04T15:01:00.000Z" }));
    await d.reservePaymentRefund(ID(101), 200, "r1", { at: "2026-06-04T20:00:00.000Z" } as never);
    const rows = tipRows();
    expect(rows.map((r) => r.event_type)).toEqual(["tip.recorded", "tip.adjusted"]);
    const listed = (await call("GET", "/tips?from=2026-06-04&to=2026-06-04")).json.data as { id: string }[];
    for (const row of rows) {
      const ev = await hydrateEvent(row);
      expect(ev).not.toBeNull();
      expect(ev!.type).toBe(row.event_type);
      expect(ev!.source).toBe("openpizza_pos");
      const data = ev!.data as { id: string };
      expect(listed.find((f) => f.id === data.id)).toEqual(data);
    }
    // a fact id that no longer exists is dropped, not invented
    expect(await hydrateEvent({ ...rows[1]!, row_snapshot: { fact_id: `tipadj_${ID(101)}_c999` } })).toBeNull();
    // and a recorded row cannot be served as an adjustment
    expect(await hydrateEvent({ ...rows[0]!, event_type: "tip.adjusted" })).toBeNull();
  });

  it("is publishable by POS, advertised in capabilities, and held orders stay quiet", async () => {
    expect(canPublishEvent("pos", "tip.recorded")).toBe(true);
    expect(canPublishEvent("pos", "tip.adjusted")).toBe(true);
    const caps = (await call("GET", "/capabilities")).json;
    expect(caps.events).toEqual(expect.arrayContaining(["tip.recorded", "tip.adjusted"]));
    for (const e of caps.events) expect(EVENT_TYPES).toContain(e);
    expect(caps.features).toMatchObject({ "sales.hourly": true, "sales.items": true, "tips.list": true, "kitchen.load": true });
    // an in-store draft with no hold is never announced: its tender emits no tip event
    const d = getPosDriver();
    await mk(ID(9), { at: "2026-06-04T15:00:00Z", status: "draft" });
    memoryOutbox.clear();
    await d.upsertPayment(pay(ID(9), ID(109), { rail: "cash", tip_cents: 100 }));
    expect(memoryOutbox.rows).toHaveLength(0);
  });
});
