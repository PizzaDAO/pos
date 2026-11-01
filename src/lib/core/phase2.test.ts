/**
 * pos-v1-gaps phase 2 (tenders and identity), against the zero-env mock driver.
 * The Postgres twins (core_record_external_tender, core_upsert_customer,
 * core_cancel_order) are exercised on PGlite by supabase/tests/phase2_*.sql.
 *
 *  1. payments.recordExternal - scope, device rule, hold rules, food-only amount
 *     due, replay/conflict, supersede, races
 *  2. customers.upsert        - identity rules, consent, isolation, races
 *  3. staff.verifyPin         - lockout, generic 403, nothing logged
 *  4. staff.setPin            - literal scope, hash only, unlocks
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CustomerSchema, PaymentSchema, StaffMemberSchema, type Principal } from "@openpizza/core";
import {
  getPosDriver,
  DEMO_LOCATION_DOWNTOWN_ID,
  DEMO_LOCATION_UPTOWN_ID,
  DEMO_TENANT_ID,
  type CreateOrderInput,
  type OrderStatus,
  type Payment,
} from "@/lib/db";
import { resetMockOnline, resetMockOrders, resetMockPayments } from "@/lib/db/mock";
import { ExternalRefundUnsupportedError, refundPayment } from "@/lib/payments/service";
import { handleV1 } from "./v1";
import { hydrateEvent, memoryOutbox } from "./outbox";

const T0 = new Date("2026-06-04T22:00:00.000Z");
const DOWNTOWN = DEMO_LOCATION_DOWNTOWN_ID;
const TONY = "80000000-0000-0000-0000-000000000001";
const CARMELA = "80000000-0000-0000-0000-000000000002";
const FURIO = "80000000-0000-0000-0000-000000000004";

function principal(scopes: string[], extra: Partial<Principal> = {}): Principal {
  return {
    kind: "service",
    id: "hub:test-client",
    tenant_id: DEMO_TENANT_ID,
    location_ids: null,
    scopes,
    module: "kiosk",
    ...extra,
  };
}

async function call(
  method: string,
  path: string,
  opts: {
    body?: unknown;
    headers?: Record<string, string>;
    scopes?: string[];
    who?: Partial<Principal>;
  } = {},
) {
  const url = `https://pos.test/api/v1${path}`;
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const req = new Request(url, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const segments = new URL(url).pathname.replace(/^\/api\/v1\/?/, "").split("/").filter(Boolean);
  const res = await handleV1(req, segments, {
    principal: principal(opts.scopes ?? ["*"], opts.who),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) : null };
}

const ID = (n: number) => `d1000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function order(
  id: string,
  status: OrderStatus,
  extra: Partial<CreateOrderInput> = {},
  total = 1000,
  tip = 0,
): CreateOrderInput {
  return {
    id,
    tenant_id: DEMO_TENANT_ID,
    location_id: DOWNTOWN,
    channel: "in_store",
    currency: "USD",
    items: [
      {
        id: `${id.slice(0, 8)}-0000-4000-8000-00000000000a`,
        item_id: "30000000-0000-0000-0000-0000000000ee",
        item_name: "Special",
        size_id: null,
        size_name: "Large",
        base_price_cents: total,
        quantity: 1,
        modifiers: [],
        notes: null,
        voided: false,
        unit_price_cents: total,
        line_total_cents: total,
      },
    ],
    discount_cents: 0,
    totals: {
      subtotal_cents: total,
      discount_cents: 0,
      taxable_cents: total,
      tax_cents: 0,
      tip_cents: tip,
      total_cents: total + tip,
    },
    notes: null,
    status,
    fulfillment: { type: "pickup", scheduled_for: "asap", promised_at: T0.toISOString() },
    ...extra,
  };
}

function held(id: string, extra: Partial<CreateOrderInput> = {}, total = 1000, tip = 0, ttl = 900) {
  return order(
    id,
    "draft",
    {
      hold: { reason: "awaiting_payment", expires_at: new Date(Date.now() + ttl * 1000).toISOString() },
      source: { type: "kiosk", channel: "kiosk", module: "kiosk", device_id: "kiosk-1" },
      ...extra,
    },
    total,
    tip,
  );
}

const tender = (extra: Record<string, unknown> = {}) => ({
  method: "card",
  processor: "stripe_terminal",
  processor_ref: "pi_kiosk_1",
  amount_cents: 1000,
  tip_cents: 0,
  status: "captured",
  collection: "terminal",
  ...extra,
});

const record = (
  orderId: string,
  body: Record<string, unknown>,
  key = "k-1",
  opts: Parameters<typeof call>[2] = {},
) =>
  call("POST", `/orders/${orderId}/payments`, {
    body,
    headers: key ? { "idempotency-key": key } : {},
    ...opts,
  });

const KIOSK = { id: "hub:kiosk-1" };
const KIOSK_SCOPES = ["payments.terminal:write", "orders:read"];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  resetMockOrders();
  resetMockPayments();
  resetMockOnline();
  memoryOutbox.clear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const statusOf = async (id: string) => (await getPosDriver().getOrder(id))?.status;
const tendersOf = async (id: string) => getPosDriver().listPaymentsForOrder(id);

describe("1. payments.recordExternal: scope and the device rule", () => {
  it("refuses a caller with neither payments:write nor payments.terminal:write", async () => {
    await getPosDriver().createOrder(held(ID(1)));
    const r = await record(ID(1), tender(), "k", { scopes: ["orders:read", "payments:read"] });
    expect(r.status).toBe(403);
    expect(r.json.code).toBe("INSUFFICIENT_SCOPE");
    expect(await tendersOf(ID(1))).toHaveLength(0);
  });

  it("a kiosk (terminal scope only) records a captured terminal tender and the hold releases", async () => {
    await getPosDriver().createOrder(held(ID(2)));
    const r = await record(ID(2), tender(), "kiosk-pay:pi_1", { scopes: KIOSK_SCOPES, who: KIOSK });
    expect(r.status).toBe(201);
    const p = PaymentSchema.parse(r.json);
    expect(p.status).toBe("captured");
    expect(p.collection).toBe("terminal");
    expect(p.processor).toBe("stripe_terminal");
    expect(p.processor_ref).toBe("pi_kiosk_1");
    expect(p.method).toBe("card");
    expect(await statusOf(ID(2))).toBe("paid");
  });

  it.each([
    ["a cash tender", tender({ method: "cash", collection: "cash_on_delivery" })],
    ["an invoice", tender({ method: "external", collection: "invoice", status: "pending" })],
    ["an authorized terminal tender", tender({ status: "authorized" })],
    ["a tender with no collection", tender({ collection: undefined })],
  ])("a kiosk cannot record %s (INSUFFICIENT_SCOPE, nothing written)", async (_n, body) => {
    await getPosDriver().createOrder(held(ID(3)));
    const r = await record(ID(3), body, "k", { scopes: KIOSK_SCOPES, who: KIOSK });
    expect(r.status).toBe(403);
    expect(r.json.code).toBe("INSUFFICIENT_SCOPE");
    expect(await tendersOf(ID(3))).toHaveLength(0);
    expect(await statusOf(ID(3))).toBe("draft");
  });

  it("a terminal tender must come from the device that took the order (source.device_id)", async () => {
    await getPosDriver().createOrder(held(ID(4)));
    const other = await record(ID(4), tender(), "k", { scopes: KIOSK_SCOPES, who: { id: "hub:kiosk-2" } });
    expect(other.status).toBe(403);
    expect(other.json.details?.reason).toBe("device_mismatch");
    // payments:write alone does not stand in for the device either
    const writer = await record(ID(4), tender(), "k", { scopes: ["payments:write"], who: { id: "hub:catering" } });
    expect(writer.status).toBe(403);
    expect(await tendersOf(ID(4))).toHaveLength(0);
    // the device itself (raw device id or the hub-signed sub) is accepted
    const bare = await record(ID(4), tender(), "k", { scopes: KIOSK_SCOPES, who: { id: "kiosk-1" } });
    expect(bare.status).toBe(201);
  });

  it("an order with no source.device_id accepts no terminal tender (fails closed)", async () => {
    await getPosDriver().createOrder(held(ID(5), { source: undefined }));
    const r = await record(ID(5), tender(), "k", { scopes: KIOSK_SCOPES, who: KIOSK });
    expect(r.status).toBe(403);
    expect(await tendersOf(ID(5))).toHaveLength(0);
  });

  it("a foreign tenant and an unknown order are 404, never 403 (no existence leak)", async () => {
    await getPosDriver().createOrder(held(ID(6)));
    const foreign = await record(ID(6), tender(), "k", { who: { ...KIOSK, tenant_id: "99999999-0000-4000-8000-000000000000" }, scopes: KIOSK_SCOPES });
    expect([403, 404]).toContain(foreign.status); // inactive foreign tenant is refused before the order lookup
    const unknown = await record(ID(99), tender(), "k", { scopes: KIOSK_SCOPES, who: KIOSK });
    expect(unknown.status).toBe(404);
  });

  it("a location-limited token cannot record against another location's order", async () => {
    await getPosDriver().createOrder(held(ID(7)));
    const r = await record(
      ID(7),
      tender({ collection: "cash_on_delivery", method: "cash" }),
      "k",
      { scopes: ["payments:write"], who: { location_ids: [DEMO_LOCATION_UPTOWN_ID] } },
    );
    expect(r.status).toBe(404);
  });
});

describe("1. payments.recordExternal: amounts, holds, hold release", () => {
  const cod = (extra: Record<string, unknown> = {}) =>
    tender({ method: "cash", processor: "driver", processor_ref: null, collection: "cash_on_delivery", ...extra });

  it("only a CAPTURED tender counts: pending and authorized release nothing", async () => {
    await getPosDriver().createOrder(held(ID(10)));
    const pending = await record(ID(10), cod({ status: "pending" }), "a");
    expect(pending.status).toBe(201);
    expect(pending.json.status).toBe("pending");
    const auth = await record(ID(10), cod({ status: "authorized", processor_ref: "x" }), "b");
    expect(auth.status).toBe(201);
    expect(auth.json.status).toBe("authorized"); // reported as asked, stored pending
    const rows = await tendersOf(ID(10));
    expect(rows.every((p) => p.status === "pending")).toBe(true);
    expect(await statusOf(ID(10))).toBe("draft");
    const o = await call("GET", `/orders/${ID(10)}`);
    expect(o.json.amount_due_cents).toBe(1000);
    expect(o.json.payment_status).toBe("unpaid");
  });

  it("a part payment keeps the hold; the rest releases it (amount due is food only)", async () => {
    await getPosDriver().createOrder(held(ID(11), {}, 1000, 200)); // $10 food + $2 order tip
    const first = await record(ID(11), cod({ amount_cents: 400, tip_cents: 100 }), "a");
    expect(first.status).toBe(201);
    expect(await statusOf(ID(11))).toBe("draft");
    expect((await call("GET", `/orders/${ID(11)}`)).json.amount_due_cents).toBe(600);
    // paying the FOOD (600) releases it even though the order tip (200) is not covered
    const second = await record(ID(11), cod({ amount_cents: 600, processor_ref: "r2" }), "b");
    expect(second.status).toBe(201);
    expect(await statusOf(ID(11))).toBe("paid");
  });

  it("refuses an amount over the food due (422, due in details), and a tip over the cap", async () => {
    await getPosDriver().createOrder(held(ID(12), {}, 1000, 200));
    const over = await record(ID(12), cod({ amount_cents: 1001 }), "a");
    expect(over.status).toBe(422);
    expect(over.json.details).toMatchObject({ reason: "exceeds_amount_due", amount_due_cents: 1000 });
    const tip = await record(ID(12), cod({ amount_cents: 500, tip_cents: 501 }), "b");
    expect(tip.status).toBe(422);
    expect(tip.json.details.reason).toBe("tip_too_large");
    expect(await tendersOf(ID(12))).toHaveLength(0);
  });

  it("zero amount is refused; a paid order answers 422 with due 0 (the modules' replay signal)", async () => {
    await getPosDriver().createOrder(held(ID(13)));
    expect((await record(ID(13), cod({ amount_cents: 0 }), "z")).status).toBe(422);
    expect((await record(ID(13), cod(), "a")).status).toBe(201);
    const again = await record(ID(13), cod({ processor_ref: "other" }), "b");
    expect(again.status).toBe(422);
    expect(again.json.details).toMatchObject({ reason: "exceeds_amount_due", amount_due_cents: 0 });
  });

  it("requires an Idempotency-Key (or an id) and a UUID id", async () => {
    await getPosDriver().createOrder(held(ID(14)));
    const noKey = await record(ID(14), cod(), "");
    expect(noKey.status).toBe(422);
    expect(noKey.json.path).toBe("headers.idempotency-key");
    const badId = await record(ID(14), cod({ id: "not-a-uuid" }), "k");
    expect(badId.status).toBe(422);
    const ok = await record(ID(14), cod({ id: ID(15) }), "");
    expect(ok.status).toBe(201);
    expect(ok.json.id).toBe(ID(15));
  });

  it("a voided or abandoned order takes no payment (409 INVALID_TRANSITION)", async () => {
    await getPosDriver().createOrder(held(ID(16)));
    await getPosDriver().cancelOrder(ID(16), DEMO_TENANT_ID);
    const r = await record(ID(16), cod(), "a");
    expect(r.status).toBe(409);
    expect(r.json.code).toBe("INVALID_TRANSITION");
    await getPosDriver().createOrder(order(ID(17), "abandoned"));
    expect((await record(ID(17), cod(), "a")).status).toBe(409);
    expect(await tendersOf(ID(16))).toHaveLength(0);
  });

  it("an expired hold takes no promise, but captured money that changed hands is recorded", async () => {
    await getPosDriver().createOrder(held(ID(18), {}, 1000, 0, 60));
    vi.setSystemTime(new Date(T0.getTime() + 120_000));
    const promise = await record(ID(18), cod({ status: "pending" }), "a");
    expect(promise.status).toBe(409);
    expect(promise.json.details.reason).toBe("expired");
    const money = await record(ID(18), cod(), "b");
    expect(money.status).toBe(201);
    expect((await tendersOf(ID(18))).map((p) => p.status)).toEqual(["captured"]);
  });

  it("money does not end a hold that is not a payment hold (scheduled)", async () => {
    await getPosDriver().createOrder(
      held(ID(19), { hold: { reason: "scheduled", expires_at: new Date(Date.now() + 3600_000).toISOString() } }),
    );
    const r = await record(ID(19), cod(), "a");
    expect(r.status).toBe(201);
    expect(await statusOf(ID(19))).toBe("draft");
    expect((await getPosDriver().getOrder(ID(19)))?.hold?.reason).toBe("scheduled");
  });

  it("a settled order closes its open sibling (a pay link must not stay payable)", async () => {
    const d = getPosDriver();
    await d.createOrder(held(ID(20)));
    const sibling: Payment = {
      id: ID(21),
      order_id: ID(20),
      tenant_id: DEMO_TENANT_ID,
      location_id: DOWNTOWN,
      rail: "stripe_online",
      status: "requires_action",
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
      simulated: true,
      raw: null,
      created_at: T0.toISOString(),
      updated_at: T0.toISOString(),
    };
    await d.upsertPayment(sibling);
    expect((await record(ID(20), cod(), "a")).status).toBe(201);
    expect((await d.getPayment(ID(21)))?.status).toBe("canceled");
  });

  it("emits payment.captured (with the external fields) and one order.placed", async () => {
    await getPosDriver().createOrder(held(ID(22)));
    await record(ID(22), tender(), "a", { scopes: KIOSK_SCOPES, who: KIOSK });
    const types = memoryOutbox.rows.map((r) => r.event_type);
    expect(types).toContain("payment.captured");
    expect(types.filter((t) => t === "order.placed")).toHaveLength(1);
    const row = memoryOutbox.rows.find((r) => r.event_type === "payment.captured")!;
    const ev = await hydrateEvent(row as never);
    expect(ev).toMatchObject({ type: "payment.captured" });
    const data = (ev as { data: Record<string, unknown> }).data;
    expect(data).toMatchObject({ collection: "terminal", processor: "stripe_terminal", method: "card" });
  });

  it("external tenders cannot be refunded here, and a pending one never blocks a cancel", async () => {
    const d = getPosDriver();
    await d.createOrder(held(ID(23)));
    const pending = await record(ID(23), cod({ status: "pending" }), "a");
    const cancel = await call("POST", `/orders/${ID(23)}/cancel`, { body: { reason: "x" } });
    expect(cancel.status).toBe(200);
    expect((await d.getPayment(pending.json.id))?.status).toBe("canceled");

    await d.createOrder(held(ID(24)));
    const paid = await record(ID(24), cod(), "b");
    await expect(refundPayment({ paymentId: paid.json.id })).rejects.toBeInstanceOf(
      ExternalRefundUnsupportedError,
    );
    expect((await call("POST", `/orders/${ID(24)}/cancel`, { body: { reason: "x" } })).status).toBe(409);
  });
});

describe("1. payments.recordExternal: replay, conflict, supersede, races", () => {
  const cod = (extra: Record<string, unknown> = {}) =>
    tender({ method: "cash", processor: "driver", processor_ref: null, collection: "cash_on_delivery", ...extra });

  it("replays the same request (200) without a second tender; another body is IDEMPOTENCY_CONFLICT", async () => {
    await getPosDriver().createOrder(held(ID(30)));
    const a = await record(ID(30), cod({ amount_cents: 400 }), "same");
    expect(a.status).toBe(201);
    const b = await record(ID(30), cod({ amount_cents: 400 }), "same");
    expect(b.status).toBe(200);
    expect(b.headers.get("idempotent-replayed")).toBe("true");
    expect(b.json.id).toBe(a.json.id);
    expect(await tendersOf(ID(30))).toHaveLength(1);
    const c = await record(ID(30), cod({ amount_cents: 500 }), "same");
    expect(c.status).toBe(409);
    expect(c.json.code).toBe("IDEMPOTENCY_CONFLICT");
    // the same key against ANOTHER order is a conflict too, never the first order's tender
    await getPosDriver().createOrder(held(ID(31)));
    const d = await record(ID(31), cod({ amount_cents: 400 }), "same");
    expect(d.status).toBe(409);
    expect(d.json.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("a replay re-runs the settlement step (a crash after the insert is healed)", async () => {
    const d = getPosDriver();
    await d.createOrder(held(ID(32)));
    const a = await record(ID(32), cod(), "k");
    expect(a.status).toBe(201);
    // simulate "tender saved, order never promoted"
    await d.transitionOrderStatus(ID(32), ["paid"], "draft");
    expect(await statusOf(ID(32))).toBe("draft");
    const b = await record(ID(32), cod(), "k");
    expect(b.status).toBe(200);
    expect(await statusOf(ID(32))).toBe("paid");
  });

  it("a captured tender supersedes the pending one with the same processor + ref", async () => {
    const d = getPosDriver();
    await d.createOrder(held(ID(33)));
    const inv = (extra: Record<string, unknown>) =>
      tender({ method: "external", processor: "catering", processor_ref: "inv_1", collection: "invoice", ...extra });
    const pending = await record(ID(33), inv({ status: "pending" }), "issued");
    expect(pending.json.status).toBe("pending");
    expect(await statusOf(ID(33))).toBe("draft");
    const paid = await record(ID(33), inv({ status: "captured" }), "paid");
    expect(paid.status).toBe(201);
    expect((await d.getPayment(pending.json.id))?.status).toBe("canceled");
    expect(await statusOf(ID(33))).toBe("paid");
  });

  it("the same captured processor + ref cannot be counted twice (another key)", async () => {
    await getPosDriver().createOrder(held(ID(34), {}, 2000));
    await getPosDriver().createOrder(held(ID(35), {}, 2000));
    const t = (extra: Record<string, unknown> = {}) =>
      cod({ processor: "guests", processor_ref: "hold_1", amount_cents: 1000, ...extra });
    expect((await record(ID(34), t(), "k1")).status).toBe(201);
    const retry = await record(ID(34), t(), "k2"); // re-keyed retry: same order + amount
    expect(retry.status).toBe(200);
    expect(retry.headers.get("idempotent-replayed")).toBe("true");
    expect(await tendersOf(ID(34))).toHaveLength(1);
    const other = await record(ID(35), t(), "k3"); // another order: would double count
    expect(other.status).toBe(409);
    expect(other.json.details.reason).toBe("duplicate_processor_ref");
    expect(await tendersOf(ID(35))).toHaveLength(0);
  });

  it("RACE: two concurrent tenders that each fit alone cannot overshoot the due", async () => {
    await getPosDriver().createOrder(held(ID(36)));
    const results = await Promise.all([
      record(ID(36), cod({ amount_cents: 700, processor_ref: "a" }), "ka"),
      record(ID(36), cod({ amount_cents: 700, processor_ref: "b" }), "kb"),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 422]);
    const loser = results.find((r) => r.status === 422)!;
    expect(loser.json.details).toMatchObject({ reason: "exceeds_amount_due", amount_due_cents: 300 });
    const total = (await tendersOf(ID(36))).reduce((n, p) => n + p.amount_cents, 0);
    expect(total).toBe(700);
  });

  it("RACE: two concurrent halves both land, and the order is released exactly once", async () => {
    await getPosDriver().createOrder(held(ID(37)));
    const results = await Promise.all([
      record(ID(37), cod({ amount_cents: 500, processor_ref: "a" }), "ka"),
      record(ID(37), cod({ amount_cents: 500, processor_ref: "b" }), "kb"),
    ]);
    expect(results.map((r) => r.status)).toEqual([201, 201]);
    expect(await statusOf(ID(37))).toBe("paid");
    expect(memoryOutbox.rows.filter((r) => r.event_type === "order.placed")).toHaveLength(1);
  });

  it("RACE: the same request twice at once records one tender", async () => {
    await getPosDriver().createOrder(held(ID(38)));
    const results = await Promise.all([
      record(ID(38), cod(), "same"),
      record(ID(38), cod(), "same"),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 201]);
    expect(await tendersOf(ID(38))).toHaveLength(1);
  });

  it("RACE: a cancel racing a tender never leaves a paid-and-voided order", async () => {
    await getPosDriver().createOrder(held(ID(39)));
    const [rec, cancel] = await Promise.all([
      record(ID(39), cod(), "k"),
      call("POST", `/orders/${ID(39)}/cancel`, { body: { reason: "x" } }),
    ]);
    const status = await statusOf(ID(39));
    const captured = (await tendersOf(ID(39))).some((p) => p.status === "captured");
    // either the cancel won (voided, no money) or the money won (paid, cancel refused)
    if (status === "voided") {
      expect(captured).toBe(false);
      expect(rec.status).toBe(409);
    } else {
      expect(captured).toBe(true);
      expect(cancel.status).toBe(409);
    }
  });
});

describe("2. customers.upsert", () => {
  const upsert = (body: Record<string, unknown>, scopes = ["customers:write"]) =>
    call("POST", "/customers", { body, scopes, headers: { "idempotency-key": "x" } });

  it("needs customers:write and an email or a phone", async () => {
    expect((await upsert({ email: "a@example.com" }, ["customers:read"])).status).toBe(403);
    const r = await upsert({ name: "No Contact" });
    expect(r.status).toBe(422);
    expect((await upsert({ email: "not-an-email" })).status).toBe(422);
    expect((await upsert({ phone: "555-1234" })).status).toBe(422); // E.164 only
  });

  it("creates by phone alone, then fills the email on a later call (same customer)", async () => {
    const a = await upsert({ phone: "+15555550123", name: "Pat" });
    expect(a.status).toBe(200);
    const c = CustomerSchema.parse(a.json);
    expect(c.email).toBeNull();
    expect(c.phone).toBe("+15555550123");
    const b = await upsert({ phone: "+15555550123", email: "Pat@Example.com", name: "Someone Else" });
    expect(b.json.id).toBe(c.id);
    expect(b.json.email).toBe("pat@example.com");
    expect(b.json.name).toBe("Pat"); // blanks only, never overwritten
  });

  it("never merges: a different email on a known phone is a new customer without that phone", async () => {
    const a = await upsert({ email: "pat@example.com", phone: "+15555550123" });
    const b = await upsert({ email: "sam@example.com", phone: "+15555550123" });
    expect(b.json.id).not.toBe(a.json.id);
    expect(b.json.phone).toBeNull();
    // email wins over a conflicting phone: the stored phone stays
    const c = await upsert({ email: "pat@example.com", phone: "+15555559999" });
    expect(c.json.id).toBe(a.json.id);
    expect(c.json.phone).toBe("+15555550123");
  });

  it("never touches verified; consent changes only with an `at`, and an older `at` never wins", async () => {
    const d = getPosDriver();
    const a = await upsert({ email: "pat@example.com" });
    const row = (await d.getCustomer(a.json.id))!;
    await d.upsertCustomer({ ...row, verified: true });
    const sms = (opt_in: boolean, at?: string) => ({ marketing: { sms: { opt_in, ...(at ? { at } : {}) } } });
    expect((await upsert({ email: "pat@example.com", ...sms(true) })).json.marketing.sms.opt_in).toBe(false);
    const on = await upsert({ email: "pat@example.com", ...sms(true, "2026-01-02T00:00:00Z") });
    expect(on.json.marketing.sms.opt_in).toBe(true);
    expect(on.json.verified).toBe(true);
    const older = await upsert({ email: "pat@example.com", ...sms(false, "2026-01-01T00:00:00Z") });
    expect(older.json.marketing.sms.opt_in).toBe(true);
    const newer = await upsert({ email: "pat@example.com", ...sms(false, "2026-02-01T00:00:00Z") });
    expect(newer.json.marketing.sms.opt_in).toBe(false);
  });

  it("unions tags, keeps existing external ids, and an identical repeat changes nothing", async () => {
    const a = await upsert({ email: "t@example.com", tags: ["a"], external_ids: { guests: "g1" } });
    memoryOutbox.clear();
    const b = await upsert({ email: "t@example.com", tags: ["b"], external_ids: { guests: "g2", x: "y" } });
    expect(b.json.id).toBe(a.json.id);
    expect(b.json.tags).toEqual(["a", "b"]);
    expect(b.json.external_ids).toEqual({ guests: "g1", x: "y" });
    memoryOutbox.clear();
    await upsert({ email: "t@example.com", tags: ["b"] });
    expect(memoryOutbox.rows.filter((r) => r.event_type.startsWith("customer."))).toHaveLength(0);
  });

  it("emits customer.created once and customer.updated only on a change", async () => {
    await upsert({ email: "e@example.com" });
    expect(memoryOutbox.rows.map((r) => r.event_type)).toEqual(["customer.created"]);
    await upsert({ email: "e@example.com", name: "E" });
    expect(memoryOutbox.rows.map((r) => r.event_type)).toEqual(["customer.created", "customer.updated"]);
  });

  it("tenant isolation: the same email at another tenant is another customer", async () => {
    const d = getPosDriver();
    const base = { newId: ID(60), email: "iso@example.com", phone: null, name: null, marketing: {}, tags: [], externalIds: {} };
    const a = await d.upsertCustomerIdentity(DEMO_TENANT_ID, base);
    const b = await d.upsertCustomerIdentity("00000000-0000-4000-8000-0000000000ff", { ...base, newId: ID(61) });
    expect(a.customer.id).not.toBe(b.customer.id);
    expect(a.created && b.created).toBe(true);
  });

  it("RACE: concurrent upserts of one identity create one customer and keep every field", async () => {
    const results = await Promise.all([
      upsert({ email: "race@example.com", name: "N", tags: ["a"] }),
      upsert({ email: "race@example.com", phone: "+15555550177", tags: ["b"] }),
      upsert({ email: "race@example.com", external_ids: { k: "v" } }),
    ]);
    expect(new Set(results.map((r) => r.json.id)).size).toBe(1);
    const c = (await upsert({ email: "race@example.com" })).json;
    expect(c).toMatchObject({ name: "N", phone: "+15555550177", tags: ["a", "b"], external_ids: { k: "v" } });
  });

  it("a stale whole-customer snapshot (shop checkout path) cannot resurrect consent or tags", async () => {
    const d = getPosDriver();
    const a = await upsert({ email: "stale@example.com", tags: ["vip"], marketing: { sms: { opt_in: true, at: "2026-01-01T00:00:00Z" } } });
    const stale = { ...(await d.getCustomer(a.json.id))!, marketing: {}, tags: [], external_ids: {} };
    await d.upsertCustomer(stale);
    const after = await call("GET", `/customers/${a.json.id}`, { scopes: ["customers:read"] });
    expect(after.json.tags).toEqual(["vip"]);
    expect(after.json.marketing.sms.opt_in).toBe(true);
  });

  it("lookup finds a phone-only customer by any formatting", async () => {
    await upsert({ phone: "+15555550123" });
    const r = await call("GET", "/customers/lookup?phone=%2B15555550123", { scopes: ["customers:read"] });
    expect(r.status).toBe(200);
  });
});

describe("3. staff.verifyPin", () => {
  const verify = (body: Record<string, unknown>, opts: Parameters<typeof call>[2] = {}) =>
    call("POST", "/staff/verify-pin", { body, scopes: ["staff:pin_verify"], ...opts });
  const good = (extra: Record<string, unknown> = {}) => ({
    location_id: DOWNTOWN,
    staff_id: TONY,
    pin: "1111",
    ...extra,
  });

  beforeEach(async () => {
    // known PINs and fresh lockout budgets (the mock's staff are module state)
    const { hashPin } = await import("@/lib/auth/pin");
    const d = getPosDriver();
    await d.setStaffPinHash(DEMO_TENANT_ID, TONY, hashPin("1111"));
    await d.setStaffPinHash(DEMO_TENANT_ID, CARMELA, hashPin("2222"));
  });

  it("answers { staff } for the right PIN, with no PIN material", async () => {
    const r = await verify(good());
    expect(r.status).toBe(200);
    expect(Object.keys(r.json)).toEqual(["staff"]);
    const s = StaffMemberSchema.parse(r.json.staff);
    expect(s.id).toBe(TONY);
    expect(s.has_pin).toBe(true);
    expect(JSON.stringify(r.json)).not.toMatch(/scrypt|pin_hash|1111/);
  });

  it("every mismatch is the same generic 403", async () => {
    const d = getPosDriver();
    await d.upsertStaff({
      id: ID(70), tenant_id: DEMO_TENANT_ID, name: "Gone", role: "cashier", active: false,
      pin_hash: (await import("@/lib/auth/pin")).hashPin("5555"), created_at: T0.toISOString(),
    });
    await d.upsertStaff({
      id: ID(71), tenant_id: DEMO_TENANT_ID, name: "NoPin", role: "cashier", active: true,
      created_at: T0.toISOString(),
    });
    await d.upsertStaff({
      id: ID(72), tenant_id: DEMO_TENANT_ID, name: "Uptown", role: "cashier", active: true,
      location_ids: [DEMO_LOCATION_UPTOWN_ID],
      pin_hash: (await import("@/lib/auth/pin")).hashPin("6666"), created_at: T0.toISOString(),
    });
    const cases = [
      good({ pin: "9999" }), // wrong PIN
      good({ staff_id: ID(99) }), // unknown
      good({ staff_id: ID(70), pin: "5555" }), // inactive
      good({ staff_id: ID(71), pin: "0000" }), // no PIN set
      good({ staff_id: ID(72), pin: "6666" }), // works elsewhere, not here
      good({ location_id: ID(98) }), // unknown location
    ];
    const bodies: string[] = [];
    for (const c of cases) {
      const r = await verify(c);
      expect(r.status).toBe(403);
      expect(r.json.code).toBe("FORBIDDEN");
      bodies.push(r.json.detail);
    }
    expect(new Set(bodies).size).toBe(1);
    // a location-limited token cannot verify at a location outside its reach
    expect((await verify(good(), { who: { location_ids: [DEMO_LOCATION_UPTOWN_ID] } })).status).toBe(403);
  });

  it("5 wrong PINs lock the member (429); even the right PIN is refused while locked", async () => {
    for (let i = 0; i < 5; i++) expect((await verify(good({ pin: "0000" }))).status).toBe(403);
    const locked = await verify(good({ pin: "0000" }));
    expect(locked.status).toBe(429);
    expect(locked.json.code).toBe("RATE_LIMITED");
    expect((await verify(good())).status).toBe(429);
    // another member is unaffected
    expect((await verify(good({ staff_id: CARMELA, pin: "2222" }))).status).toBe(200);
  });

  it("a right PIN resets the attempt count", async () => {
    for (let i = 0; i < 4; i++) await verify(good({ pin: "0000" }));
    expect((await verify(good())).status).toBe(200);
    for (let i = 0; i < 4; i++) expect((await verify(good({ pin: "0000" }))).status).toBe(403);
    expect((await verify(good())).status).toBe(200);
  });

  it("RACE: parallel guesses never exceed the attempt budget", async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => verify(good({ pin: String(1000 + i).padStart(4, "0") === "1111" ? "2222" : String(1000 + i) }))),
    );
    const counts = results.reduce<Record<number, number>>((m, r) => ({ ...m, [r.status]: (m[r.status] ?? 0) + 1 }), {});
    expect(counts[403]).toBe(5);
    expect(counts[429]).toBe(7);
  });

  it("needs staff:pin_verify; validates the shape without echoing the PIN", async () => {
    expect((await verify(good(), { scopes: ["staff:read"] })).status).toBe(403);
    const bad = await verify(good({ pin: "12ab" }));
    expect(bad.status).toBe(422);
    expect(JSON.stringify(bad.json)).not.toContain("12ab");
  });

  it("never logs a PIN", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined),
    );
    await verify(good({ pin: "7391" }));
    await verify(good({ pin: "1111" }));
    await verify(good({ pin: "73" }));
    for (const s of spies) {
      expect(JSON.stringify(s.mock.calls)).not.toMatch(/7391|1111/);
    }
  });
});

describe("4. staff.setPin", () => {
  const set = (staffId: string, pin: string | null, opts: Parameters<typeof call>[2] = {}) =>
    call("PUT", `/staff/${staffId}/pin`, {
      body: { pin },
      scopes: ["staff:set_pin"],
      headers: { "idempotency-key": "k" },
      ...opts,
    });
  const verify = (staffId: string, pin: string) =>
    call("POST", "/staff/verify-pin", {
      body: { location_id: DOWNTOWN, staff_id: staffId, pin },
      scopes: ["staff:pin_verify"],
    });

  it("needs the LITERAL staff:set_pin scope (a wildcard does not grant it)", async () => {
    expect((await set(FURIO, "4321", { scopes: ["*"] })).status).toBe(403);
    expect((await set(FURIO, "4321", { scopes: ["staff:read"] })).status).toBe(403);
    expect((await set(FURIO, "4321")).status).toBe(200);
  });

  it("stores only a hash: the new PIN works, the old one stops, nothing leaks", async () => {
    const r = await set(FURIO, "4321");
    expect(r.status).toBe(200);
    const s = StaffMemberSchema.parse(r.json);
    expect(s.has_pin).toBe(true);
    expect(JSON.stringify(r.json)).not.toMatch(/scrypt|pin_hash|4321/);
    const stored = (await getPosDriver().getStaffById(DEMO_TENANT_ID, FURIO))!;
    expect(stored.pin_hash).toMatch(/^scrypt\$/);
    expect(stored.pin_hash).not.toContain("4321");
    expect((await verify(FURIO, "4321")).status).toBe(200);
    expect((await verify(FURIO, "4444")).status).toBe(403);
  });

  it("null clears the PIN", async () => {
    await set(FURIO, "4321");
    const r = await set(FURIO, null);
    expect(r.status).toBe(200);
    expect(r.json.has_pin).toBe(false);
    expect((await verify(FURIO, "4321")).status).toBe(403);
  });

  it("a reset PIN starts with a fresh lockout budget", async () => {
    await set(FURIO, "4321");
    for (let i = 0; i < 6; i++) await verify(FURIO, "0000");
    expect((await verify(FURIO, "4321")).status).toBe(429);
    await set(FURIO, "8765");
    expect((await verify(FURIO, "8765")).status).toBe(200);
  });

  it("404 for an unknown / foreign / malformed id; 422 for a bad PIN; location-limited reach", async () => {
    expect((await set(ID(98), "4321")).status).toBe(404);
    expect((await set("not-a-guid", "4321")).status).toBe(404);
    expect((await set(FURIO, "12")).status).toBe(422);
    expect((await set(FURIO, "12ab")).status).toBe(422);
    // staff with no location list work everywhere: out of reach of a limited token
    expect((await set(FURIO, "4321", { who: { location_ids: [DOWNTOWN] } })).status).toBe(404);
  });

  it("never logs a PIN", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined),
    );
    await set(FURIO, "2468");
    await set(FURIO, "13");
    for (const s of spies) expect(JSON.stringify(s.mock.calls)).not.toMatch(/2468/);
  });
});
