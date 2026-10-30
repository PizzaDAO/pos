/**
 * Event outbox: the mock driver writes contract events in-memory (the trigger
 * equivalent), the worker hydrates + validates them against the catalog, signs
 * with Standard Webhooks and retries/dead-letters failures.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  EVENT_CATALOG,
  RETRY_SCHEDULE_SECONDS,
  parseEvent,
  verifyAndParseEvent,
  verifyWebhook,
  type AnyEvent,
} from "@openpizza/core";
import {
  getPosDriver,
  DEMO_LOCATION_DOWNTOWN_ID,
  DEMO_TENANT_ID,
  type CreateOrderInput,
  type Payment,
} from "@/lib/db";
import { resetMockOnline, resetMockOrders, resetMockPayments } from "@/lib/db/mock";
import {
  deliverOutbox,
  eventIdFor,
  hydrateEvent,
  memoryOutbox,
  readHubEnv,
} from "./outbox";

const SECRET = "whsec_" + Buffer.from("0123456789abcdef0123456789abcdef").toString("base64");
const INGEST = "https://hub.test/ingest/pos";

beforeEach(async () => {
  resetMockOrders();
  resetMockPayments();
  resetMockOnline();
  memoryOutbox.clear();
});

function orderInput(id: string, status: CreateOrderInput["status"] = "placed"): CreateOrderInput {
  return {
    id,
    tenant_id: DEMO_TENANT_ID,
    location_id: DEMO_LOCATION_DOWNTOWN_ID,
    channel: "in_store",
    currency: "USD",
    items: [
      {
        id: "line-1",
        item_id: "30000000-0000-0000-0000-000000000002",
        item_name: "Pepperoni",
        size_id: null,
        size_name: "Large",
        base_price_cents: 2000,
        quantity: 1,
        modifiers: [],
        notes: null,
        voided: false,
        unit_price_cents: 2000,
        line_total_cents: 2000,
      },
    ],
    discount_cents: 0,
    totals: {
      subtotal_cents: 2000,
      discount_cents: 0,
      taxable_cents: 2000,
      tax_cents: 165,
      tip_cents: 0,
      total_cents: 2165,
    },
    notes: null,
    status,
  };
}

function payment(orderId: string, id: string, status: Payment["status"]): Payment {
  return {
    id,
    order_id: orderId,
    tenant_id: DEMO_TENANT_ID,
    location_id: DEMO_LOCATION_DOWNTOWN_ID,
    rail: "stripe_online",
    status,
    amount_cents: 2165,
    tip_cents: 0,
    application_fee_cents: 64,
    currency: "USD",
    charge_id: "pi_123",
    connect_account_id: "acct_1",
    crypto_tx_hash: null,
    crypto_chain: null,
    cash_tendered_cents: null,
    cash_change_cents: null,
    refunded_cents: 0,
    simulated: true,
    raw: { secret: "do-not-leak" },
    created_at: "2026-06-04T22:00:00.000Z",
    updated_at: "2026-06-04T22:00:00.000Z",
  };
}

const types = () => memoryOutbox.rows.map((r) => r.event_type);

describe("mock driver writes outbox rows", () => {
  it("order lifecycle emits the contract event set, per-tenant sequenced", async () => {
    const d = getPosDriver();
    const id = "11111111-0000-4000-8000-000000000001";
    await d.createOrder(orderInput(id));
    await d.createOrder(orderInput(id)); // idempotent replay: no second event
    await d.updateOrderStatus(id, "in_kitchen");
    await d.updateOrderStatus(id, "ready");
    await d.updateOrderStatus(id, "completed");
    expect(types()).toEqual([
      "order.placed",
      "order.status_changed",
      "order.status_changed",
      "order.ready",
      "order.status_changed",
      "order.completed",
    ]);
    expect(memoryOutbox.rows.map((r) => r.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(memoryOutbox.rows[1]!.changes).toEqual({ status: ["placed", "in_kitchen"] });
    // versions are monotonic
    const versions = memoryOutbox.rows.map((r) => r.subject_version!);
    expect(versions).toEqual([...versions].sort((a, b) => a - b));
  });

  it("held orders are silent until released; void emits order.canceled", async () => {
    const d = getPosDriver();
    const id = "11111111-0000-4000-8000-000000000002";
    await d.createOrder({ ...orderInput(id, "draft"), hold: { reason: "awaiting_payment", expires_at: null } });
    expect(types()).toEqual([]);
    await d.updateOrderStatus(id, "placed");
    // leaving a hold announces the order once, as placed
    expect(types()).toEqual(["order.placed"]);
    await d.updateOrderStatus(id, "voided");
    expect(types().slice(1)).toEqual(["order.status_changed", "order.canceled"]);
  });

  it("a canceled, never-announced hold emits nothing", async () => {
    const d = getPosDriver();
    const id = "11111111-0000-4000-8000-0000000000f2";
    await d.createOrder({ ...orderInput(id, "draft"), hold: { reason: "awaiting_payment", expires_at: null } });
    await d.updateOrderStatus(id, "voided");
    expect(types()).toEqual([]);
  });

  it("payments, customers, staff, drawer, business day, menu emit once per change", async () => {
    const d = getPosDriver();
    const orderId = "11111111-0000-4000-8000-000000000003";
    await d.createOrder(orderInput(orderId));
    memoryOutbox.clear();

    await d.upsertPayment(payment(orderId, "22222222-0000-4000-8000-000000000001", "pending"));
    expect(types()).toEqual([]);
    await d.upsertPayment(payment(orderId, "22222222-0000-4000-8000-000000000001", "captured"));
    expect(types()).toEqual(["payment.captured"]);

    const now = new Date().toISOString();
    await d.upsertCustomer({
      id: "33333333-0000-4000-8000-000000000001",
      tenant_id: DEMO_TENANT_ID,
      email: "evt@example.com",
      name: "Evt",
      phone: null,
      verified: false,
      created_at: now,
      updated_at: now,
    });
    await d.upsertCustomer({
      id: "33333333-0000-4000-8000-000000000001",
      tenant_id: DEMO_TENANT_ID,
      email: "evt@example.com",
      name: "Evt Two",
      phone: null,
      verified: false,
      created_at: now,
      updated_at: now,
    });
    const staff = await d.upsertStaff({
      id: "44444444-0000-4000-8000-000000000001",
      tenant_id: DEMO_TENANT_ID,
      name: "New Cook",
      role: "kitchen",
      active: true,
      created_at: now,
    });
    await d.upsertStaff({ ...staff, active: false });
    const shift = await d.openShift({
      tenantId: DEMO_TENANT_ID,
      locationId: DEMO_LOCATION_DOWNTOWN_ID,
      staffId: staff.id,
      openingFloatCents: 5000,
    });
    await d.closeShift({ shiftId: shift.id, countedCents: 5000 });
    await d.closeBusinessDay(DEMO_TENANT_ID, DEMO_LOCATION_DOWNTOWN_ID, "2026-06-04");
    await d.closeBusinessDay(DEMO_TENANT_ID, DEMO_LOCATION_DOWNTOWN_ID, "2026-06-04"); // idempotent
    await d.upsertItem({
      tenant_id: DEMO_TENANT_ID,
      category_id: "20000000-0000-0000-0000-000000000001",
      name: "Calzone",
    });
    await d.upsertCategory({ tenant_id: DEMO_TENANT_ID, name: "Specials" }); // debounced

    expect(types()).toEqual([
      "payment.captured",
      "customer.created",
      "customer.updated",
      "staff.created",
      "staff.deactivated",
      "drawer_session.opened",
      "drawer_session.closed",
      "business_day.closed",
      "menu.updated",
    ]);
  });
});

describe("hydration validates every event against the catalog", () => {
  it("builds a schema-valid event for every emitted type", async () => {
    const d = getPosDriver();
    const orderId = "55555555-0000-4000-8000-000000000001";
    const payId = "55555555-0000-4000-8000-0000000000a1";
    await d.createOrder(orderInput(orderId));
    await d.upsertPayment(payment(orderId, payId, "captured"));
    await d.updateOrderStatus(orderId, "paid");
    await d.updateOrderStatus(orderId, "in_kitchen");
    await d.updateOrderStatus(orderId, "ready");
    await d.updateOrderStatus(orderId, "completed");
    const now = new Date().toISOString();
    await d.upsertCustomer({
      id: "55555555-0000-4000-8000-0000000000c1",
      tenant_id: DEMO_TENANT_ID,
      email: "h@example.com",
      name: "Hy Drate",
      phone: "+15555550100",
      verified: true,
      created_at: now,
      updated_at: now,
    });
    const staff = await d.upsertStaff({
      id: "55555555-0000-4000-8000-0000000000d1",
      tenant_id: DEMO_TENANT_ID,
      name: "Sam",
      role: "cashier",
      active: true,
      created_at: now,
    });
    const shift = await d.openShift({
      tenantId: DEMO_TENANT_ID,
      locationId: DEMO_LOCATION_DOWNTOWN_ID,
      staffId: staff.id,
      openingFloatCents: 100,
    });
    await d.closeShift({ shiftId: shift.id, countedCents: 100 });
    await d.closeBusinessDay(DEMO_TENANT_ID, DEMO_LOCATION_DOWNTOWN_ID, "2026-06-05");
    await d.upsertOverride({
      tenant_id: DEMO_TENANT_ID,
      location_id: DEMO_LOCATION_DOWNTOWN_ID,
      target_type: "item",
      target_id: "30000000-0000-0000-0000-000000000002",
      available: false,
    });
    await d.clearOverride(
      DEMO_TENANT_ID,
      DEMO_LOCATION_DOWNTOWN_ID,
      "item",
      "30000000-0000-0000-0000-000000000002",
    );

    const seen = new Set<string>();
    for (const row of memoryOutbox.rows) {
      const ev = await hydrateEvent(row, d);
      expect(ev, row.event_type).not.toBeNull();
      // round-trips through the strict envelope + catalog parser
      const parsed = parseEvent(JSON.parse(JSON.stringify(ev)));
      expect(parsed.type).toBe(row.event_type);
      expect(parsed.sequence).toBe(row.sequence);
      expect(parsed.id).toBe(eventIdFor(row));
      seen.add(row.event_type);
    }
    for (const t of [
      "order.placed",
      "order.status_changed",
      "order.ready",
      "order.completed",
      "payment.captured",
      "customer.created",
      "staff.created",
      "drawer_session.opened",
      "drawer_session.closed",
      "business_day.closed",
      "menu.item.unavailable",
      "menu.item.available",
    ]) {
      expect(seen.has(t), t).toBe(true);
      expect(t in EVENT_CATALOG).toBe(true);
    }

    // POS `changes` are translated to the contract's two status axes.
    const readyRow = memoryOutbox.rows.find((r) => r.event_type === "order.ready")!;
    const ready = (await hydrateEvent(readyRow, d))!;
    expect(ready.changes).toEqual({ fulfillment_status: ["preparing", "ready"] });
    const paid = memoryOutbox.rows.filter((r) => r.event_type === "order.status_changed")[0]!;
    expect((await hydrateEvent(paid, d))!.changes).toEqual({ payment_status: ["unpaid", "paid"] });

    // secrets never reach a payload
    const body = JSON.stringify(await hydrateEvent(memoryOutbox.rows.find((r) => r.event_type === "payment.captured")!, d));
    expect(body).not.toContain("do-not-leak");
    expect(body).not.toContain("pin_hash");
  });

  it("event ids are deterministic per row and ULID-shaped", () => {
    const row = { id: "00000000-0000-4000-8000-0000000000ab", occurred_at: "2026-06-04T22:00:00.000Z" };
    expect(eventIdFor(row)).toBe(eventIdFor({ ...row }));
    expect(eventIdFor(row)).toMatch(/^evt_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(eventIdFor({ ...row, id: "00000000-0000-4000-8000-0000000000ac" })).not.toBe(eventIdFor(row));
  });
});

describe("deliverOutbox", () => {
  async function seedOne() {
    const d = getPosDriver();
    await d.createOrder(orderInput("66666666-0000-4000-8000-000000000001"));
    return memoryOutbox.rows[0]!;
  }

  it("signs with Standard Webhooks and POSTs to the hub ingest URL", async () => {
    await seedOne();
    const sent: { url: string; headers: Headers; body: string }[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      sent.push({ url, headers: new Headers(init.headers), body: String(init.body) });
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;

    const res = await deliverOutbox({
      ingestUrl: INGEST,
      secret: SECRET,
      store: memoryOutbox,
      unsafeAllowMockStore: true,
      fetch: fakeFetch,
    });
    expect(res).toEqual({ claimed: 1, delivered: 1, retried: 0, dead: 0 });
    expect(memoryOutbox.rows[0]!.status).toBe("delivered");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe(INGEST);

    // the receiver (hub) can verify and parse it
    const event = (await verifyAndParseEvent({
      payload: sent[0]!.body,
      headers: sent[0]!.headers,
      secret: SECRET,
    })) as AnyEvent;
    expect(event.type).toBe("order.placed");
    expect(event.source).toBe("openpizza_pos");
    expect(event.tenant_id).toBe(DEMO_TENANT_ID);
    expect(sent[0]!.headers.get("webhook-id")).toBe(event.id);

    // a wrong secret fails verification; so does a tampered body
    await expect(
      verifyWebhook({
        payload: sent[0]!.body,
        headers: sent[0]!.headers,
        secret: "whsec_" + Buffer.from("another-secret-another-secret!!").toString("base64"),
      }),
    ).rejects.toThrow();
    await expect(
      verifyWebhook({ payload: sent[0]!.body + " ", headers: sent[0]!.headers, secret: SECRET }),
    ).rejects.toThrow();

    // nothing left to deliver
    expect((await deliverOutbox({ ingestUrl: INGEST, secret: SECRET, store: memoryOutbox, unsafeAllowMockStore: true, fetch: fakeFetch })).claimed).toBe(0);
  });

  it("supports secret rotation (several secrets sign)", async () => {
    await seedOne();
    const newSecret = "whsec_" + Buffer.from("rotated-secret-rotated-secret!!").toString("base64");
    let got: { headers: Headers; body: string } | null = null;
    await deliverOutbox({
      ingestUrl: INGEST,
      secret: [newSecret, SECRET],
      store: memoryOutbox,
      unsafeAllowMockStore: true,
      fetch: (async (_u: string, init: RequestInit) => {
        got = { headers: new Headers(init.headers), body: String(init.body) };
        return new Response(null, { status: 200 });
      }) as unknown as typeof fetch,
    });
    for (const s of [SECRET, newSecret]) {
      await verifyWebhook({ payload: got!.body, headers: got!.headers, secret: s });
    }
  });

  it("retries failures on the contract schedule with the SAME event id, then dead-letters", async () => {
    const row = await seedOne();
    let clock = new Date(Date.now() + 1000);
    const ids: string[] = [];
    const failing = (async (_u: string, init: RequestInit) => {
      ids.push(new Headers(init.headers).get("webhook-id")!);
      return new Response("nope", { status: 500 });
    }) as unknown as typeof fetch;
    const run = () =>
      deliverOutbox({
        ingestUrl: INGEST,
        secret: SECRET,
        store: memoryOutbox,
        unsafeAllowMockStore: true,
        fetch: failing,
        now: () => clock,
        random: () => 0.5, // no jitter: delay == schedule
      });

    // not yet due right after a failure
    expect((await run()).retried).toBe(1);
    expect(row.attempts).toBe(1);
    expect(new Date(row.next_attempt_at).getTime() - clock.getTime()).toBe(RETRY_SCHEDULE_SECONDS[0]! * 1000);
    expect((await run()).claimed).toBe(0);

    for (let attempt = 2; attempt <= RETRY_SCHEDULE_SECONDS.length; attempt++) {
      clock = new Date(new Date(row.next_attempt_at).getTime() + 1000);
      const r = await run();
      expect(r.retried, `attempt ${attempt}`).toBe(1);
      expect(row.attempts).toBe(attempt);
      expect(new Date(row.next_attempt_at).getTime() - clock.getTime()).toBe(
        RETRY_SCHEDULE_SECONDS[attempt - 1]! * 1000,
      );
    }
    clock = new Date(new Date(row.next_attempt_at).getTime() + 1000);
    expect((await run()).dead).toBe(1);
    expect(row.status).toBe("dead");
    expect(row.last_error).toBe("HTTP 500");
    expect(new Set(ids).size).toBe(1); // consumers dedupe on this id
  });

  it("network errors retry; a later success delivers", async () => {
    const row = await seedOne();
    let clock = new Date();
    let fail = true;
    const flaky = (async () => {
      if (fail) throw new Error("ECONNRESET");
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
    const args = { ingestUrl: INGEST, secret: SECRET, store: memoryOutbox, unsafeAllowMockStore: true, fetch: flaky, now: () => clock };
    expect((await deliverOutbox(args)).retried).toBe(1);
    expect(row.last_error).toBe("ECONNRESET");
    fail = false;
    clock = new Date(clock.getTime() + 60_000);
    expect((await deliverOutbox(args)).delivered).toBe(1);
    expect(row.status).toBe("delivered");
  });

  it("dead-letters rows whose subject no longer exists", async () => {
    const d = getPosDriver();
    memoryOutbox.append({
      tenant_id: DEMO_TENANT_ID,
      location_id: DEMO_LOCATION_DOWNTOWN_ID,
      event_type: "order.updated",
      subject_type: "order",
      subject_id: "99999999-0000-4000-8000-000000000009",
      subject_version: 2,
    });
    const res = await deliverOutbox({
      ingestUrl: INGEST,
      secret: SECRET,
      store: memoryOutbox,
      unsafeAllowMockStore: true,
      driver: d,
      fetch: (async () => new Response(null, { status: 200 })) as unknown as typeof fetch,
    });
    expect(res.dead).toBe(1);
    expect(memoryOutbox.rows[0]!.last_error).toBe("subject_gone");
  });
});

describe("hardening", () => {
  it("never signs or sends from the mock store by default", async () => {
    await getPosDriver().createOrder(orderInput("77777777-0000-4000-8000-000000000001"));
    let called = false;
    const res = await deliverOutbox({
      ingestUrl: INGEST,
      secret: SECRET,
      store: memoryOutbox,
      fetch: (async () => {
        called = true;
        return new Response(null, { status: 200 });
      }) as unknown as typeof fetch,
    });
    expect(res.skipped).toBe("mock_store");
    expect(called).toBe(false);
    expect(memoryOutbox.rows[0]!.attempts).toBe(0);
  });

  it("claim counts the attempt, so a hydration timeout still dead-letters", async () => {
    await getPosDriver().createOrder(orderInput("77777777-0000-4000-8000-000000000002"));
    const row = memoryOutbox.rows[0]!;
    let clock = new Date(Date.now() + 1000);
    const hangingDriver = { getOrder: () => new Promise(() => undefined) } as never;
    const args = () => ({
      ingestUrl: INGEST,
      secret: SECRET,
      store: memoryOutbox,
      unsafeAllowMockStore: true,
      driver: hangingDriver,
      hydrateTimeoutMs: 5,
      now: () => clock,
      random: () => 0.5,
      fetch: (async () => new Response(null, { status: 200 })) as unknown as typeof fetch,
    });
    for (let i = 0; i < RETRY_SCHEDULE_SECONDS.length; i++) {
      await deliverOutbox(args());
      expect(row.attempts).toBe(i + 1);
      clock = new Date(new Date(row.next_attempt_at).getTime() + 1000);
    }
    const last = await deliverOutbox(args());
    expect(last.dead).toBe(1);
    expect(row.status).toBe("dead");
    expect(row.last_error).toBe("hydration timed out");
  });

  it("menu edits coalesce into an unclaimed row and keep every item id", async () => {
    const d = getPosDriver();
    const cat = "20000000-0000-0000-0000-000000000001";
    const a = await d.upsertItem({ tenant_id: DEMO_TENANT_ID, category_id: cat, name: "A" });
    const b = await d.upsertItem({ tenant_id: DEMO_TENANT_ID, category_id: cat, name: "B" });
    expect(memoryOutbox.rows).toHaveLength(1);
    expect(memoryOutbox.rows[0]!.row_snapshot?.changed_item_ids).toEqual([a.id, b.id]);
    // once claimed, a new edit is NOT dropped: it gets its own row
    await memoryOutbox.claim(10, new Date(Date.now() + 1000));
    const c = await d.upsertItem({ tenant_id: DEMO_TENANT_ID, category_id: cat, name: "C" });
    expect(memoryOutbox.rows).toHaveLength(2);
    expect(memoryOutbox.rows[1]!.row_snapshot?.changed_item_ids).toEqual([c.id]);
    const ev = await hydrateEvent(memoryOutbox.rows[0]!, d);
    expect((ev!.data as { changed_item_ids: string[] }).changed_item_ids).toEqual([a.id, b.id]);
  });

  it("customer events hydrate without scanning tenant orders", async () => {
    const d = getPosDriver();
    const now = new Date().toISOString();
    await d.upsertCustomer({
      id: "88888888-0000-4000-8000-000000000001",
      tenant_id: DEMO_TENANT_ID,
      email: "scan@example.com",
      name: "No Scan",
      phone: null,
      verified: false,
      created_at: now,
      updated_at: now,
    });
    const spy = { ...d, listOrders: () => { throw new Error("tenant scan!"); }, listOrdersPage: () => { throw new Error("tenant scan!"); } };
    const ev = await hydrateEvent(memoryOutbox.rows[0]!, spy as never);
    expect(ev?.type).toBe("customer.created");
  });
});

describe("hub env", () => {
  it("is null unless both URL and secret are set; secrets split on commas", () => {
    expect(readHubEnv({})).toBeNull();
    expect(readHubEnv({ OPENPIZZA_HUB_INGEST_URL: INGEST })).toBeNull();
    expect(
      readHubEnv({ OPENPIZZA_HUB_INGEST_URL: INGEST, OPENPIZZA_HUB_WEBHOOK_SECRET: "a, b" }),
    ).toEqual({ ingestUrl: INGEST, secret: ["a", "b"] });
  });
});
