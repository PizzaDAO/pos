/**
 * pos-v1-gaps phase 4, against the zero-env mock driver (the Postgres twins are
 * proven in supabase/tests/phase4_fidelity.sql and src/lib/db/supabase-phase4.test.ts):
 *  - orders.create fidelity: fees, tax_exempt, callout_name, metadata, fire_at, holds
 *  - deliveries.updateStatus
 *  - menu.publishAllergens
 *  - the tender/session compare-and-set, phone keys, country handling
 *  - an anonymous order cannot plant a contact on someone else's customer row
 */
import { beforeEach, describe, expect, it } from "vitest";
import { AllergenPublicationSchema, DeliverySchema, OrderSchema, type Principal } from "@openpizza/core";
import {
  getPosDriver,
  DEMO_LOCATION_DOWNTOWN_ID,
  DEMO_LOCATION_UPTOWN_ID,
  DEMO_TENANT_ID,
  type DeliveryRecord,
} from "@/lib/db";
import { resetMockOnline, resetMockOrders, resetMockPayments } from "@/lib/db/mock";
import { phoneKey } from "@/lib/db/customer-identity";
import { DEV_TOKEN } from "./auth";
import { countryOf } from "./loaders";
import { handleV1 } from "./v1";
import { hydrateEvent, memoryOutbox } from "./outbox";

const NOW = new Date("2026-06-04T22:00:00.000Z");
const OTHER_TENANT = "20000000-0000-4000-8000-0000000000bb";

function principal(scopes: string[], extra: Partial<Principal> = {}): Principal {
  return {
    kind: "service",
    id: "t",
    tenant_id: DEMO_TENANT_ID,
    location_ids: null,
    scopes,
    module: "catering",
    ...extra,
  };
}
const agent = (extra: string[] = []) =>
  principal(["orders:read", "orders:write", "quotes:write", "menu:read", "customers:write", ...extra]);

async function call(
  method: string,
  path: string,
  opts: { body?: unknown; p?: Principal; raw?: string; now?: Date } = {},
) {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined || opts.raw !== undefined) headers["content-type"] = "application/json";
  if (!opts.p) headers.authorization = `Bearer ${DEV_TOKEN}`;
  const res = await handleV1(
    new Request(`https://pos.test/api/v1${path}`, {
      method,
      headers,
      body: opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
    }),
    path.split("/").filter(Boolean),
    { now: () => opts.now ?? NOW, principal: opts.p },
  );
  const text = await res.text();
  return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) : null };
}

async function menuIds() {
  const { json: menu } = await call("GET", `/locations/${DEMO_LOCATION_DOWNTOWN_ID}/menu`);
  const item = menu.categories
    .flatMap((c: { items: unknown[] }) => c.items)
    .find((i: { name: string }) => i.name === "Pepperoni");
  const large = item.sizes.find((s: { name: string }) => s.name.startsWith("Large"));
  return { item, large };
}

async function orderBody(extra: Record<string, unknown> = {}, id?: string) {
  const { item, large } = await menuIds();
  return {
    ...(id ? { id } : {}),
    location_id: DEMO_LOCATION_DOWNTOWN_ID,
    lines: [{ item_id: item.id, size_id: large.id, quantity: 1 }],
    channel: "agent",
    source: { type: "agent_api" },
    payment_intent: "prepaid",
    ...extra,
  } as Record<string, unknown>;
}

beforeEach(() => {
  resetMockOrders();
  resetMockPayments();
  resetMockOnline();
  memoryOutbox.clear();
});

const ID = (n: number) => `f4000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

// ---------------------------------------------------------------------------
describe("orders.create fidelity", () => {
  it("prices fees (fixed and percent, taxable and not) into the order, which matches the quote", async () => {
    const fees = [
      { code: "service", label: "Service", amount_cents: 500 },
      { code: "setup", label: "Setup", percent_bps: 1000, taxable: true },
    ];
    const base = await orderBody();
    const q = await call("POST", "/quotes", { p: agent(), body: { ...base, payment_intent: undefined, fees } });
    expect(q.status).toBe(200);
    expect(q.json.valid).toBe(true);
    const o = await call("POST", "/orders", { p: agent(), body: { ...base, id: ID(1), fees } });
    expect(o.status).toBe(201);
    OrderSchema.parse(o.json);
    expect(o.json.totals.total_cents).toBe(q.json.totals.total_cents);
    expect(o.json.totals.fees_cents).toBe(q.json.totals.fees_cents);
    expect(o.json.totals.fees_cents).toBeGreaterThan(500);
    expect(o.json.fee_lines.map((f: { code: string }) => f.code)).toEqual(["service", "setup"]);
    // What the customer owes is the order total (fees included).
    expect(o.json.amount_due_cents).toBe(o.json.totals.total_cents - o.json.totals.tip_cents);
    const again = await call("GET", `/orders/${ID(1)}`, { p: agent() });
    expect(again.json.totals.total_cents).toBe(q.json.totals.total_cents);
  });

  it("takes fees from the quote on quote_id, and refuses fees sent next to a quote_id", async () => {
    const fees = [{ code: "service", label: "Service", amount_cents: 700 }];
    const { quote_id: _ignored, ...base } = (await orderBody()) as Record<string, unknown>;
    void _ignored;
    const q = await call("POST", "/quotes", { p: agent(), body: { ...base, payment_intent: undefined, fees } });
    const withQuote = { location_id: base.location_id, quote_id: q.json.id, channel: "agent", source: { type: "agent_api" } };
    const both = await call("POST", "/orders", { p: agent(), body: { ...withQuote, fees } });
    expect(both.status).toBe(422);
    expect(both.json.path).toBe("fees");
    const o = await call("POST", "/orders", { p: agent(), body: { ...withQuote, id: ID(2) } });
    expect(o.status).toBe(201);
    expect(o.json.totals.fees_cents).toBe(700);
    expect(o.json.totals.total_cents).toBe(q.json.totals.total_cents);
  });

  it("tax_exempt needs the literal orders:discount scope and zeroes tax", async () => {
    const plain = await call("POST", "/orders", { p: agent(), body: await orderBody({ id: ID(3) }) });
    expect(plain.json.totals.tax_cents).toBeGreaterThan(0);
    const denied = await call("POST", "/orders", {
      p: agent(),
      body: await orderBody({ id: ID(4), tax_exempt: true }),
    });
    expect(denied.status).toBe(403);
    const ok = await call("POST", "/orders", {
      p: agent(["orders:discount"]),
      body: await orderBody({ id: ID(5), tax_exempt: true }),
    });
    expect(ok.status).toBe(201);
    expect(ok.json.tax_exempt).toBe(true);
    expect(ok.json.totals.tax_cents).toBe(0);
    expect(ok.json.totals.total_cents).toBe(plain.json.totals.total_cents - plain.json.totals.tax_cents);
  });

  it("stores and echoes callout_name (default from the contact), metadata and fire_at", async () => {
    const o = await call("POST", "/orders", {
      p: agent(),
      body: await orderBody({
        id: ID(6),
        callout_name: "Sam B",
        metadata: { catering_event_id: "ev1" },
        fire_at: "2026-06-05T12:00:00.000Z",
      }),
    });
    expect(o.status).toBe(201);
    expect(o.json.callout_name).toBe("Sam B");
    expect(o.json.metadata).toEqual({ catering_event_id: "ev1" });
    expect(o.json.fire_at).toBe("2026-06-05T12:00:00.000Z");
    const d = await call("POST", "/orders", {
      p: agent(),
      body: await orderBody({ id: ID(7), contact: { name: "Jordan Lee", email: "jl@example.com" } }),
    });
    expect(d.json.callout_name).toBe("Jordan");
  });

  it("honours a scheduled hold of up to 30 days for a non-terminal caller; no silent shortening", async () => {
    const o = await call("POST", "/orders", {
      p: agent(),
      body: await orderBody({
        id: ID(8),
        hold: { reason: "scheduled", ttl_seconds: 30 * 86400 },
        payment_intent: "invoice",
      }),
    });
    expect(o.status).toBe(201);
    expect(o.json.hold.reason).toBe("scheduled");
    expect(Date.parse(o.json.hold.expires_at) - NOW.getTime()).toBe(30 * 86400 * 1000);
    // awaiting_payment above 24 h is refused (schema), never clamped.
    const over = await call("POST", "/orders", {
      p: agent(),
      body: await orderBody({ id: ID(9), hold: { reason: "awaiting_payment", ttl_seconds: 2 * 86400 } }),
    });
    expect(over.status).toBe(422);
    // A manual hold is a terminal's.
    const manual = await call("POST", "/orders", {
      p: agent(),
      body: await orderBody({ id: ID(10), hold: { reason: "manual" } }),
    });
    expect(manual.status).toBe(422);
    expect(manual.json.path).toBe("hold.reason");
  });
});

// ---------------------------------------------------------------------------
describe("deliveries.updateStatus", () => {
  const dev = () => principal(["deliveries:read", "deliveries:write", "orders:read"], { module: "driver" });

  async function seedDelivery(n: number, orderStatus: "paid" | "ready" = "ready", tenant = DEMO_TENANT_ID) {
    const driver = getPosDriver();
    const base = await orderBody({ id: ID(100 + n) });
    const o = await call("POST", "/orders", { p: agent(), body: base });
    expect(o.status).toBe(201);
    await driver.updateOrderStatus(o.json.id, orderStatus);
    const rec: DeliveryRecord = {
      id: ID(200 + n),
      order_id: o.json.id,
      tenant_id: tenant,
      location_id: DEMO_LOCATION_DOWNTOWN_ID,
      provider: "openpizza_driver",
      status: "dispatched",
      zone_id: null,
      fee_cents: 300,
      currency: "USD",
      eta_minutes: 40,
      provider_delivery_id: null,
      tracking_ref: null,
      dropoff: { line1: "1 Main", city: "Town", region: "NY", postal_code: "10001", country: "US" },
      driver_name: null,
      driver_phone: null,
      simulated: false,
      created_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
    };
    await driver.upsertDelivery(rec);
    return rec;
  }
  const post = (id: string, body: unknown, p = dev()) => call("POST", `/deliveries/${id}/status`, { p, body });

  it("moves status, stores driver/eta/tracking, and drives the order", async () => {
    const rec = await seedDelivery(1);
    const r = await post(rec.id, {
      status: "picked_up",
      driver: { name: "Dee", phone: "+14155550100" },
      eta_minutes: 12,
      tracking_url: "https://track.example/abc",
      provider_delivery_id: "drv_1",
    });
    expect(r.status).toBe(200);
    const d = DeliverySchema.parse(r.json);
    expect(d.status).toBe("picked_up");
    expect(d.driver?.name).toBe("Dee");
    expect(d.eta_minutes).toBe(12);
    expect(d.tracking_url).toBe("https://track.example/abc");
    expect(d.provider_delivery_id).toBe("drv_1");
    expect((await getPosDriver().getOrder(rec.order_id))!.status).toBe("out_for_delivery");
    const done = await post(rec.id, { status: "delivered" });
    expect(done.status).toBe(200);
    expect((await getPosDriver().getOrder(rec.order_id))!.status).toBe("completed");
  });

  it("the driver module may only report on its own deliveries, under the stored id", async () => {
    const driver = getPosDriver();
    const rec = await seedDelivery(31);
    await driver.upsertDelivery({ ...rec, provider_delivery_id: "drv_a" });
    // Same id: fine. A different id: refused, and the row is untouched.
    expect((await post(rec.id, { status: "assigned", provider_delivery_id: "drv_a" })).status).toBe(200);
    const bad = await post(rec.id, { status: "picked_up", provider_delivery_id: "drv_b" });
    expect(bad.status).toBe(409);
    expect(bad.json.code).toBe("INVALID_TRANSITION");
    expect((await driver.getDelivery(rec.id))!.status).toBe("assigned");
    // A delivery switched to manual no longer accepts the driver module's pushes ...
    const manual = await seedDelivery(32);
    await driver.upsertDelivery({ ...manual, provider: "in_house_manual" });
    const refused = await post(manual.id, { status: "picked_up" });
    expect(refused.status).toBe(409);
    expect((await driver.getDelivery(manual.id))!.status).toBe("dispatched");
    // ... but other callers are unchanged.
    const other = principal(["deliveries:write", "orders:read"], { module: "catering" });
    expect((await post(manual.id, { status: "assigned" }, other)).status).toBe(200);
  });

  it("is a no-op when replayed, and a finished delivery cannot change", async () => {
    const rec = await seedDelivery(2);
    await post(rec.id, { status: "delivered" });
    const events = memoryOutbox.rows.filter((r) => r.event_type === "delivery.status_changed").length;
    const replay = await post(rec.id, { status: "delivered" });
    expect(replay.status).toBe(200);
    expect(memoryOutbox.rows.filter((r) => r.event_type === "delivery.status_changed")).toHaveLength(events);
    const late = await post(rec.id, { status: "assigned" });
    expect(late.status).toBe(409);
    expect(late.json.code ?? late.json.type).toMatch(/INVALID_TRANSITION|invalid-transition|invalid_transition/i);
    expect((await getPosDriver().getDelivery(rec.id))!.status).toBe("delivered");
  });

  it("canceled leaves the order alone", async () => {
    const rec = await seedDelivery(3);
    const r = await post(rec.id, { status: "canceled" });
    expect(r.status).toBe(200);
    expect((await getPosDriver().getOrder(rec.order_id))!.status).toBe("ready");
  });

  it("is tenant-isolated and needs the scope", async () => {
    const rec = await seedDelivery(4);
    const foreign = await post(rec.id, { status: "delivered" }, principal(["deliveries:write"], { tenant_id: OTHER_TENANT }));
    expect([403, 404]).toContain(foreign.status);
    const noScope = await post(rec.id, { status: "delivered" }, principal(["deliveries:read"]));
    expect(noScope.status).toBe(403);
    const limited = await post(rec.id, { status: "delivered" }, { ...dev(), location_ids: [DEMO_LOCATION_UPTOWN_ID] });
    expect(limited.status).toBe(404);
    const bad = await post(rec.id, { status: "teleported" });
    expect(bad.status).toBe(422);
    expect((await getPosDriver().getDelivery(rec.id))!.status).toBe("dispatched");
  });

  it("racing delivered against canceled: exactly one wins and the loser sees the stored state", async () => {
    const rec = await seedDelivery(5);
    const [a, b] = await Promise.all([post(rec.id, { status: "delivered" }), post(rec.id, { status: "canceled" })]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const final = (await getPosDriver().getDelivery(rec.id))!.status;
    expect(["delivered", "canceled"]).toContain(final);
    expect(final).toBe(a.status === 200 ? "delivered" : "canceled");
  });

  it("the driver-level CAS never rewrites a terminal delivery", async () => {
    const rec = await seedDelivery(6);
    const driver = getPosDriver();
    const first = await driver.transitionDelivery(rec.id, DEMO_TENANT_ID, { status: "failed" });
    expect(first.ok).toBe(true);
    const second = await driver.transitionDelivery(rec.id, DEMO_TENANT_ID, { status: "delivered", driver_name: "X" });
    expect(second).toMatchObject({ ok: false, reason: "terminal" });
    expect((await driver.getDelivery(rec.id))).toMatchObject({ status: "failed", driver_name: null });
    expect(await driver.transitionDelivery(rec.id, OTHER_TENANT, { status: "failed" })).toMatchObject({
      ok: false,
      reason: "not_found",
    });
  });
});

// ---------------------------------------------------------------------------
describe("menu.publishAllergens", () => {
  const boh = (extra: string[] = []) => principal(["menu.allergens:write", ...extra], { module: "backofhouse" });
  const put = (body: unknown, p = boh()) => call("PUT", "/catalog/allergens", { p, body });

  it("stores, announces once, replays, and conflicts on a changed payload", async () => {
    const { item, large } = await menuIds();
    const body = {
      version: "2026-11-01-a",
      payload_hash: "hash-aaaaaaaa",
      rows: [
        { target_type: "item", target_id: item.id, contains: ["milk", "wheat"], tags: [] },
        { target_type: "size", target_id: large.id },
      ],
    };
    const r = await put(body);
    expect(r.status).toBe(200);
    const pub = AllergenPublicationSchema.parse(r.json);
    expect(pub.row_count).toBe(2);
    const rows = () => memoryOutbox.rows.filter((x) => x.event_type === "menu.allergens.published");
    expect(rows()).toHaveLength(1);
    const ev = await hydrateEvent(rows()[0]!, getPosDriver());
    expect(ev?.type).toBe("menu.allergens.published");
    expect(ev?.data).toMatchObject({ version: "2026-11-01-a", payload_hash: "hash-aaaaaaaa" });

    const replay = await put(body);
    expect(replay.status).toBe(200);
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    expect(rows()).toHaveLength(1);

    const conflict = await put({ ...body, payload_hash: "hash-bbbbbbbb" });
    expect(conflict.status).toBe(409);
  });

  it("refuses another tenant's items or locations, and writes nothing", async () => {
    const { item } = await menuIds();
    const foreignItem = await put(
      { version: "v1", payload_hash: "hash-aaaaaaaa", rows: [{ target_type: "item", target_id: ID(999) }, { target_type: "item", target_id: item.id }] },
    );
    expect(foreignItem.status).toBe(422); // ITEM_NOT_FOUND
    const foreignLoc = await put({ version: "v1", payload_hash: "hash-aaaaaaaa", location_ids: [ID(998)], rows: [] });
    expect(foreignLoc.status).toBe(404);
    expect(memoryOutbox.rows.filter((x) => x.event_type === "menu.allergens.published")).toHaveLength(0);
    // The same version can still be published afterwards (nothing was stored).
    const ok = await put({ version: "v1", payload_hash: "hash-aaaaaaaa", rows: [{ target_type: "item", target_id: item.id }] });
    expect(ok.status).toBe(200);
  });

  it("a location-limited token cannot publish; a duplicate target is 422; scope required", async () => {
    const { item } = await menuIds();
    // The matrix is tenant-wide: a location-limited token may not publish at all.
    const limited = { ...boh(), location_ids: [DEMO_LOCATION_DOWNTOWN_ID] };
    expect((await put({ version: "v2", payload_hash: "hash-aaaaaaaa", rows: [] }, limited)).status).toBe(403);
    expect(
      (await put({ version: "v2", payload_hash: "hash-aaaaaaaa", location_ids: [DEMO_LOCATION_DOWNTOWN_ID], rows: [] }, limited)).status,
    ).toBe(403);
    const dup = await put({
      version: "v3",
      payload_hash: "hash-aaaaaaaa",
      rows: [{ target_type: "item", target_id: item.id }, { target_type: "item", target_id: item.id }],
    });
    expect(dup.status).toBe(422);
    expect((await put({ version: "v4", payload_hash: "hash-aaaaaaaa", rows: [] }, principal(["menu:read"]))).status).toBe(403);
  });

  it("accepts a body past the 256 KB default (this route only)", async () => {
    const { item } = await menuIds();
    const tags = Array.from({ length: 20_000 }, (_, i) => `tag_number_${i}`);
    const big = { version: "big", payload_hash: "hash-aaaaaaaa", rows: [{ target_type: "item", target_id: item.id, tags }] };
    expect(JSON.stringify(big).length).toBeGreaterThan(256_000);
    expect((await put(big)).status).toBe(200);
    // ...but not unbounded.
    const huge = JSON.stringify({ ...big, version: "huge", padding: "x".repeat(4_100_000) });
    expect((await put(undefined, boh().kind ? boh() : boh()).then(() => call("PUT", "/catalog/allergens", { p: boh(), raw: huge }))).status).toBe(413);
  });
});

// ---------------------------------------------------------------------------
describe("tender / session link (compare-and-set)", () => {
  async function tender(status: "requires_action" | "canceled" | "captured") {
    const o = await call("POST", "/orders", { p: agent(), body: await orderBody({ id: ID(300 + Math.floor(Math.random() * 1e6)) }) });
    const id = ID(400 + Math.floor(Math.random() * 1e6));
    await getPosDriver().upsertPayment({
      id,
      order_id: o.json.id,
      tenant_id: DEMO_TENANT_ID,
      location_id: DEMO_LOCATION_DOWNTOWN_ID,
      rail: "stripe_online",
      status,
      amount_cents: 1000,
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
      simulated: false,
      raw: { keep: "me" },
      created_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
    } as never);
    return id;
  }

  it("links only an open tender of this tenant and merges into raw", async () => {
    const driver = getPosDriver();
    const id = await tender("requires_action");
    expect(await driver.linkTenderSession(OTHER_TENANT, id, "cs_test_1")).toMatchObject({ ok: false, reason: "not_found" });
    const ok = await driver.linkTenderSession(DEMO_TENANT_ID, id, "cs_test_1");
    expect(ok.ok).toBe(true);
    expect((await driver.getPayment(id))!.raw).toEqual({ keep: "me", checkout_session_id: "cs_test_1" });
  });

  it("a tender closed meanwhile is left exactly as it is", async () => {
    const driver = getPosDriver();
    for (const status of ["canceled", "captured"] as const) {
      const id = await tender(status);
      const r = await driver.linkTenderSession(DEMO_TENANT_ID, id, "cs_test_late");
      expect(r).toMatchObject({ ok: false, reason: "not_open", status });
      const p = (await driver.getPayment(id))!;
      expect(p.status).toBe(status);
      expect(p.raw).toEqual({ keep: "me" });
    }
  });

  it("two racing links: the tender ends with one coherent session id", async () => {
    const driver = getPosDriver();
    const id = await tender("requires_action");
    await Promise.all([
      driver.linkTenderSession(DEMO_TENANT_ID, id, "cs_a"),
      driver.linkTenderSession(DEMO_TENANT_ID, id, "cs_b"),
    ]);
    expect(["cs_a", "cs_b"]).toContain((await driver.getPayment(id))!.raw!.checkout_session_id);
  });
});

// ---------------------------------------------------------------------------
describe("phone keys and country", () => {
  it("never guesses a country", () => {
    expect(phoneKey("(415) 555-0199")).toBe("4155550199");
    expect(phoneKey("+1 415 555 0199", null)).toBe("4155550199");
    expect(phoneKey("1 415 555 0199", "CA")).toBe("4155550199");
    expect(phoneKey("5512345678", "MX")).toBeNull();
    expect(phoneKey("5512345678", null)).toBeNull();
    expect(phoneKey("+52 55 1234 5678", null)).toBe("525512345678");
    expect(phoneKey("0052 55 1234 5678")).toBe("525512345678");
    expect(phoneKey("12345")).toBeNull();
  });
  it("countryOf: NULL reads as US at the boundary; a stored non-US country is never guessed over", () => {
    expect(countryOf(null)).toBe("US");
    expect(countryOf(undefined)).toBe("US");
    expect(countryOf("usa")).toBeNull();
    expect(countryOf("GB")).toBe("GB");
  });
  it("identical national digits in an unknown country are never merged", async () => {
    const driver = getPosDriver();
    const mk = (email: string) =>
      driver.upsertCustomerIdentity(DEMO_TENANT_ID, {
        newId: crypto.randomUUID(),
        email,
        phone: "5512345678",
        name: null,
        marketing: {},
        tags: [],
        externalIds: {},
        country: null,
      });
    const a = await mk("kk-a@example.com");
    const b = await mk("kk-b@example.com");
    expect(b.created).toBe(true);
    expect(b.customer.id).not.toBe(a.customer.id);
    expect(b.customer.phone).toBe("5512345678");
  });
});

// ---------------------------------------------------------------------------
describe("openpizza_driver delivery provider", () => {
  it("is registered, inert by default (gated), and needs a record id + payload to dispatch", async () => {
    const { getDeliveryProvider, isDeliveryProviderAvailable } = await import("@/lib/delivery/registry");
    await import("@/lib/delivery/providers");
    expect(isDeliveryProviderAvailable("openpizza_driver")).toBe(true);
    const p = getDeliveryProvider("openpizza_driver")!;
    // No OPENPIZZA_DRIVER_TENANTS / hub env: never available, never calls out.
    expect(await p.available!(DEMO_TENANT_ID, DEMO_LOCATION_DOWNTOWN_ID)).toBe(false);
    const a = { line1: "a", city: "b", region: "c", postalCode: "1", country: "US" };
    await expect(
      p.dispatch({
        context: { tenantId: DEMO_TENANT_ID, locationId: DEMO_LOCATION_DOWNTOWN_ID, idempotencyKey: "k" },
        orderId: "o1",
        pickup: a,
        dropoff: a,
      }),
    ).rejects.toMatchObject({ retryable: false });
    const { mapToRecordStatus } = await import("@/lib/delivery/service");
    expect(mapToRecordStatus("openpizza_driver", "dispatched")).toBe("dispatched");
  });
});

// ---------------------------------------------------------------------------
describe("an anonymous order cannot plant a contact on someone else's customer", () => {
  it("/v1 order contact: victim email + attacker phone leaves the row and emits no customer.updated", async () => {
    const driver = getPosDriver();
    const email = `victim-${Date.now()}@example.com`;
    const victim = await driver.upsertCustomer({
      id: crypto.randomUUID(),
      tenant_id: DEMO_TENANT_ID,
      email,
      name: "Victim",
      phone: null,
      verified: false,
      created_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
    });
    memoryOutbox.clear();
    const o = await call("POST", "/orders", {
      p: agent(),
      body: await orderBody({
        id: ID(500),
        contact: { name: "Attacker", email, phone: "+14155550666" },
      }),
    });
    expect(o.status).toBe(201);
    // The order itself keeps its own contact for receipts and delivery...
    expect(o.json.contact.phone).toBe("+14155550666");
    expect(o.json.customer_id).toBe(victim.id);
    // ...but the victim's row is untouched and nothing was announced about it.
    const stored = (await driver.getCustomer(victim.id))!;
    expect(stored).toMatchObject({ name: "Victim", phone: null });
    expect(stored.updated_at).toBe(victim.updated_at);
    const customerEvents = memoryOutbox.rows.filter((r) => r.event_type.startsWith("customer."));
    expect(JSON.stringify(customerEvents)).not.toContain("4155550666");
    expect(customerEvents.filter((r) => r.event_type === "customer.updated")).toHaveLength(0);
  });
});
