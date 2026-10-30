/**
 * `/api/v1` contract tests against the zero-env mock driver: every response is
 * validated with the `@openpizza/core` zod schemas, plus auth/scope/tenant
 * isolation and the write flows (quote, held order, release, cancel, 86).
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  CapabilitiesSchema,
  DailySalesSchema,
  DeliverySchema,
  DrawerSessionSchema,
  EntitlementsSchema,
  LocationSchema,
  MenuSchema,
  OrderSchema,
  PaymentSchema,
  QuoteSchema,
  SalesSummarySchema,
  StaffMemberSchema,
  CustomerSchema,
  TenantSchema,
  SALES_GROUP_BY,
  orderViolations,
  pageOf,
  type Principal,
} from "@openpizza/core";
import {
  getPosDriver,
  DEMO_LOCATION_DOWNTOWN_ID,
  DEMO_LOCATION_UPTOWN_ID,
  DEMO_TENANT_ID,
  type Payment,
} from "@/lib/db";
import { resetMockOnline, resetMockOrders, resetMockPayments } from "@/lib/db/mock";
import { DEV_TOKEN } from "./auth";
import { handleV1 } from "./v1";
import { memoryOutbox } from "./outbox";

// Thursday 2026-06-04 18:00 America/New_York (store open 11:00-22:00).
const NOW = new Date("2026-06-04T22:00:00.000Z");
const OTHER_TENANT = "20000000-0000-4000-8000-0000000000bb";

function principal(scopes: string[], extra: Partial<Principal> = {}): Principal {
  return {
    kind: "service",
    id: "test-client",
    tenant_id: DEMO_TENANT_ID,
    location_ids: null,
    scopes,
    module: "guests",
    ...extra,
  };
}

async function call(
  method: string,
  path: string,
  opts: { body?: unknown; p?: Principal | "dev"; headers?: Record<string, string> } = {},
) {
  const url = `https://pos.test/api/v1${path}`;
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.p === undefined || opts.p === "dev") headers.authorization = `Bearer ${DEV_TOKEN}`;
  const req = new Request(url, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const segments = new URL(url).pathname.replace(/^\/api\/v1\/?/, "").split("/").filter(Boolean);
  const res = await handleV1(req, segments, {
    now: () => NOW,
    principal: opts.p && opts.p !== "dev" ? opts.p : undefined,
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) : null };
}

beforeEach(async () => {
  // Overrides (86s) live in module state: start every test from a clean menu.
  const driver = getPosDriver();
  for (const loc of [DEMO_LOCATION_DOWNTOWN_ID, DEMO_LOCATION_UPTOWN_ID]) {
    for (const o of await driver.listOverrides(DEMO_TENANT_ID, loc)) {
      if (o.available === false) {
        await driver.clearOverride(DEMO_TENANT_ID, loc, o.target_type, o.target_id);
      }
    }
  }
  resetMockOrders();
  resetMockPayments();
  resetMockOnline();
  memoryOutbox.clear();
});

async function pepperoniCart(qty = 1) {
  const { json: menu } = await call(
    "GET",
    `/locations/${DEMO_LOCATION_DOWNTOWN_ID}/menu`,
  );
  const item = menu.categories
    .flatMap((c: { items: unknown[] }) => c.items)
    .find((i: { name: string }) => i.name === "Pepperoni");
  const large = item.sizes.find((s: { name: string }) => s.name.startsWith("Large"));
  const mushrooms = item.modifier_groups
    .flatMap((g: { modifiers: unknown[] }) => g.modifiers)
    .find((m: { name: string }) => m.name === "Mushrooms");
  return {
    item,
    large,
    mushrooms,
    lines: [
      {
        item_id: item.id,
        size_id: large.id,
        quantity: qty,
        modifiers: [{ modifier_id: mushrooms.id, placement: "left" }],
      },
    ],
  };
}

describe("auth + routing", () => {
  it("401s without a token, before revealing routes", async () => {
    const res = await handleV1(
      new Request("https://pos.test/api/v1/nope"),
      ["nope"],
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
  });

  it("404s an unknown route once authenticated", async () => {
    const r = await call("GET", "/nope");
    expect(r.status).toBe(404);
    expect(r.json.code).toBe("NOT_FOUND");
  });

  it("answers 501 for declared-but-unsupported operations", async () => {
    const r = await call("POST", "/customers", { body: { email: "a@b.co" } });
    expect(r.status).toBe(501);
    expect(r.json.code).toBe("CAPABILITY_UNSUPPORTED");
  });

  it("enforces scopes per route from V1_ROUTES", async () => {
    const p = principal(["menu:read"]);
    expect((await call("GET", `/locations/${DEMO_LOCATION_DOWNTOWN_ID}/menu`, { p })).status).toBe(200);
    const denied = await call("GET", "/orders", { p });
    expect(denied.status).toBe(403);
    expect(denied.json.code).toBe("INSUFFICIENT_SCOPE");
    // wildcard family
    expect((await call("GET", "/orders", { p: principal(["orders:*"]) })).status).toBe(200);
    expect((await call("GET", "/orders", { p: principal(["*:read"]) })).status).toBe(200);
  });

  it("derives the tenant from the token only; foreign ids are NOT_FOUND", async () => {
    const other = principal(["*"], { tenant_id: OTHER_TENANT });
    const list = await call("GET", "/locations", { p: other });
    expect(list.status).toBe(200);
    expect(list.json.data).toEqual([]);
    const get = await call("GET", `/locations/${DEMO_LOCATION_DOWNTOWN_ID}`, { p: other });
    expect(get.status).toBe(404);
    // a tenantId parameter is ignored
    const spoof = await call("GET", `/locations?tenant_id=${DEMO_TENANT_ID}`, { p: other });
    expect(spoof.json.data).toEqual([]);
    const orders = await call("GET", "/orders", { p: other });
    expect(orders.json.data).toEqual([]);
    const staff = await call("GET", "/staff", { p: other });
    expect(staff.json.data).toEqual([]);
  });

  it("restricts a token to its location allow-list", async () => {
    const p = principal(["*"], { location_ids: [DEMO_LOCATION_UPTOWN_ID] });
    const list = await call("GET", "/locations", { p });
    expect(list.json.data.map((l: { id: string }) => l.id)).toEqual([DEMO_LOCATION_UPTOWN_ID]);
    expect((await call("GET", `/locations/${DEMO_LOCATION_DOWNTOWN_ID}`, { p })).status).toBe(403);
    expect((await call("GET", `/locations/${DEMO_LOCATION_UPTOWN_ID}`, { p })).status).toBe(200);
  });
});

describe("read API matches the contract schemas", () => {
  it("tenant / capabilities / entitlements", async () => {
    expect(TenantSchema.parse((await call("GET", "/tenant")).json).source).toBe("openpizza_pos");
    const caps = CapabilitiesSchema.parse((await call("GET", "/capabilities")).json);
    expect(caps.features["orders.hold"]).toBe(true);
    expect(caps.features["deliveries.write"]).toBe(false);
    const ent = EntitlementsSchema.parse((await call("GET", "/entitlements")).json);
    expect(ent.modules.pos?.config.inventory_owner).toBe("pos_basic");
    expect(ent.tenant_id).toBe(DEMO_TENANT_ID);
  });

  it("locations", async () => {
    const list = pageOf(LocationSchema).parse((await call("GET", "/locations")).json);
    expect(list.data).toHaveLength(2);
    const dt = list.data.find((l) => l.id === DEMO_LOCATION_DOWNTOWN_ID)!;
    expect(dt.fulfillment.delivery_zones.length).toBeGreaterThan(0);
    expect(dt.geo).not.toBeNull();
    expect(dt.address.postal_code).toBe("62701");
    expect(dt.hours.regular).toHaveLength(7);
    expect(dt.pricing.tax_rate_bps).toBe(825);
  });

  it("menu has overrides and 86 folded in, with ETag", async () => {
    const r = await call("GET", `/locations/${DEMO_LOCATION_DOWNTOWN_ID}/menu`);
    const menu = MenuSchema.parse(r.json);
    expect(menu.categories.length).toBeGreaterThan(0);
    const pizza = menu.categories.flatMap((c) => c.items).find((i) => i.name === "Pepperoni")!;
    expect(pizza.kind).toBe("pizza");
    expect(pizza.half_and_half.pricing_rule).toBe("half_price_ceil");
    const crust = pizza.modifier_groups.find((g) => g.role === "crust")!;
    expect(crust.default_modifier_ids).toHaveLength(1);
    const etag = r.headers.get("etag")!;
    const again = await call("GET", `/locations/${DEMO_LOCATION_DOWNTOWN_ID}/menu`, {
      headers: { "if-none-match": etag },
    });
    expect(again.status).toBe(304);
  });

  it("orders (seeded kitchen tickets) satisfy the pricing invariants", async () => {
    const r = await call("GET", "/orders?limit=100");
    const page = pageOf(OrderSchema).parse(r.json);
    expect(page.data.length).toBeGreaterThan(0);
    for (const o of page.data) {
      expect(orderViolations(o), o.id).toEqual([]);
    }
    const one = await call("GET", `/orders/${page.data[0]!.id}`);
    expect(OrderSchema.parse(one.json).id).toBe(page.data[0]!.id);
  });

  it("paginates orders with a keyset cursor", async () => {
    const all = (await call("GET", "/orders?limit=500")).json.data;
    expect(all.length).toBeGreaterThan(2);
    const first = (await call("GET", "/orders?limit=2")).json;
    expect(first.data).toHaveLength(2);
    expect(first.next_cursor).toBeTruthy();
    const second = (await call("GET", `/orders?limit=2&cursor=${first.next_cursor}`)).json;
    expect(second.data[0].id).toBe(all[2].id);
    const filtered = (await call("GET", "/orders?fulfillment_status=ready,preparing")).json;
    for (const o of filtered.data) {
      expect(["ready", "preparing"]).toContain(o.fulfillment_status);
    }
    expect((await call("GET", "/orders?limit=0")).status).toBe(422);
  });

  it("payments, customers, staff, drawer sessions, deliveries", async () => {
    const driver = getPosDriver();
    // a paid cash order with a customer
    const customer = await driver.upsertCustomer({
      id: "c1000000-0000-4000-8000-000000000001",
      tenant_id: DEMO_TENANT_ID,
      email: "pat@example.com",
      name: "Pat Jones",
      phone: "+15555550123",
      verified: true,
      created_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
    });
    const orderId = "d1000000-0000-4000-8000-000000000001";
    await driver.createOrder({
      id: orderId,
      tenant_id: DEMO_TENANT_ID,
      location_id: DEMO_LOCATION_DOWNTOWN_ID,
      channel: "online_pickup",
      currency: "USD",
      items: [],
      discount_cents: 0,
      totals: {
        subtotal_cents: 0,
        discount_cents: 0,
        taxable_cents: 0,
        tax_cents: 0,
        tip_cents: 0,
        total_cents: 0,
      },
      notes: null,
      customer_id: customer.id,
      status: "paid",
    });
    const pay: Payment = {
      id: "e1000000-0000-4000-8000-000000000001",
      order_id: orderId,
      tenant_id: DEMO_TENANT_ID,
      location_id: DEMO_LOCATION_DOWNTOWN_ID,
      rail: "cash",
      status: "captured",
      amount_cents: 0,
      tip_cents: 0,
      application_fee_cents: 0,
      currency: "USD",
      charge_id: null,
      connect_account_id: null,
      crypto_tx_hash: null,
      crypto_chain: null,
      cash_tendered_cents: 0,
      cash_change_cents: 0,
      refunded_cents: 0,
      simulated: true,
      raw: null,
      created_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
    };
    await driver.upsertPayment(pay);

    const payments = (await call("GET", `/orders/${orderId}/payments`)).json.data;
    expect(PaymentSchema.parse(payments[0]).method).toBe("cash");
    expect(PaymentSchema.parse((await call("GET", `/payments/${pay.id}`)).json).id).toBe(pay.id);

    const cust = CustomerSchema.parse((await call("GET", `/customers/${customer.id}`)).json);
    expect(cust.stats.order_count).toBe(1);
    expect(cust.phone).toBe("+15555550123");
    expect(pageOf(CustomerSchema).parse((await call("GET", "/customers")).json).data).toHaveLength(1);
    const found = await call("GET", "/customers/lookup?email=PAT@example.com");
    expect(CustomerSchema.parse(found.json).id).toBe(customer.id);
    expect((await call("GET", "/customers/lookup?email=ghost@example.com")).status).toBe(404);

    const staff = (await call("GET", "/staff")).json;
    const members = pageOf(StaffMemberSchema).parse(staff).data;
    expect(members.length).toBeGreaterThan(0);
    expect(members.some((m) => m.has_pin)).toBe(true);
    expect(JSON.stringify(staff)).not.toContain("scrypt");
    expect(JSON.stringify(staff)).not.toContain("pin_hash");

    const shift = await driver.openShift({
      tenantId: DEMO_TENANT_ID,
      locationId: DEMO_LOCATION_DOWNTOWN_ID,
      staffId: members[0]!.id,
      openingFloatCents: 10_000,
    });
    const sessions = pageOf(DrawerSessionSchema).parse(
      (await call("GET", `/locations/${DEMO_LOCATION_DOWNTOWN_ID}/drawer-sessions`)).json,
    );
    expect(sessions.data.find((s) => s.id === shift.id)?.expected_cents).toBe(10_000);

    expect(pageOf(DeliverySchema).parse((await call("GET", "/deliveries")).json).data).toBeDefined();
  });

  it("sales summary + daily", async () => {
    const driver = getPosDriver();
    const orderId = "d2000000-0000-4000-8000-000000000001";
    await driver.createOrder({
      id: orderId,
      tenant_id: DEMO_TENANT_ID,
      location_id: DEMO_LOCATION_DOWNTOWN_ID,
      channel: "in_store",
      currency: "USD",
      items: [
        {
          id: "line-1",
          item_id: "30000000-0000-0000-0000-0000000000ee",
          item_name: "Sales Test Special",
          size_id: null,
          size_name: "Large",
          base_price_cents: 2000,
          quantity: 2,
          modifiers: [],
          notes: null,
          voided: false,
          unit_price_cents: 2000,
          line_total_cents: 4000,
        },
      ],
      discount_cents: 400,
      totals: {
        subtotal_cents: 4000,
        discount_cents: 400,
        taxable_cents: 3600,
        tax_cents: 297,
        tip_cents: 0,
        total_cents: 3897,
      },
      notes: null,
      status: "completed",
    });
    const day = (await call("GET", `/orders/${orderId}`)).json.business_date as string;
    for (const group_by of SALES_GROUP_BY) {
      const r = await call(
        "GET",
        `/sales/summary?from=${day}&to=${day}&group_by=${group_by}`,
      );
      const s = SalesSummarySchema.parse(r.json);
      expect(s.totals.order_count, group_by).toBeGreaterThanOrEqual(1);
    }
    const byItem = SalesSummarySchema.parse(
      (await call("GET", `/sales/summary?from=${day}&to=${day}&group_by=item`)).json,
    );
    const pep = byItem.buckets.find((b) => b.label === "Sales Test Special")!;
    expect(pep.units).toBe(2);
    expect(pep.discount_cents).toBe(400);
    expect(pep.net_cents).toBe(3600);

    const daily = await call(
      "GET",
      `/locations/${DEMO_LOCATION_DOWNTOWN_ID}/sales/daily?from=${day}&to=${day}`,
    );
    const rows = daily.json.data.map((d: unknown) => DailySalesSchema.parse(d));
    expect(rows[0].business_date).toBe(day);
    expect((await call("GET", "/sales/summary?from=bad&to=x&group_by=day")).status).toBe(422);
  });
});

describe("quotes + order writes", () => {
  it("quotes server-side and matches the POS terminal pricing", async () => {
    const cart = await pepperoniCart(2);
    const r = await call("POST", "/quotes", {
      body: { location_id: DEMO_LOCATION_DOWNTOWN_ID, lines: cart.lines },
    });
    expect(r.status).toBe(200);
    const quote = QuoteSchema.parse(r.json);
    expect(quote.valid).toBe(true);
    // Large + left mushrooms (half price, rounded up), tax 8.25%
    const unit = cart.large.price_cents + Math.ceil(cart.mushrooms.price_cents / 2);
    expect(quote.lines[0]!.unit_price_cents).toBe(
      unit + quote.lines[0]!.modifiers
        .filter((m) => m.modifier_id !== cart.mushrooms.id)
        .reduce((s, m) => s + m.price_cents, 0),
    );
    expect(quote.totals.subtotal_cents).toBe(quote.lines[0]!.unit_price_cents * 2);
    expect(quote.totals.tax_cents).toBe(
      Math.floor((quote.totals.subtotal_cents * 825) / 10_000 + 0.5),
    );
  });

  it("an invalid cart returns a non-orderable quote with per-line errors", async () => {
    const r = await call("POST", "/quotes", {
      body: {
        location_id: DEMO_LOCATION_DOWNTOWN_ID,
        lines: [{ item_id: "30000000-0000-0000-0000-0000000000ff", quantity: 1 }],
      },
    });
    const quote = QuoteSchema.parse(r.json);
    expect(quote.valid).toBe(false);
    expect(quote.errors[0]!.code).toBe("ITEM_NOT_FOUND");
  });

  it("creates a HELD order (prepaid), hidden from the KDS, then releases it", async () => {
    const cart = await pepperoniCart();
    const id = "f1000000-0000-4000-8000-000000000001";
    const r = await call("POST", "/orders", {
      body: {
        id,
        location_id: DEMO_LOCATION_DOWNTOWN_ID,
        lines: cart.lines,
        channel: "agent",
        source: { type: "agent_mcp", agent_client_id: "claude" },
        contact: { name: "Sam", email: "sam@example.com" },
      },
    });
    expect(r.status).toBe(201);
    const order = OrderSchema.parse(r.json);
    expect(orderViolations(order)).toEqual([]);
    expect(order.fulfillment_status).toBe("held");
    expect(order.hold?.reason).toBe("awaiting_payment");
    expect(order.channel).toBe("agent");
    expect(order.source.agent_client_id).toBe("claude");
    expect(order.source.type).toBe("agent_mcp");
    expect(order.customer_id).toBeTruthy();
    // held (draft) orders are not on the kitchen board
    const stored = await getPosDriver().getOrder(id);
    expect(stored?.status).toBe("draft");
    // no order.placed event yet
    expect(memoryOutbox.rows.some((e) => e.event_type === "order.placed" && e.subject_id === id)).toBe(false);

    const rel = await call("POST", `/orders/${id}/release`, { body: {} });
    expect(rel.status).toBe(200);
    const released = OrderSchema.parse(rel.json);
    expect(released.fulfillment_status).toBe("placed");
    expect(released.hold).toBeNull();
    expect(
      memoryOutbox.rows.some((e) => e.event_type === "order.placed" && e.subject_id === id),
    ).toBe(true);
    // idempotent
    expect((await call("POST", `/orders/${id}/release`, { body: {} })).status).toBe(200);
  });

  it("pay_at_counter orders are placed immediately; totals equal the quote", async () => {
    const cart = await pepperoniCart();
    const quote = QuoteSchema.parse(
      (
        await call("POST", "/quotes", {
          body: { location_id: DEMO_LOCATION_DOWNTOWN_ID, lines: cart.lines, tip: { percent_bps: 1800 } },
        })
      ).json,
    );
    const r = await call("POST", "/orders", {
      body: {
        location_id: DEMO_LOCATION_DOWNTOWN_ID,
        lines: cart.lines,
        tip: { percent_bps: 1800 },
        channel: "in_store",
        source: { type: "pos_terminal" },
        payment_intent: "pay_at_counter",
        quote_hash: quote.quote_hash,
      },
      headers: { "idempotency-key": "k-1" },
    });
    expect(r.status).toBe(201);
    const order = OrderSchema.parse(r.json);
    expect(order.fulfillment_status).toBe("placed");
    expect(order.totals).toEqual(quote.totals);
    expect(order.totals.tip_cents).toBeGreaterThan(0);
    expect(order.amount_due_cents).toBe(quote.totals.total_cents);
    expect(order.payment_status).toBe("unpaid");

    // idempotent replay with the same Idempotency-Key
    const again = await call("POST", "/orders", {
      body: {
        location_id: DEMO_LOCATION_DOWNTOWN_ID,
        lines: cart.lines,
        tip: { percent_bps: 1800 },
        channel: "in_store",
        source: { type: "pos_terminal" },
        payment_intent: "pay_at_counter",
      },
      headers: { "idempotency-key": "k-1" },
    });
    expect(again.status).toBe(200);
    expect(again.headers.get("idempotent-replayed")).toBe("true");
    expect(again.json.id).toBe(order.id);
  });

  it("rejects id reuse with different lines, stale quote hashes, 86'd items, delivery", async () => {
    const cart = await pepperoniCart();
    const id = "f2000000-0000-4000-8000-000000000001";
    const base = {
      id,
      location_id: DEMO_LOCATION_DOWNTOWN_ID,
      channel: "in_store",
      source: { type: "pos_terminal" },
      payment_intent: "pay_at_counter",
    };
    expect((await call("POST", "/orders", { body: { ...base, lines: cart.lines } })).status).toBe(201);
    const conflict = await call("POST", "/orders", {
      body: { ...base, lines: [{ ...cart.lines[0], quantity: 3 }] },
    });
    expect(conflict.status).toBe(409);
    expect(conflict.json.code).toBe("IDEMPOTENCY_CONFLICT");

    const stale = await call("POST", "/orders", {
      body: { ...base, id: "f2000000-0000-4000-8000-000000000002", lines: cart.lines, quote_hash: "stale" },
    });
    expect(stale.status).toBe(409);
    expect(stale.json.code).toBe("PRICE_CHANGED");
    expect(QuoteSchema.parse(stale.json.details.quote).valid).toBe(true);

    const delivery = await call("POST", "/orders", {
      body: {
        ...base,
        id: "f2000000-0000-4000-8000-000000000003",
        lines: cart.lines,
        fulfillment: { type: "delivery" },
      },
    });
    expect(delivery.status).toBe(501);

    // 86 the item, then ordering it fails with the nested cart errors
    const eighty6 = await call("PUT", `/locations/${DEMO_LOCATION_DOWNTOWN_ID}/menu/availability`, {
      body: { target_type: "item", target_id: cart.item.id, available: false, reason: "sold_out" },
    });
    expect(eighty6.status).toBe(200);
    expect(eighty6.json.availability.available).toBe(false);
    const blocked = await call("POST", "/orders", {
      body: { ...base, id: "f2000000-0000-4000-8000-000000000004", lines: cart.lines },
    });
    expect(blocked.status).toBe(422);
    expect(blocked.json.code).toBe("QUOTE_INVALID");
    expect(blocked.json.errors[0].code).toBe("ITEM_UNAVAILABLE");
  });

  it("86 / un-86 updates the menu and emits availability events", async () => {
    const cart = await pepperoniCart();
    const path = `/locations/${DEMO_LOCATION_DOWNTOWN_ID}/menu/availability`;
    await call("PUT", path, { body: { target_type: "item", target_id: cart.item.id, available: false } });
    let menu = MenuSchema.parse(
      (await call("GET", `/locations/${DEMO_LOCATION_DOWNTOWN_ID}/menu`)).json,
    );
    expect(menu.categories.flatMap((c) => c.items).find((i) => i.id === cart.item.id)!.availability.available).toBe(false);
    await call("PUT", path, { body: { target_type: "item", target_id: cart.item.id, available: true } });
    menu = MenuSchema.parse((await call("GET", `/locations/${DEMO_LOCATION_DOWNTOWN_ID}/menu`)).json);
    expect(menu.categories.flatMap((c) => c.items).find((i) => i.id === cart.item.id)!.availability.available).toBe(true);
    expect(memoryOutbox.rows.map((r) => r.event_type)).toEqual([
      "menu.item.unavailable",
      "menu.item.available",
    ]);
    // a foreign target id is rejected
    const foreign = await call("PUT", path, {
      body: { target_type: "item", target_id: "30000000-0000-0000-0000-0000000000ff", available: false },
    });
    expect(foreign.status).toBe(422);
  });

  it("cancels pre-kitchen unpaid orders and refuses paid ones", async () => {
    const cart = await pepperoniCart();
    const mk = async (id: string) =>
      call("POST", "/orders", {
        body: {
          id,
          location_id: DEMO_LOCATION_DOWNTOWN_ID,
          lines: cart.lines,
          channel: "in_store",
          source: { type: "pos_terminal" },
          payment_intent: "pay_at_counter",
        },
      });
    const a = (await mk("f3000000-0000-4000-8000-000000000001")).json;
    const c = await call("POST", `/orders/${a.id}/cancel`, { body: { reason: "customer changed mind" } });
    expect(c.status).toBe(200);
    expect(OrderSchema.parse(c.json).fulfillment_status).toBe("canceled");
    expect(memoryOutbox.rows.map((r) => r.event_type)).toContain("order.canceled");

    const b = (await mk("f3000000-0000-4000-8000-000000000002")).json;
    await getPosDriver().upsertPayment({
      id: "e3000000-0000-4000-8000-000000000001",
      order_id: b.id,
      tenant_id: DEMO_TENANT_ID,
      location_id: DEMO_LOCATION_DOWNTOWN_ID,
      rail: "cash",
      status: "captured",
      amount_cents: b.totals.total_cents,
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
      created_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
    });
    const blocked = await call("POST", `/orders/${b.id}/cancel`, { body: { reason: "x" } });
    expect(blocked.status).toBe(409);
    expect(blocked.json.code).toBe("CANCEL_NOT_ALLOWED");
    expect((await call("POST", `/orders/${a.id}/cancel`, { body: {} })).status).toBe(422);
  });

  it("requires orders:write for writes", async () => {
    const cart = await pepperoniCart();
    const r = await call("POST", "/orders", {
      p: principal(["orders:read"]),
      body: {
        location_id: DEMO_LOCATION_DOWNTOWN_ID,
        lines: cart.lines,
        channel: "in_store",
        source: { type: "pos_terminal" },
      },
    });
    expect(r.status).toBe(403);
  });
});

describe("inventory_owner", () => {
  async function onHand(name: string): Promise<number> {
    const inv = await getPosDriver().listInventory(DEMO_TENANT_ID, DEMO_LOCATION_DOWNTOWN_ID);
    return inv.find((i) => i.name === name)?.on_hand ?? -1;
  }

  it("POS depletes by default and stops when backofhouse owns inventory", async () => {
    const driver = getPosDriver();
    const cart = await pepperoniCart();
    const body = (id: string) => ({
      id,
      location_id: DEMO_LOCATION_DOWNTOWN_ID,
      lines: cart.lines,
      channel: "in_store",
      source: { type: "pos_terminal" },
      payment_intent: "pay_at_counter",
    });

    const before = await onHand("Pizza dough ball");
    await call("POST", "/orders", { body: body("a1000000-0000-4000-8000-000000000001") });
    const afterBasic = await onHand("Pizza dough ball");
    expect(afterBasic).toBeLessThan(before);

    try {
      await driver.setTenantSettings(DEMO_TENANT_ID, { inventory_owner: "backofhouse" });
      expect((await driver.getTenantSettings(DEMO_TENANT_ID)).inventory_owner).toBe("backofhouse");
      const ent = EntitlementsSchema.parse((await call("GET", "/entitlements")).json);
      expect(ent.modules.pos?.config.inventory_owner).toBe("backofhouse");
      await call("POST", "/orders", { body: body("a1000000-0000-4000-8000-000000000002") });
      expect(await onHand("Pizza dough ball")).toBe(afterBasic);
    } finally {
      await driver.setTenantSettings(DEMO_TENANT_ID, { inventory_owner: "pos_basic" });
    }
  });

  it("held orders deplete only when released", async () => {
    const cart = await pepperoniCart();
    const before = await onHand("Pizza dough ball");
    const id = "a2000000-0000-4000-8000-000000000001";
    await call("POST", "/orders", {
      body: {
        id,
        location_id: DEMO_LOCATION_DOWNTOWN_ID,
        lines: cart.lines,
        channel: "agent",
        source: { type: "agent_api" },
      },
    });
    expect(await onHand("Pizza dough ball")).toBe(before);
    await call("POST", `/orders/${id}/release`, { body: {} });
    expect(await onHand("Pizza dough ball")).toBeLessThan(before);
  });
});
