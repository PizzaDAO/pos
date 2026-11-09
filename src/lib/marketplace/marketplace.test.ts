/**
 * Marketplace inbox: signature verification, provider -> POS mapping, idempotent
 * ingest, acceptance, and the paid / balance / drawer / report behaviour.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEMO_LOCATION_DOWNTOWN_ID,
  DEMO_TENANT_ID,
  getPosDriver,
  type MarketplaceSettings,
  type Order,
} from "@/lib/db";
import { resetMockOrders } from "@/lib/db/mock";
import { buildTickets, DEFAULT_KDS_THRESHOLDS } from "@/lib/kds/board";
import { selectOpenOrders } from "@/lib/payments/open-orders";
import { orderBalanceFromPayments } from "@/lib/payments/service";
import { buildSalesReport } from "@/lib/reports";
import { getAdapter } from "./adapters";
import { mapUberOrder } from "./adapters/ubereats";
import {
  buildSimulatedOrder,
  signSimulatedWebhook,
  SIMULATOR_SIGNATURE_HEADER,
} from "./adapters/simulator";
import { hmacSha256Hex } from "./crypto";
import { SIMULATOR_DEV_SECRET } from "./env";
import { mapToCreateOrderInput, marketplaceOrderId } from "./mapping";
import { ingestMarketplaceWebhook, respondToMarketplaceOrder } from "./service";
import { MarketplaceError } from "./types";

const T = DEMO_TENANT_ID;
const L = DEMO_LOCATION_DOWNTOWN_ID;

const ON: MarketplaceSettings = {
  enabled: true,
  auto_accept: false,
  providers: { simulator: { enabled: true, store_id: null } },
};

async function configure(m: MarketplaceSettings | null) {
  if (m) await getPosDriver().setMarketplaceSettings(T, L, m);
}

function simDelivery(seed = 1234, externalId?: string) {
  return signSimulatedWebhook(
    buildSimulatedOrder(seed, { externalId }),
    SIMULATOR_DEV_SECRET,
  );
}

async function ingestSim(seed = 1234, externalId?: string) {
  const s = simDelivery(seed, externalId);
  return ingestMarketplaceWebhook({
    provider: "simulator",
    tenantId: T,
    locationId: L,
    rawBody: s.rawBody,
    headers: s.headers,
  });
}

beforeEach(async () => {
  resetMockOrders();
  await getPosDriver().setMarketplaceSettings(T, L, {
    enabled: false,
    auto_accept: false,
    providers: {},
  });
});
afterEach(() => vi.unstubAllEnvs());

describe("signature verification", () => {
  const body = '{"hello":"world"}';

  it("accepts a correct HMAC and rejects tampering, wrong secret, missing header", () => {
    const sim = getAdapter("simulator");
    const good = hmacSha256Hex("s3cret", body);
    const h = { [SIMULATOR_SIGNATURE_HEADER]: good };
    expect(sim.verifyWebhook({ rawBody: body, headers: h }, "s3cret")).toBe(
      true,
    );
    expect(
      sim.verifyWebhook({ rawBody: body + " ", headers: h }, "s3cret"),
    ).toBe(false);
    expect(sim.verifyWebhook({ rawBody: body, headers: h }, "other")).toBe(
      false,
    );
    expect(sim.verifyWebhook({ rawBody: body, headers: {} }, "s3cret")).toBe(
      false,
    );
    expect(
      sim.verifyWebhook(
        { rawBody: body, headers: { [SIMULATOR_SIGNATURE_HEADER]: "zz" } },
        "s3cret",
      ),
    ).toBe(false);
    expect(sim.verifyWebhook({ rawBody: body, headers: h }, "")).toBe(false);
  });

  it("each real provider reads its own header", () => {
    const sig = hmacSha256Hex("k", body);
    expect(
      getAdapter("ubereats").verifyWebhook(
        { rawBody: body, headers: { "x-uber-signature": sig } },
        "k",
      ),
    ).toBe(true);
    expect(
      getAdapter("ubereats").verifyWebhook(
        { rawBody: body, headers: { "x-doordash-signature": sig } },
        "k",
      ),
    ).toBe(false);
    expect(
      getAdapter("doordash").verifyWebhook(
        { rawBody: body, headers: { "x-doordash-signature": sig } },
        "k",
      ),
    ).toBe(true);
    expect(
      getAdapter("grubhub").verifyWebhook(
        { rawBody: body, headers: { "x-grubhub-signature": `sha256=${sig}` } },
        "k",
      ),
    ).toBe(true);
    expect(
      getAdapter("grubhub").verifyWebhook(
        { rawBody: body, headers: { "x-grubhub-signature": sig } },
        "wrong",
      ),
    ).toBe(false);
  });

  it("ingest refuses a bad signature and stores nothing", async () => {
    await configure(ON);
    const s = simDelivery();
    await expect(
      ingestMarketplaceWebhook({
        provider: "simulator",
        tenantId: T,
        locationId: L,
        rawBody: s.rawBody,
        headers: {
          [SIMULATOR_SIGNATURE_HEADER]: hmacSha256Hex("attacker", s.rawBody),
        },
      }),
    ).rejects.toMatchObject({ code: "bad_signature" });
    expect(
      (await getPosDriver().listOrders(T, L)).filter(
        (o) => o.channel === "marketplace",
      ),
    ).toHaveLength(0);
  });
});

describe("inert by default", () => {
  it("refuses ingest while the location has the marketplace off", async () => {
    await expect(ingestSim()).rejects.toMatchObject({ code: "disabled" });
    // master on, provider off: still off
    await configure({ enabled: true, auto_accept: false, providers: {} });
    await expect(ingestSim()).rejects.toMatchObject({ code: "disabled" });
  });

  it("a real provider with no env credentials is refused (503 path)", async () => {
    await configure({
      enabled: true,
      auto_accept: false,
      providers: { doordash: { enabled: true, store_id: null } },
    });
    await expect(
      ingestMarketplaceWebhook({
        provider: "doordash",
        tenantId: T,
        locationId: L,
        rawBody: "{}",
        headers: {},
      }),
    ).rejects.toMatchObject({ code: "not_configured" });
  });

  it("never calls out: accept on a real provider without API credentials is skipped", async () => {
    vi.stubEnv("GRUBHUB_WEBHOOK_SECRET", "gh-secret"); // verify-only, no client id/secret
    await configure({
      enabled: true,
      auto_accept: false,
      providers: { grubhub: { enabled: true, store_id: null } },
    });
    const raw = JSON.stringify({
      event_type: "order.created",
      order_id: "GH-1",
      order_type: "PICKUP",
      items: [{ id: "i1", name: "Slice", quantity: 2, price: 450 }],
      tax: 74,
    });
    const fetchSpy = vi.fn();
    const res = await ingestMarketplaceWebhook({
      provider: "grubhub",
      tenantId: T,
      locationId: L,
      rawBody: raw,
      headers: { "x-grubhub-signature": hmacSha256Hex("gh-secret", raw) },
      fetch: fetchSpy as unknown as typeof fetch,
    });
    expect(res.status).toBe("created");
    const r = await respondToMarketplaceOrder(res.orderId!, "accept", {
      fetch: fetchSpy as unknown as typeof fetch,
    });
    expect(r.callback?.outcome).toBe("skipped");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(r.order.fulfillment?.marketplace?.acceptance).toBe("accepted");
  });
});

describe("mapping", () => {
  it("maps a simulated order to a marketplace POS order with channel + external id", async () => {
    const parsed = getAdapter("simulator").parseWebhook(
      simDelivery(42, "SIM-A").rawBody,
    );
    expect(parsed.kind).toBe("order");
    if (parsed.kind !== "order") return;
    const input = mapToCreateOrderInput(parsed.order, {
      tenantId: T,
      locationId: L,
    });
    expect(input.channel).toBe("marketplace");
    expect(input.source).toMatchObject({
      type: "marketplace",
      module: "simulator",
      external_ref: "SIM-A",
    });
    expect(input.id).toBe(marketplaceOrderId(T, L, "simulator", "SIM-A"));
    expect(input.fulfillment?.marketplace).toMatchObject({
      provider: "simulator",
      external_id: "SIM-A",
      acceptance: "pending",
    });
    const sub = input.items.reduce((n, i) => n + i.line_total_cents, 0);
    expect(input.totals.subtotal_cents).toBe(sub);
    expect(input.totals.total_cents).toBe(
      sub + input.totals.tax_cents + input.totals.tip_cents,
    );
    for (const i of input.items)
      expect(i.unit_price_cents * i.quantity).toBe(i.line_total_cents);
  });

  it("maps an Uber Eats order payload (modifiers, money, pickup vs delivery)", () => {
    const o = mapUberOrder({
      id: "uuid-1",
      display_id: "AB12C",
      type: "PICK_UP",
      store: { id: "store-9" },
      eater: { first_name: "Dana", phone: "+15555550100" },
      placed_at: "2026-11-09T18:00:00Z",
      cart: {
        items: [
          {
            id: "pz1",
            title: "Pepperoni",
            quantity: 2,
            price: { unit_price: { amount: 2000, currency_code: "USD" } },
            selected_modifier_groups: [
              {
                selected_items: [
                  {
                    title: "Extra cheese",
                    price: { unit_price: { amount: 200 } },
                  },
                ],
              },
            ],
          },
        ],
      },
      payment: {
        charges: {
          sub_total: { amount: 4400 },
          tax: { amount: 363 },
          total: { amount: 4763, currency_code: "USD" },
        },
      },
    });
    expect(o).toMatchObject({
      provider: "ubereats",
      externalId: "uuid-1",
      displayId: "AB12C",
      storeId: "store-9",
      fulfillment: "pickup",
      subtotalCents: 4400,
      taxCents: 363,
      totalCents: 4763,
      customerName: "Dana",
    });
    expect(o.lines[0]).toMatchObject({
      name: "Pepperoni",
      quantity: 2,
      unitPriceCents: 2000,
    });
    expect(o.lines[0]!.modifiers).toEqual([
      { name: "Extra cheese", priceCents: 200 },
    ]);
  });

  it("Uber Eats webhook is a reference; fetching it needs credentials and an OAuth token", async () => {
    vi.stubEnv("UBEREATS_CLIENT_ID", "cid");
    vi.stubEnv("UBEREATS_CLIENT_SECRET", "csecret");
    await configure({
      enabled: true,
      auto_accept: true,
      providers: { ubereats: { enabled: true, store_id: "store-9" } },
    });
    const raw = JSON.stringify({
      event_type: "orders.notification",
      meta: { resource_id: "uuid-77", status: "pos" },
      resource_href: "https://api.uber.com/v2/eats/order/uuid-77",
    });
    const calls: string[] = [];
    const fakeFetch = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      calls.push(u);
      if (u.includes("oauth"))
        return new Response(JSON.stringify({ access_token: "tok" }), {
          status: 200,
        });
      if (u.endsWith("/uuid-77")) {
        return new Response(
          JSON.stringify({
            id: "uuid-77",
            display_id: "ZZ9",
            type: "DELIVERY_BY_UBER",
            store: { id: "store-9" },
            cart: {
              items: [
                {
                  id: "a",
                  title: "Soda",
                  quantity: 1,
                  price: { unit_price: { amount: 300 } },
                },
              ],
            },
            payment: { charges: { total: { amount: 300 } } },
          }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 200 }); // accept callback
    });
    const res = await ingestMarketplaceWebhook({
      provider: "ubereats",
      tenantId: T,
      locationId: L,
      rawBody: raw,
      headers: { "x-uber-signature": hmacSha256Hex("csecret", raw) },
      fetch: fakeFetch as unknown as typeof fetch,
    });
    expect(res).toMatchObject({ status: "created", accepted: true });
    expect(
      calls.some((c) =>
        c.endsWith("/v1/delivery/order/uuid-77/accept_pos_order"),
      ),
    ).toBe(true);
    const order = (await getPosDriver().getOrder(res.orderId!))!;
    expect(order.fulfillment?.marketplace?.last_callback).toMatchObject({
      action: "accept",
      outcome: "sent",
    });
    expect(order.status).toBe("paid");
  });

  it("ignores a validly signed order for a different store", async () => {
    await configure({
      enabled: true,
      auto_accept: false,
      providers: { simulator: { enabled: true, store_id: "mine" } },
    });
    const s = signSimulatedWebhook(
      buildSimulatedOrder(5, { storeId: "someone-else" }),
      SIMULATOR_DEV_SECRET,
    );
    const res = await ingestMarketplaceWebhook({
      provider: "simulator",
      tenantId: T,
      locationId: L,
      rawBody: s.rawBody,
      headers: s.headers,
    });
    expect(res.status).toBe("ignored");
    expect(
      (await getPosDriver().listOrders(T, L)).filter(
        (o) => o.channel === "marketplace",
      ),
    ).toHaveLength(0);
  });
});

describe("idempotent ingest", () => {
  it("the same external id twice creates exactly one order", async () => {
    await configure(ON);
    const a = await ingestSim(99, "SIM-DUP");
    const b = await ingestSim(99, "SIM-DUP");
    expect(a.status).toBe("created");
    expect(b).toMatchObject({ status: "duplicate", orderId: a.orderId });
    const orders = (await getPosDriver().listOrders(T, L)).filter(
      (o) => o.channel === "marketplace",
    );
    expect(orders).toHaveLength(1);
  });

  it("concurrent deliveries still yield one order", async () => {
    await configure(ON);
    const results = await Promise.all([
      ingestSim(7, "SIM-RACE"),
      ingestSim(7, "SIM-RACE"),
      ingestSim(7, "SIM-RACE"),
    ]);
    expect(new Set(results.map((r) => r.orderId)).size).toBe(1);
    const orders = (await getPosDriver().listOrders(T, L)).filter(
      (o) => o.channel === "marketplace",
    );
    expect(orders).toHaveLength(1);
  });

  it("the id is scoped by provider and location", () => {
    expect(marketplaceOrderId(T, L, "doordash", "X")).not.toBe(
      marketplaceOrderId(T, L, "ubereats", "X"),
    );
    expect(marketplaceOrderId(T, L, "doordash", "X")).not.toBe(
      marketplaceOrderId(T, "other-loc", "doordash", "X"),
    );
  });

  it("a replayed cancel is harmless and voids the order once", async () => {
    await configure(ON);
    const created = await ingestSim(11, "SIM-CXL");
    const raw = JSON.stringify({
      event: "order.cancelled",
      order_id: "SIM-CXL",
      reason: "customer",
    });
    const h = {
      [SIMULATOR_SIGNATURE_HEADER]: hmacSha256Hex(SIMULATOR_DEV_SECRET, raw),
    };
    const input = {
      provider: "simulator" as const,
      tenantId: T,
      locationId: L,
      rawBody: raw,
      headers: h,
    };
    expect((await ingestMarketplaceWebhook(input)).status).toBe("cancelled");
    expect((await ingestMarketplaceWebhook(input)).status).toBe("cancelled");
    expect((await getPosDriver().getOrder(created.orderId!))!.status).toBe(
      "voided",
    );
  });
});

describe("acceptance", () => {
  it("auto-accept moves a new order onto the kitchen board; manual keeps it off until accepted", async () => {
    await configure({ ...ON, auto_accept: true });
    const auto = await ingestSim(21, "SIM-AUTO");
    expect(auto.accepted).toBe(true);

    await configure(ON);
    const manual = await ingestSim(22, "SIM-MANUAL");
    expect(manual.accepted).toBe(false);

    const orders = await getPosDriver().listOrders(T, L);
    const onBoard = buildTickets(
      orders,
      new Date(),
      DEFAULT_KDS_THRESHOLDS,
    ).map((t) => t.order.id);
    expect(onBoard).toContain(auto.orderId);
    expect(onBoard).not.toContain(manual.orderId);

    await respondToMarketplaceOrder(manual.orderId!, "accept");
    const after = buildTickets(
      await getPosDriver().listOrders(T, L),
      new Date(),
      DEFAULT_KDS_THRESHOLDS,
    ).map((t) => t.order.id);
    expect(after).toContain(manual.orderId);
  });

  it("accept is idempotent; reject voids; conflicting transitions are refused", async () => {
    await configure(ON);
    const a = await ingestSim(31, "SIM-ACC");
    const first = await respondToMarketplaceOrder(a.orderId!, "accept");
    const second = await respondToMarketplaceOrder(a.orderId!, "accept");
    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    await expect(
      respondToMarketplaceOrder(a.orderId!, "reject"),
    ).rejects.toBeInstanceOf(MarketplaceError);

    const b = await ingestSim(32, "SIM-REJ");
    const rej = await respondToMarketplaceOrder(b.orderId!, "reject", {
      reason: "out of dough",
    });
    expect(rej.order.status).toBe("voided");
    expect(rej.order.fulfillment?.marketplace).toMatchObject({
      acceptance: "rejected",
      rejected_reason: "out of dough",
    });
    await expect(
      respondToMarketplaceOrder(b.orderId!, "ready"),
    ).rejects.toMatchObject({ code: "invalid_state" });
  });

  it("ready needs an accepted order and records the callback", async () => {
    await configure(ON);
    const a = await ingestSim(41, "SIM-RDY");
    await expect(
      respondToMarketplaceOrder(a.orderId!, "ready"),
    ).rejects.toMatchObject({ code: "invalid_state" });
    await respondToMarketplaceOrder(a.orderId!, "accept");
    const r = await respondToMarketplaceOrder(a.orderId!, "ready");
    expect(r.order.fulfillment?.marketplace?.last_callback).toMatchObject({
      action: "ready",
      outcome: "sent",
    });
  });
});

describe("already paid: balance, open orders, drawer, reports", () => {
  async function ingestAccepted(seed: number, id: string): Promise<Order> {
    await configure({ ...ON, auto_accept: true });
    const r = await ingestSim(seed, id);
    return (await getPosDriver().getOrder(r.orderId!))!;
  }

  it("never shows a balance due", async () => {
    const order = await ingestAccepted(51, "SIM-PAID");
    expect(order.totals.total_cents).toBeGreaterThan(0);
    expect(orderBalanceFromPayments(order, [])).toBe(0);
    const rows = selectOpenOrders([order], new Map());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      balanceCents: 0,
      marketplace: { provider: "simulator", acceptance: "accepted" },
    });
  });

  it("lists a pending order (for accept / reject) with a zero balance", async () => {
    await configure(ON);
    const r = await ingestSim(52, "SIM-PEND");
    const order = (await getPosDriver().getOrder(r.orderId!))!;
    expect(selectOpenOrders([order], new Map())[0]).toMatchObject({
      balanceCents: 0,
      marketplace: { acceptance: "pending" },
    });
  });

  it("does not touch the cash drawer", async () => {
    const driver = getPosDriver();
    await driver.upsertStaff({
      id: "80000000-0000-0000-0000-0000000000ee",
      tenant_id: T,
      name: "Cashier",
      role: "cashier",
      active: true,
      created_at: new Date().toISOString(),
    });
    const shift = await driver.openShift({
      tenantId: T,
      locationId: L,
      staffId: "80000000-0000-0000-0000-0000000000ee",
      openingFloatCents: 10000,
    });
    const before = await driver.getDrawerReconciliation(shift.id);
    await ingestAccepted(53, "SIM-DRAWER");
    const after = await driver.getDrawerReconciliation(shift.id);
    expect(after.cash_sales_cents).toBe(before.cash_sales_cents);
    expect(after.expected_cents).toBe(10000);
  });

  it("appears in reports by channel, split by provider", async () => {
    const order = await ingestAccepted(54, "SIM-RPT");
    const report = buildSalesReport({
      tenantId: T,
      locationId: L,
      range: { from: "2000-01-01", to: "2999-12-31" },
      orders: [order],
      payments: [],
      categoryOf: () => null,
      locationName: () => "Downtown",
    });
    expect(report.order_count).toBe(1);
    expect(report.byChannel).toHaveLength(1);
    expect(report.byChannel[0]).toMatchObject({
      key: "marketplace:simulator",
      label: "Simulator (marketplace)",
      count: 1,
    });
  });
});
