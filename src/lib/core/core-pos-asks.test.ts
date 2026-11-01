/**
 * Open Pizza "POS asks" (core 0.3.1 / 0.3.2), against the zero-env mock driver
 * (the Postgres twins live in supabase/migrations/20261104000000_core_pos_asks.sql):
 *  1. orders.extendHold  - bounds, cap, expiry, settled, idempotency, CAS races
 *  2. per-line fired_at / voided_at / status_at_void
 *  3. Payment.refunds[] (stable ids) + `refund` on payment.refunded events
 *  4. food-only amount_due_cents (orders + COD deliveries)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrderSchema, PaymentSchema, type Principal } from "@openpizza/core";
import {
  getPosDriver,
  DEMO_LOCATION_DOWNTOWN_ID,
  DEMO_TENANT_ID,
  type CreateOrderInput,
  type OrderItem,
  type OrderStatus,
  type Payment,
} from "@/lib/db";
import { resetMockOnline, resetMockOrders, resetMockPayments } from "@/lib/db/mock";
import { refundPayment } from "@/lib/payments/service";
import { handleV1 } from "./v1";
import { hydrateEvent, memoryOutbox } from "./outbox";
import { derivePaymentStatus, toContractOrder, toContractPayment } from "./mappers";

const T0 = new Date("2026-06-04T22:00:00.000Z");

function principal(scopes: string[]): Principal {
  return {
    kind: "service",
    id: "test-client",
    tenant_id: DEMO_TENANT_ID,
    location_ids: null,
    scopes,
    module: "guests",
  };
}

async function call(
  method: string,
  path: string,
  opts: { body?: unknown; headers?: Record<string, string>; scopes?: string[] } = {},
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
    principal: principal(opts.scopes ?? ["orders:write", "orders:read", "payments:read"]),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) : null };
}

const extend = (id: string, ttl: number, key?: string) =>
  call("POST", `/orders/${id}/hold/extend`, {
    body: { ttl_seconds: ttl },
    headers: key ? { "idempotency-key": key } : {},
  });

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
});

const advance = (ms: number) => vi.setSystemTime(new Date(Date.now() + ms));

function order(
  id: string,
  status: OrderStatus,
  extra: Partial<CreateOrderInput> = {},
): CreateOrderInput {
  return {
    id,
    tenant_id: DEMO_TENANT_ID,
    location_id: DEMO_LOCATION_DOWNTOWN_ID,
    channel: "in_store",
    currency: "USD",
    items: [
      {
        id: `${id.slice(0, 8)}-0000-4000-8000-00000000000a`,
        item_id: "30000000-0000-0000-0000-0000000000ee",
        item_name: "Special",
        size_id: null,
        size_name: "Large",
        base_price_cents: 1000,
        quantity: 1,
        modifiers: [],
        notes: null,
        voided: false,
        unit_price_cents: 1000,
        line_total_cents: 1000,
      },
      {
        id: `${id.slice(0, 8)}-0000-4000-8000-00000000000b`,
        item_id: "30000000-0000-0000-0000-0000000000ef",
        item_name: "Oops",
        size_id: null,
        size_name: null,
        base_price_cents: 500,
        quantity: 1,
        modifiers: [],
        notes: null,
        voided: true,
        unit_price_cents: 500,
        line_total_cents: 0,
      },
    ],
    discount_cents: 0,
    totals: {
      subtotal_cents: 1000,
      discount_cents: 0,
      taxable_cents: 1000,
      tax_cents: 0,
      tip_cents: 0,
      total_cents: 1000,
    },
    notes: null,
    status,
    fulfillment: { type: "pickup", scheduled_for: "asap", promised_at: T0.toISOString() },
    ...extra,
  };
}

function held(id: string, ttlSeconds = 900, reason = "awaiting_payment") {
  return order(id, "draft", {
    hold: { reason, expires_at: new Date(Date.now() + ttlSeconds * 1000).toISOString() },
  });
}

function payment(orderId: string, extra: Partial<Payment> = {}): Payment {
  return {
    id: `e9000000-0000-4000-8000-${orderId.slice(-12)}`,
    order_id: orderId,
    tenant_id: DEMO_TENANT_ID,
    location_id: DEMO_LOCATION_DOWNTOWN_ID,
    rail: "cash",
    status: "captured",
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
    ...extra,
  };
}

const ID = (n: number) => `d0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("1. orders.extendHold", () => {
  it("moves expires_at to now + ttl, bumps the version, keeps the order held", async () => {
    const d = getPosDriver();
    await d.createOrder(held(ID(1), 60));
    const before = await d.getOrder(ID(1));
    advance(30_000);
    const r = await extend(ID(1), 600);
    expect(r.status).toBe(200);
    const o = OrderSchema.parse(r.json);
    expect(o.fulfillment_status).toBe("held");
    expect(o.hold?.expires_at).toBe(new Date(Date.now() + 600_000).toISOString());
    expect(o.version).toBeGreaterThan(before!.version ?? 1);
    // bookkeeping never leaks into the contract
    expect(Object.keys(o.hold ?? {}).sort()).toEqual(["expires_at", "reason"]);
  });

  it("rejects a ttl outside 30..3600 (validation) and a missing order (404)", async () => {
    await getPosDriver().createOrder(held(ID(2)));
    expect((await extend(ID(2), 10)).status).toBe(422);
    expect((await extend(ID(2), 7200)).status).toBe(422);
    expect((await extend(ID(99), 600)).status).toBe(404);
  });

  it("needs orders:write", async () => {
    await getPosDriver().createOrder(held(ID(3)));
    const r = await call("POST", `/orders/${ID(3)}/hold/extend`, {
      body: { ttl_seconds: 600 },
      scopes: ["orders:read"],
    });
    expect(r.status).toBe(403);
  });

  it("refuses an order that is not held (released / placed / voided) with 409 not_held", async () => {
    const d = getPosDriver();
    await d.createOrder(held(ID(4)));
    await d.casOrderStatus(ID(4), ["draft"], "placed");
    await d.createOrder(order(ID(5), "placed"));
    await d.createOrder(held(ID(6)));
    await d.updateOrderStatus(ID(6), "voided");
    for (const id of [ID(4), ID(5), ID(6)]) {
      const r = await extend(id, 600);
      expect(r.status, id).toBe(409);
      expect(r.json.code).toBe("INVALID_TRANSITION");
      expect(r.json.details.reason).toBe("not_held");
    }
    // a refused extend never touches the order
    expect((await d.getOrder(ID(4)))?.hold).toBeNull();
  });

  it("refuses an expired hold (never revives it) with 409 expired", async () => {
    const d = getPosDriver();
    await d.createOrder(held(ID(7), 60));
    advance(61_000);
    const r = await extend(ID(7), 600);
    expect(r.status).toBe(409);
    expect(r.json.details.reason).toBe("expired");
    const stored = await d.getOrder(ID(7));
    expect(stored?.status).toBe("draft");
    expect(stored?.hold?.expires_at).toBe(new Date(T0.getTime() + 60_000).toISOString());
  });

  it("clamps to created_at + the cap (24 h), then refuses at_cap; scheduled holds run to 30 d", async () => {
    const d = getPosDriver();
    await d.createOrder(held(ID(8), 3600));
    await d.createOrder(held(ID(9), 3600, "scheduled"));
    const cap = T0.getTime() + 86_400_000;
    let clamped = "";
    for (let i = 0; i < 40 && !clamped; i++) {
      advance(3000_000); // 50 min: inside the previous 1 h extension
      const r = await extend(ID(8), 3600);
      expect(r.status).toBe(200);
      if (Date.parse(r.json.hold.expires_at) === cap) clamped = r.json.hold.expires_at;
      // the scheduled twin keeps going past 24 h
      expect((await extend(ID(9), 3600)).status).toBe(200);
    }
    expect(Date.parse(clamped)).toBe(cap);
    advance(60_000);
    const r = await extend(ID(8), 3600);
    expect(r.status).toBe(409);
    expect(r.json.code).toBe("CONFLICT");
    expect(r.json.details.reason).toBe("at_cap");
    expect(Date.now()).toBeGreaterThan(T0.getTime() + 23 * 3600_000);
    expect((await extend(ID(9), 3600)).status).toBe(200);
  });

  it("refuses an order already paid in full (settled)", async () => {
    const d = getPosDriver();
    await d.createOrder(held(ID(10), 60));
    await d.upsertPayment(payment(ID(10)));
    const r = await extend(ID(10), 600);
    expect(r.status).toBe(409);
    expect(r.json.details.reason).toBe("settled");
  });

  it("is idempotent per Idempotency-Key: replay extends once; same key + other ttl conflicts", async () => {
    const d = getPosDriver();
    await d.createOrder(held(ID(11), 60));
    const first = await extend(ID(11), 600, "k1");
    expect(first.status).toBe(200);
    advance(120_000);
    const replay = await extend(ID(11), 600, "k1");
    expect(replay.status).toBe(200);
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    expect(replay.json.hold.expires_at).toBe(first.json.hold.expires_at);
    expect(replay.json.version).toBe(first.json.version);
    const clash = await extend(ID(11), 900, "k1");
    expect(clash.status).toBe(409);
    expect(clash.json.code).toBe("IDEMPOTENCY_CONFLICT");
    // a new key is a new extension
    const again = await extend(ID(11), 900, "k2");
    expect(again.status).toBe(200);
    expect(Date.parse(again.json.hold.expires_at)).toBe(Date.now() + 900_000);
  });

  it("is a compare-and-set: loses cleanly to a concurrent release, cancel or extension", async () => {
    const d = getPosDriver();
    await d.createOrder(held(ID(12), 60));
    const seen = (await d.getOrder(ID(12)))!.hold!;
    const next = { ...seen, expires_at: new Date(Date.now() + 600_000).toISOString() };

    // another extension moved the expiry first
    const other = { ...seen, expires_at: new Date(Date.now() + 300_000).toISOString() };
    expect((await d.extendOrderHold(ID(12), DEMO_TENANT_ID, { expires_at: seen.expires_at }, other)).ok).toBe(true);
    const lost = await d.extendOrderHold(ID(12), DEMO_TENANT_ID, { expires_at: seen.expires_at }, next);
    expect(lost.ok).toBe(false);
    expect((await d.getOrder(ID(12)))!.hold!.expires_at).toBe(other.expires_at);

    // release (draft -> placed) wins: the stale extend writes nothing, no hold comes back
    await d.casOrderStatus(ID(12), ["draft"], "placed");
    const afterRelease = await d.extendOrderHold(ID(12), DEMO_TENANT_ID, { expires_at: other.expires_at }, next);
    expect(afterRelease).toMatchObject({ ok: false, reason: "conflict" });
    expect((await d.getOrder(ID(12)))!.hold).toBeNull();

    // cancel/expiry (draft -> voided) wins: the order stays voided
    await d.createOrder(held(ID(13), 60));
    const h13 = (await d.getOrder(ID(13)))!.hold!;
    await d.casOrderStatus(ID(13), ["draft"], "voided");
    const afterVoid = await d.extendOrderHold(ID(13), DEMO_TENANT_ID, { expires_at: h13.expires_at }, next);
    expect(afterVoid.ok).toBe(false);
    expect((await d.getOrder(ID(13)))!.status).toBe("voided");

    // another tenant's id never matches
    expect(
      await d.extendOrderHold(ID(13), "20000000-0000-4000-8000-0000000000bb", { expires_at: null }, next),
    ).toEqual({ ok: false, reason: "not_found" });
  });

  it("racing extend vs release: exactly one coherent outcome", async () => {
    const d = getPosDriver();
    await d.createOrder(held(ID(14), 60));
    const [ext, rel] = await Promise.all([
      extend(ID(14), 600),
      call("POST", `/orders/${ID(14)}/release`, { body: {}, scopes: ["orders:write", "orders:release_unpaid"] }),
    ]);
    const stored = (await d.getOrder(ID(14)))!;
    expect(rel.status).toBe(200);
    // Either the extension landed before the release (then it is released
    // without a hold) or it was refused as not held; never a held+placed order.
    expect(stored.status).toBe("placed");
    expect(stored.hold).toBeNull();
    expect([200, 409]).toContain(ext.status);
  });
});

describe("2. per-line fired_at / voided_at / status_at_void", () => {
  const line = (o: { items: OrderItem[] }, voided: boolean) =>
    o.items.find((i) => i.voided === voided)!;

  it("a live order fires its lines on creation; a line voided before sending never fires", async () => {
    const d = getPosDriver();
    const o = await d.createOrder(order(ID(20), "placed"));
    expect(line(o, false).fired_at).toBe(T0.toISOString());
    expect(line(o, true)).toMatchObject({
      fired_at: null,
      voided_at: T0.toISOString(),
      status_at_void: "placed",
    });
    const c = OrderSchema.parse(
      toContractOrder({ order: o, payments: [], timezone: "America/New_York" }),
    );
    const live = c.lines.find((l) => !l.voided)!;
    const gone = c.lines.find((l) => l.voided)!;
    expect(live.fired_at).toBe(T0.toISOString());
    expect(live.voided_at).toBeNull();
    expect(gone.fired_at).toBeNull();
    expect(gone.voided_at).toBe(T0.toISOString());
    expect(gone.status_at_void).toBe("placed");
  });

  it("a held / unpaid order fires its lines when it goes live (release, payment, status moves)", async () => {
    const d = getPosDriver();
    const h = await d.createOrder(held(ID(21)));
    expect(h.items.every((i) => i.fired_at === null)).toBe(true);
    expect(line(h, true).status_at_void).toBe("draft");
    const held2 = OrderSchema.parse(
      toContractOrder({ order: h, payments: [], timezone: "UTC" }),
    );
    expect(held2.lines.find((l) => l.voided)!.status_at_void).toBe("held");

    advance(5 * 60_000);
    const released = await d.casOrderStatus(ID(21), ["draft"], "placed");
    if (!released.ok) throw new Error("release failed");
    expect(line(released.order, false).fired_at).toBe(new Date(Date.now()).toISOString());
    expect(line(released.order, true).fired_at).toBeNull();

    // online checkout: awaiting_payment -> paid fires; later moves keep the first stamp
    await d.createOrder(order(ID(22), "awaiting_payment", { channel: "online_pickup" }));
    expect(
      (await d.getOrder(ID(22)))!.items.every((i) => i.fired_at === null),
    ).toBe(true);
    advance(60_000);
    const paid = (await d.transitionOrderStatus(ID(22), ["awaiting_payment"], "paid"))!;
    const firedAt = line(paid, false).fired_at;
    expect(firedAt).toBe(new Date(Date.now()).toISOString());
    advance(60_000);
    const kitchen = (await d.updateOrderStatus(ID(22), "in_kitchen"))!;
    expect(line(kitchen, false).fired_at).toBe(firedAt);
  });

  it("is exposed on GET /v1/orders/{id}", async () => {
    await getPosDriver().createOrder(order(ID(23), "placed"));
    const r = await call("GET", `/orders/${ID(23)}`);
    const o = OrderSchema.parse(r.json);
    expect(o.lines.find((l) => !l.voided)!.fired_at).toBe(T0.toISOString());
    expect(o.lines.find((l) => l.voided)!.voided_at).toBe(T0.toISOString());
  });
});

describe("3. Payment.refunds[] + payment.refunded refund", () => {
  it("every refund gets a stable unique id; amounts sum to refunded_cents", async () => {
    const d = getPosDriver();
    await d.createOrder(order(ID(30), "placed"));
    const p = await d.upsertPayment(payment(ID(30)));
    await refundPayment({ paymentId: p.id, amountCents: 300, refundId: "a", reason: "cold" });
    advance(1000);
    await refundPayment({ paymentId: p.id, amountCents: 200, refundId: "b" });
    const stored = (await d.getPayment(p.id))!;
    const c = PaymentSchema.parse(toContractPayment(stored));
    expect(c.refunds).toHaveLength(2);
    expect(c.refunds!.map((r) => r.amount_cents)).toEqual([300, 200]);
    expect(c.refunds![0]!.reason).toBe("cold");
    expect(new Set(c.refunds!.map((r) => r.id)).size).toBe(2);
    expect(c.refunds!.reduce((n, r) => n + r.amount_cents, 0)).toBe(c.refunded_cents);
    // stable across reads
    expect(toContractPayment((await d.getPayment(p.id))!).refunds!.map((r) => r.id)).toEqual(
      c.refunds!.map((r) => r.id),
    );
    // a replayed refund id is a no-op: no third entry
    await refundPayment({ paymentId: p.id, amountCents: 200, refundId: "b" });
    expect(toContractPayment((await d.getPayment(p.id))!).refunds).toHaveLength(2);
  });

  it("a released (failed) reservation drops its entry; the provider ref is recorded", async () => {
    const d = getPosDriver();
    await d.createOrder(order(ID(31), "placed"));
    const p = await d.upsertPayment(payment(ID(31)));
    const ok = await d.reservePaymentRefund(p.id, 400, "r1", { processorRef: "re_123", reason: "x" });
    expect(ok.ok && ok.refundEntryId).toBeTruthy();
    await d.reservePaymentRefund(p.id, 100, "r2");
    await d.releasePaymentRefund(p.id, 100, "r2");
    const refunds = toContractPayment((await d.getPayment(p.id))!).refunds!;
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({ amount_cents: 400, processor_ref: "re_123", reason: "x" });
  });

  it("money refunded before per-refund records existed gets one deterministic legacy entry", async () => {
    const d = getPosDriver();
    await d.createOrder(order(ID(32), "placed"));
    const p = await d.upsertPayment(payment(ID(32), { refunded_cents: 250, status: "captured" }));
    const refunds = toContractPayment(p).refunds!;
    expect(refunds).toEqual([
      expect.objectContaining({ id: `${p.id}:legacy`, amount_cents: 250 }),
    ]);
  });

  it("payment.refunded carries the refund the event is about, even after a later refund", async () => {
    const d = getPosDriver();
    await d.createOrder(order(ID(33), "placed"));
    const p = await d.upsertPayment(payment(ID(33)));
    await d.reservePaymentRefund(p.id, 300, "a");
    await d.reservePaymentRefund(p.id, 200, "b");
    const rows = memoryOutbox.rows.filter(
      (r) => r.subject_id === p.id && r.event_type === "payment.refunded",
    );
    expect(rows).toHaveLength(2);
    const events = await Promise.all(rows.map((r) => hydrateEvent(r, d)));
    const refunds = (await d.getPayment(p.id))!.refunds!;
    const data = events.map(
      (e) => e!.data as { refund: { id: string; amount_cents: number }; refunds: { id: string }[] },
    );
    expect(data[0]!.refund).toMatchObject({ id: refunds[0]!.id, amount_cents: 300 });
    expect(data[1]!.refund).toMatchObject({ id: refunds[1]!.id, amount_cents: 200 });
    expect(data[0]!.refunds).toHaveLength(2);
  });
});

describe("4. food-only amount_due_cents", () => {
  const withTip = (id: string, tip: number) =>
    order(id, "placed", {
      totals: {
        subtotal_cents: 1000,
        discount_cents: 0,
        taxable_cents: 1000,
        tax_cents: 0,
        tip_cents: tip,
        total_cents: 1000 + tip,
      },
    });

  it("(total - tip) - sum(captured amount_cents) on orders", async () => {
    const d = getPosDriver();
    const o = await d.createOrder(withTip(ID(40), 200));
    expect(derivePaymentStatus(o, []).amount_due_cents).toBe(1000);
    const part = payment(ID(40), { amount_cents: 400 });
    expect(derivePaymentStatus(o, [part]).amount_due_cents).toBe(600);
    expect(derivePaymentStatus(o, [part]).payment_status).toBe("partially_paid");
    const full = payment(ID(40), { amount_cents: 1000 });
    const paid = derivePaymentStatus(o, [full]);
    expect(paid.amount_due_cents).toBe(0);
    expect(paid.payment_status).toBe("paid");
    // pending / failed tenders do not count
    expect(
      derivePaymentStatus(o, [payment(ID(40), { status: "pending" })]).amount_due_cents,
    ).toBe(1000);
    const body = OrderSchema.parse(
      toContractOrder({ order: o, payments: [part], timezone: "UTC" }),
    );
    expect(body.amount_due_cents).toBe(600);
  });
});
