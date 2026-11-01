/**
 * PR #31 review fixes (F1..F7): the NULL-country boundary, fee gating/cap/visibility,
 * scheduled-hold lifecycle, idempotency over priced inputs, provider-owned deliveries.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Principal } from "@openpizza/core";
import {
  getPosDriver,
  DEMO_LOCATION_DOWNTOWN_ID,
  DEMO_TENANT_ID,
  type DeliveryRecord,
} from "@/lib/db";
import { resetMockOnline, resetMockOrders, resetMockPayments } from "@/lib/db/mock";
import { ensureCustomer } from "@/lib/shop/auth";
import { buildReceipt } from "@/lib/payments/receipt";
import { buildSalesReport } from "@/lib/reports";
import { DEV_TOKEN } from "./auth";
import { handleV1 } from "./v1";
import { memoryOutbox } from "./outbox";

const NOW = new Date("2026-06-04T22:00:00.000Z");
const DAY = 86_400_000;

const mk = (scopes: string[], module: string | null = "catering", extra: Partial<Principal> = {}): Principal => ({
  kind: "service",
  id: "t",
  tenant_id: DEMO_TENANT_ID,
  location_ids: null,
  scopes,
  module,
  ...extra,
});
const CAT = () =>
  mk(["orders:read", "orders:write", "quotes:write", "menu:read", "customers:read", "customers:write", "payments:read", "payments:write", "deliveries:read", "deliveries:write", "sales:read"]);

async function call(method: string, path: string, opts: { body?: unknown; p?: Principal; now?: Date; key?: string } = {}) {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.key) headers["idempotency-key"] = opts.key;
  if (!opts.p) headers.authorization = `Bearer ${DEV_TOKEN}`;
  const res = await handleV1(
    new Request(`https://pos.test/api/v1${path}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    }),
    path.split("?")[0]!.split("/").filter(Boolean),
    { now: () => opts.now ?? NOW, principal: opts.p },
  );
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

async function body(extra: Record<string, unknown> = {}) {
  const { json: menu } = await call("GET", `/locations/${DEMO_LOCATION_DOWNTOWN_ID}/menu`);
  const item = menu.categories.flatMap((c: { items: unknown[] }) => c.items).find((i: { name: string }) => i.name === "Pepperoni");
  const large = item.sizes.find((s: { name: string }) => s.name.startsWith("Large"));
  return {
    location_id: DEMO_LOCATION_DOWNTOWN_ID,
    lines: [{ item_id: item.id, size_id: large.id, quantity: 1 }],
    channel: "agent",
    source: { type: "agent_api" },
    payment_intent: "prepaid",
    ...extra,
  } as Record<string, unknown>;
}
const ID = (n: number) => `f6000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

beforeEach(() => {
  resetMockOrders();
  resetMockPayments();
  resetMockOnline();
  memoryOutbox.clear();
  vi.restoreAllMocks();
});

describe("F1: a location with no stored country reads as US", () => {
  it("shop customer is found by lookup, read by id and not duplicated by POST /customers", async () => {
    const d = getPosDriver();
    expect((await d.listLocations(DEMO_TENANT_ID))[0]!.country ?? null).toBeNull(); // matches seed.sql
    const c = await ensureCustomer({ tenantId: DEMO_TENANT_ID, email: "shopper@y.co", name: "A B", phone: "415-555-0199" });
    const found = await call("GET", `/customers/lookup?phone=${encodeURIComponent("+14155550199")}`, { p: CAT() });
    expect(found.status).toBe(200);
    expect(found.json.id).toBe(c.id);
    expect(found.json.phone).toBe("+14155550199");
    const up = await call("POST", "/customers", { p: CAT(), body: { phone: "+14155550199", name: "Same Person" } });
    expect(up.status).toBe(200);
    expect(up.json.id).toBe(c.id);
  });

  it("a STORED non-US/CA country is never guessed over", async () => {
    const d = getPosDriver();
    const real = d.listLocations.bind(d);
    vi.spyOn(d, "listLocations").mockImplementation(async (t: string) =>
      (await real(t)).map((l) => ({ ...l, country: "MX" })),
    );
    const c = await ensureCustomer({ tenantId: DEMO_TENANT_ID, email: "mx@y.co", phone: "5512345678" });
    const g = await call("GET", `/customers/${c.id}`, { p: CAT() });
    expect(g.json.phone).toBeNull();
    const lookup = await call("GET", `/customers/lookup?phone=5512345678`, { p: CAT() });
    expect(lookup.status).toBe(404);
  });

  it("the admin flow can set a country on a new location; default stays unset", async () => {
    const d = getPosDriver();
    const a = await d.createLocation({ tenant_id: DEMO_TENANT_ID, name: "Plain" });
    const b = await d.createLocation({ tenant_id: DEMO_TENANT_ID, name: "Abroad", country: "GB" });
    expect(a.country ?? null).toBeNull();
    expect(b.country).toBe("GB");
  });
});

describe("F2: fee lines", () => {
  const fee = { code: "svc", label: "Catering service fee", amount_cents: 600 };

  it("only the catering module may send fees (quote and order)", async () => {
    const other = mk(["orders:write", "quotes:write", "orders:read", "menu:read"], "pizza_mcp");
    const q = await call("POST", "/quotes", { p: other, body: { ...(await body()), payment_intent: undefined, fees: [fee] } });
    expect(q.status).toBe(403);
    const o = await call("POST", "/orders", { p: other, body: await body({ id: ID(1), fees: [fee] }) });
    expect(o.status).toBe(403);
    const ok = await call("POST", "/orders", { p: CAT(), body: await body({ id: ID(2), fees: [fee] }) });
    expect(ok.status).toBe(201);
  });

  it("refuses gratuity lines (use tip), duplicate codes, and totals over 50% of the subtotal", async () => {
    const grat = await call("POST", "/orders", { p: CAT(), body: await body({ id: ID(3), fees: [{ ...fee, kind: "gratuity" }] }) });
    expect(grat.status).toBe(422);
    expect(grat.json.detail).toMatch(/tip/);
    const dup = await call("POST", "/orders", { p: CAT(), body: await body({ id: ID(4), fees: [fee, fee] }) });
    expect(dup.status).toBe(422);
    const big = await call("POST", "/orders", { p: CAT(), body: await body({ id: ID(5), fees: [{ code: "x", label: "x", percent_bps: 6000 }] }) });
    expect(big.status).toBe(422);
    const huge = await call("POST", "/orders", { p: CAT(), body: await body({ id: ID(6), fees: [{ code: "x", label: "x", amount_cents: 500_000 }] }) });
    expect(huge.status).toBe(422);
    const edge = await call("POST", "/orders", { p: CAT(), body: await body({ id: ID(7), fees: [{ code: "x", label: "x", percent_bps: 5000 }] }) });
    expect(edge.status).toBe(201);
  });

  it("the fee is on the receipt and in the reports, tying sales to the order total", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const dayPath = (d: string) => `/locations/${DEMO_LOCATION_DOWNTOWN_ID}/sales/daily?from=${d}&to=${d}`;
    await getPosDriver().getOrder(ID(8)); // warm the lazily seeded kitchen orders
    const base = await call("GET", dayPath("2026-06-04"), { p: CAT() });
    const o = await call("POST", "/orders", { p: CAT(), body: await body({ id: ID(8), fees: [fee] }) });
    expect(o.status).toBe(201);
    const order = (await getPosDriver().getOrder(ID(8)))!;
    const r = buildReceipt(order, []);
    expect(r.fees).toEqual([{ label: "Catering service fee", amountCents: 600 }]);
    expect(r.feesCents).toBe(600);
    expect(r.subtotalCents - r.discountCents + r.feesCents + r.taxCents + r.tipCents).toBe(r.totalCents);

    const report = buildSalesReport({
      tenantId: DEMO_TENANT_ID,
      locationId: null,
      orders: [{ ...order, status: "paid" }],
      payments: [],
      range: {},
      categoryOf: () => null,
      locationName: () => "x",
    } as never);
    expect(report.order_fees_cents).toBe(600);

    await getPosDriver().updateOrderStatus(ID(8), "paid");
    // /v1 daily: net + tax + tip + service fee = total.
    const date = o.json.business_date;
    const daily = await call("GET", dayPath(date), { p: CAT() });
    expect(daily.status).toBe(200);
    const sum = (r: { json: { data: Record<string, number>[] } }, k: string) =>
      r.json.data.reduce((n, d) => n + (d[k] ?? 0), 0);
    const delta = (k: string) => sum(daily, k) - sum(base, k);
    expect(delta("service_fee_cents")).toBe(600);
    expect(
      delta("net_cents") + delta("tax_cents") + delta("tip_cents") + delta("service_fee_cents") + delta("delivery_fee_cents"),
    ).toBe(o.json.totals.total_cents);
    vi.useRealTimers();
  });
});

describe("F3 / F4: scheduled holds", () => {
  const sched = (extra: Record<string, unknown> = {}) =>
    ({ hold: { reason: "scheduled", ttl_seconds: 3600 }, payment_intent: "invoice", ...extra });

  it("only catering (or a terminal) may ask for a scheduled hold", async () => {
    const other = mk(["orders:write", "orders:read", "quotes:write", "menu:read"], "pizza_mcp");
    const denied = await call("POST", "/orders", { p: other, body: await body({ id: ID(10), ...sched() }) });
    expect(denied.status).toBe(403);
    const terminal = mk(["orders:write", "orders:read", "quotes:write", "menu:read", "orders:place_direct"], "kiosk");
    const t = await call("POST", "/orders", { p: terminal, body: await body({ id: ID(11), channel: "in_store", ...sched() }) });
    expect(t.status).toBe(201);
    const c = await call("POST", "/orders", { p: CAT(), body: await body({ id: ID(12), ...sched() }) });
    expect(c.status).toBe(201);
  });

  it("a PAID scheduled hold still releases after its hold expired (409 captured_money is gone)", async () => {
    const o = await call("POST", "/orders", { p: CAT(), body: await body({ id: ID(13), ...sched() }) });
    expect(o.status).toBe(201);
    await getPosDriver().upsertPayment({
      id: ID(213),
      order_id: ID(13),
      tenant_id: DEMO_TENANT_ID,
      location_id: DEMO_LOCATION_DOWNTOWN_ID,
      rail: "stripe_online",
      status: "captured",
      amount_cents: o.json.totals.total_cents - o.json.totals.tip_cents,
      tip_cents: 0,
      application_fee_cents: 0,
      currency: "USD",
      charge_id: "ch_1",
      connect_account_id: null,
      crypto_tx_hash: null,
      crypto_chain: null,
      cash_tendered_cents: null,
      cash_change_cents: null,
      refunded_cents: 0,
      simulated: true,
      raw: null,
      created_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
    } as never);
    // The card payment alone does not release a scheduled order.
    expect((await getPosDriver().getOrder(ID(13)))!.status).toBe("draft");
    const later = new Date(NOW.getTime() + 2 * DAY);
    const r = await call("POST", `/orders/${ID(13)}/release`, { p: CAT(), body: {}, now: later });
    expect(r.status).toBe(200);
    expect(r.json.fulfillment_status).not.toBe("held");
    expect((await getPosDriver().getOrder(ID(13)))!.status).not.toBe("draft");
  });

  it("an UNPAID expired scheduled hold is still voided on release", async () => {
    await call("POST", "/orders", { p: CAT(), body: await body({ id: ID(14), ...sched() }) });
    const r = await call("POST", `/orders/${ID(14)}/release`, { p: CAT(), body: {}, now: new Date(NOW.getTime() + 2 * DAY) });
    expect(r.status).toBe(409);
    expect((await getPosDriver().getOrder(ID(14)))!.status).toBe("voided");
  });
});

describe("idempotent replay compares every priced input", () => {
  it("fees, tax_exempt and tip changes under the same id are IDEMPOTENCY_CONFLICT; the same request replays", async () => {
    const withDiscount = () => CAT();
    const b = await body({ id: ID(20), fees: [{ code: "svc", label: "S", amount_cents: 300 }], tip: { amount_cents: 100 } });
    expect((await call("POST", "/orders", { p: withDiscount(), body: b })).status).toBe(201);
    const same = await call("POST", "/orders", { p: withDiscount(), body: b });
    expect(same.status).toBe(200);
    for (const change of [
      { fees: [{ code: "svc", label: "S", amount_cents: 400 }] },
      { fees: undefined },
      { tip: { amount_cents: 200 } },
      { tip: undefined },
      { tax_exempt: true },
    ]) {
      const r = await call("POST", "/orders", { p: mk([...CAT().scopes, "orders:discount"]), body: { ...b, ...change } });
      expect(r.status, JSON.stringify(change)).toBe(409);
    }
  });
});

describe("deliveries.updateStatus only for partner-pushed providers", () => {
  it("refuses doordash_drive and never touches its ids", async () => {
    const o = await call("POST", "/orders", { p: CAT(), body: await body({ id: ID(30) }) });
    const rec: DeliveryRecord = {
      id: ID(230),
      order_id: o.json.id,
      tenant_id: DEMO_TENANT_ID,
      location_id: DEMO_LOCATION_DOWNTOWN_ID,
      provider: "doordash_drive",
      status: "dispatched",
      zone_id: null,
      fee_cents: 300,
      currency: "USD",
      eta_minutes: 40,
      provider_delivery_id: "dd_real_1",
      tracking_ref: "https://dd/track/1",
      dropoff: { line1: "1 Main", city: "T", region: "NY", postal_code: "10001", country: "US" },
      driver_name: null,
      driver_phone: null,
      simulated: false,
      created_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
    };
    await getPosDriver().upsertDelivery(rec);
    const r = await call("POST", `/deliveries/${rec.id}/status`, {
      p: CAT(),
      body: { status: "delivered", provider_delivery_id: "evil", tracking_url: "https://evil.example/x" },
    });
    expect(r.status).toBe(409);
    expect(r.json.details?.reason).toBe("provider_owned");
    expect(await getPosDriver().getDelivery(rec.id)).toMatchObject({
      status: "dispatched",
      provider_delivery_id: "dd_real_1",
      tracking_ref: "https://dd/track/1",
    });
  });

  it("the legacy cancel writer no longer overwrites a delivery that finished meanwhile", async () => {
    const { cancelDeliveryForOrder } = await import("@/lib/delivery/service");
    const o = await call("POST", "/orders", { p: CAT(), body: await body({ id: ID(31) }) });
    const rec: DeliveryRecord = {
      id: ID(231), order_id: o.json.id, tenant_id: DEMO_TENANT_ID, location_id: DEMO_LOCATION_DOWNTOWN_ID,
      provider: "openpizza_driver", status: "delivered", zone_id: null, fee_cents: 0, currency: "USD", eta_minutes: null,
      provider_delivery_id: null, tracking_ref: null,
      dropoff: { line1: "1", city: "T", region: "NY", postal_code: "1", country: "US" },
      driver_name: null, driver_phone: null, simulated: false, created_at: NOW.toISOString(), updated_at: NOW.toISOString(),
    };
    await getPosDriver().upsertDelivery(rec);
    const out = await cancelDeliveryForOrder(o.json.id);
    expect(out?.status).toBe("delivered");
  });
});
