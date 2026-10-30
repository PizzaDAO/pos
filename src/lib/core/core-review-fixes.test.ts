/**
 * Outbox + driver + /v1 behaviour from the core-v1 review round (mock driver;
 * the SQL triggers are covered by supabase/tests/rls_isolation.sql):
 *  1. a late-payment Accept (abandoned -> paid) announces order.placed
 *  2. no payment events for an order the hub never saw (order.placed carries them)
 *  3. draft -> refunded emits nothing
 *  4. a held order paid through transitionOrderStatus depletes and drops `hold`
 *  5. /v1 sales skip unpaid / abandoned checkouts
 *  6. a released (failed) refund retracts its payment.refunded, no payment.captured
 *  7. order.updated ignores checkout bookkeeping and never-announced orders
 *  8. /v1 cancel closes open card intents and the delivery like main's cancel
 *  9. /v1 release counts settled BASE money (tips excluded) against the due
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { Principal } from "@openpizza/core";
import {
  getPosDriver,
  DEMO_LOCATION_DOWNTOWN_ID,
  DEMO_TENANT_ID,
  type CreateOrderInput,
  type OrderStatus,
  type Payment,
} from "@/lib/db";
import {
  resetMockOnline,
  resetMockOrders,
  resetMockPayments,
} from "@/lib/db/mock";
import { DEV_TOKEN } from "./auth";
import { handleV1 } from "./v1";
import { hydrateEvent, memoryOutbox } from "./outbox";
import { isSalesRow } from "./sales";
import { toContractOrder } from "./mappers";

const NOW = new Date("2026-06-04T22:00:00.000Z");

beforeEach(() => {
  resetMockOrders();
  resetMockPayments();
  resetMockOnline();
  memoryOutbox.clear();
});

function order(id: string, status: OrderStatus, extra: Partial<CreateOrderInput> = {}): CreateOrderInput {
  return {
    id,
    tenant_id: DEMO_TENANT_ID,
    location_id: DEMO_LOCATION_DOWNTOWN_ID,
    channel: "online_pickup",
    currency: "USD",
    items: [
      {
        id: `${id.slice(0, 8)}-line`,
        item_id: "30000000-0000-0000-0000-0000000000ee",
        item_name: "Review Special",
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
    fulfillment: { type: "pickup", scheduled_for: "asap", promised_at: NOW.toISOString() },
    ...extra,
  };
}

function payment(orderId: string, status: Payment["status"], extra: Partial<Payment> = {}): Payment {
  return {
    id: `e9000000-0000-4000-8000-${orderId.slice(-12)}`,
    order_id: orderId,
    tenant_id: DEMO_TENANT_ID,
    location_id: DEMO_LOCATION_DOWNTOWN_ID,
    rail: "cash",
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
    simulated: true,
    raw: null,
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
    ...extra,
  };
}

const rowsFor = (subjectId: string) =>
  memoryOutbox.rows.filter((r) => r.subject_id === subjectId);
const typesFor = (subjectId: string) => rowsFor(subjectId).map((r) => r.event_type);

describe("1. late-payment accept", () => {
  it("abandoned -> paid is announced as order.placed, not status_changed", async () => {
    const d = getPosDriver();
    const id = "c1000000-0000-4000-8000-000000000001";
    await d.createOrder(order(id, "awaiting_payment"));
    await d.transitionOrderStatus(id, ["awaiting_payment"], "abandoned");
    expect(typesFor(id)).toEqual([]);
    await d.transitionOrderStatus(id, ["abandoned"], "paid");
    expect(typesFor(id)).toEqual(["order.placed"]);
    expect(rowsFor(id)[0]!.changes).toEqual({ status: ["abandoned", "paid"] });
    // Announced now: later moves are ordinary status changes.
    await d.transitionOrderStatus(id, ["paid"], "in_kitchen");
    expect(typesFor(id)).toEqual(["order.placed", "order.status_changed"]);
  });
});

describe("2. payment events only for announced orders", () => {
  it("a checkout's payment is silent; the order.placed that follows carries it", async () => {
    const d = getPosDriver();
    const id = "c2000000-0000-4000-8000-000000000001";
    await d.createOrder(order(id, "awaiting_payment"));
    const p = await d.upsertPayment(payment(id, "captured"));
    expect(typesFor(p.id)).toEqual([]);
    await d.transitionOrderStatus(id, ["awaiting_payment"], "paid");
    const placed = rowsFor(id).find((r) => r.event_type === "order.placed")!;
    const ev = (await hydrateEvent(placed, d))!;
    const data = ev.data as { tenders: { payment_id: string; status: string }[] };
    expect(data.tenders.map((t) => t.payment_id)).toEqual([p.id]);
    expect(data.tenders[0]!.status).toBe("captured");
  });

  it("nothing for a held draft, an abandoned checkout or a never-announced void", async () => {
    const d = getPosDriver();
    const held = "c2000000-0000-4000-8000-000000000002";
    const gone = "c2000000-0000-4000-8000-000000000003";
    const voided = "c2000000-0000-4000-8000-000000000004";
    await d.createOrder(order(held, "draft", { channel: "in_store" }));
    await d.createOrder(order(gone, "awaiting_payment"));
    await d.transitionOrderStatus(gone, ["awaiting_payment"], "abandoned");
    await d.createOrder(order(voided, "draft", { channel: "in_store" }));
    await d.updateOrderStatus(voided, "voided");
    for (const id of [held, gone, voided]) {
      const p = await d.upsertPayment(payment(id, "authorized"));
      await d.upsertPayment({ ...p, status: "captured" });
      expect(typesFor(p.id), id).toEqual([]);
    }
  });

  it("an announced order's payments still emit", async () => {
    const d = getPosDriver();
    const id = "c2000000-0000-4000-8000-000000000005";
    await d.createOrder(order(id, "placed", { channel: "in_store" }));
    const p = await d.upsertPayment(payment(id, "captured"));
    expect(typesFor(p.id)).toEqual(["payment.captured"]);
    // ...also after the order is voided (it was announced before).
    await d.updateOrderStatus(id, "voided");
    await d.reservePaymentRefund(p.id, 1000, "r1");
    expect(typesFor(p.id)).toEqual(["payment.captured", "payment.refunded"]);
  });
});

describe("3. draft -> refunded", () => {
  it("a hold that ends refunded was never announced: nothing", async () => {
    const d = getPosDriver();
    const id = "c3000000-0000-4000-8000-000000000001";
    await d.createOrder(order(id, "draft", { channel: "in_store" }));
    await d.transitionOrderStatus(id, ["draft"], "refunded");
    expect(typesFor(id)).toEqual([]);
  });
});

describe("4. a held order paid via transitionOrderStatus", () => {
  it("depletes once, clears the hold, and /v1 release stays idempotent", async () => {
    const d = getPosDriver();
    const cart = await callV1("GET", `/locations/${DEMO_LOCATION_DOWNTOWN_ID}/menu`);
    const item = cart.json.categories
      .flatMap((c: { items: unknown[] }) => c.items)
      .find((i: { name: string }) => i.name === "Pepperoni");
    const large = item.sizes.find((s: { name: string }) => s.name.startsWith("Large"));
    const id = "c4000000-0000-4000-8000-000000000001";
    const created = await callV1("POST", "/orders", {
      body: {
        id,
        location_id: DEMO_LOCATION_DOWNTOWN_ID,
        lines: [{ item_id: item.id, size_id: large.id, quantity: 1 }],
        channel: "agent",
        source: { type: "agent_api" },
      },
    });
    expect(created.json.fulfillment_status).toBe("held");
    const depletions = async () =>
      (await d.listInventoryMovements(DEMO_TENANT_ID, DEMO_LOCATION_DOWNTOWN_ID)).filter(
        (m) => m.order_id === id && m.reason === "depletion",
      );
    expect(await depletions()).toHaveLength(0);

    // Main's settlement path (maybeMarkOrderPaid).
    const paid = await d.transitionOrderStatus(id, ["draft", "placed"], "paid");
    expect(paid?.status).toBe("paid");
    expect(paid?.hold).toBeNull();
    const moves = await depletions();
    expect(moves.length).toBeGreaterThan(0);
    expect(new Set(moves.map((m) => m.inventory_item_id)).size).toBe(moves.length);

    const released = await callV1("POST", `/orders/${id}/release`, { body: {} });
    expect(released.status).toBe(200);
    expect(released.json.hold).toBeNull();
    expect(await depletions()).toHaveLength(moves.length);
    expect(typesFor(id).filter((t) => t === "order.placed")).toHaveLength(1);
  });

  it("a placed -> paid move depletes nothing extra and a draft -> voided nothing at all", async () => {
    const d = getPosDriver();
    const id = "c4000000-0000-4000-8000-000000000002";
    await d.createOrder(order(id, "draft", { channel: "in_store", hold: { reason: "manual", expires_at: null } }));
    const voided = await d.transitionOrderStatus(id, ["draft"], "voided");
    expect(voided?.hold).toBeNull();
    const moves = (await d.listInventoryMovements(DEMO_TENANT_ID, DEMO_LOCATION_DOWNTOWN_ID)).filter(
      (m) => m.order_id === id,
    );
    expect(moves).toHaveLength(0);
  });
});

describe("5. sales skip unpaid checkouts", () => {
  it("isSalesRow drops awaiting_payment and abandoned rows", () => {
    expect(isSalesRow({ status: "awaiting_payment" })).toBe(false);
    expect(isSalesRow({ status: "abandoned" })).toBe(false);
    expect(isSalesRow({ status: "voided" })).toBe(true);
    expect(isSalesRow({ status: "completed" })).toBe(true);
  });

  it("an abandoned checkout is neither an order nor a void in /v1 sales", async () => {
    const d = getPosDriver();
    const live = "c5000000-0000-4000-8000-000000000001";
    await d.createOrder(order(live, "completed", { channel: "in_store" }));
    const day = (await callV1("GET", `/orders/${live}`)).json.business_date as string;
    const summary = async () =>
      (await callV1("GET", `/sales/summary?from=${day}&to=${day}&group_by=day`)).json.totals;
    const before = await summary();
    expect(before.order_count).toBeGreaterThanOrEqual(1);
    const a = "c5000000-0000-4000-8000-000000000002";
    const w = "c5000000-0000-4000-8000-000000000003";
    await d.createOrder(order(a, "awaiting_payment"));
    await d.transitionOrderStatus(a, ["awaiting_payment"], "abandoned");
    await d.createOrder(order(w, "awaiting_payment"));
    const after = await summary();
    expect(after.order_count).toBe(before.order_count);
    expect(after.void_count).toBe(before.void_count);
    expect(after.gross_cents).toBe(before.gross_cents);
  });

  it("an abandoned checkout maps a canceled_at", async () => {
    const o = toContractOrder({
      order: {
        ...order("c5000000-0000-4000-8000-000000000004", "abandoned"),
        order_number: "A-1",
        created_at: "2026-06-04T20:00:00.000Z",
        updated_at: "2026-06-04T20:15:00.000Z",
        items: [],
      } as never,
      payments: [],
      timezone: "UTC",
    });
    expect(o.fulfillment_status).toBe("canceled");
    expect(o.canceled_at).toBe("2026-06-04T20:15:00.000Z");
  });
});

describe("6. a released refund reservation", () => {
  it("retracts its unclaimed payment.refunded and emits no payment.captured", async () => {
    const d = getPosDriver();
    const id = "c6000000-0000-4000-8000-000000000001";
    await d.createOrder(order(id, "placed", { channel: "in_store" }));
    const p = await d.upsertPayment(payment(id, "captured"));
    const res = await d.reservePaymentRefund(p.id, 1000, "rf-1");
    expect(res.ok).toBe(true);
    const refunded = rowsFor(p.id).find((r) => r.event_type === "payment.refunded")!;
    expect(refunded.status).toBe("pending");
    await d.releasePaymentRefund(p.id, 1000, "rf-1");
    expect((await d.getPayment(p.id))?.status).toBe("captured");
    expect(typesFor(p.id)).toEqual(["payment.captured", "payment.refunded"]);
    expect(refunded.status).toBe("dead");
    expect(refunded.last_error).toBe("retracted: refund released");
    expect(memoryOutbox.pending().filter((r) => r.subject_id === p.id).map((r) => r.event_type)).toEqual([
      "payment.captured",
    ]);
  });

  it("emits a correction when the refund event was already claimed", async () => {
    const d = getPosDriver();
    const id = "c6000000-0000-4000-8000-000000000002";
    await d.createOrder(order(id, "placed", { channel: "in_store" }));
    const p = await d.upsertPayment(payment(id, "captured"));
    await d.reservePaymentRefund(p.id, 400, "rf-2");
    await memoryOutbox.claim(100, new Date());
    await d.releasePaymentRefund(p.id, 400, "rf-2");
    const last = rowsFor(p.id).at(-1)!;
    expect(last.event_type).toBe("payment.captured");
    expect(last.changes).toEqual({ refunded_cents: [400, 0] });
  });

  it("overlapping reservations: a release retracts ITS row, not the newest", async () => {
    const d = getPosDriver();
    const id = "c6000000-0000-4000-8000-000000000003";
    await d.createOrder(order(id, "placed", { channel: "in_store" }));
    const p = await d.upsertPayment(payment(id, "captured"));
    await d.reservePaymentRefund(p.id, 300, "rf-a");
    await d.reservePaymentRefund(p.id, 400, "rf-b");
    const [a, b] = rowsFor(p.id).filter((r) => r.event_type === "payment.refunded");
    expect(a!.changes).toEqual({ refunded_cents: [0, 300] });
    expect(b!.changes).toEqual({ refunded_cents: [300, 700] });
    await d.releasePaymentRefund(p.id, 300, "rf-a");
    expect(a!.status).toBe("dead");
    expect(b!.status).toBe("pending");
    expect(typesFor(p.id)).toEqual(["payment.captured", "payment.refunded", "payment.refunded"]);
  });

  it("overlapping reservations: a claimed row gets a correction; the other pending row survives", async () => {
    const d = getPosDriver();
    const id = "c6000000-0000-4000-8000-000000000004";
    await d.createOrder(order(id, "placed", { channel: "in_store" }));
    const p = await d.upsertPayment(payment(id, "captured"));
    await d.reservePaymentRefund(p.id, 300, "rf-a");
    await d.reservePaymentRefund(p.id, 400, "rf-b");
    const [a, b] = rowsFor(p.id).filter((r) => r.event_type === "payment.refunded");
    b!.attempts = 1; // a worker already claimed rf-b's row
    await d.releasePaymentRefund(p.id, 400, "rf-b");
    expect(a!.status).toBe("pending"); // unrelated: never killed
    const last = rowsFor(p.id).at(-1)!;
    expect(last.event_type).toBe("payment.captured");
    expect(last.changes).toEqual({ refunded_cents: [700, 300] });
  });
});

describe("7. order.updated", () => {
  it("ignores checkout bookkeeping, emits for real fulfillment changes", async () => {
    const d = getPosDriver();
    const id = "c7000000-0000-4000-8000-000000000001";
    await d.createOrder(order(id, "awaiting_payment"));
    await d.transitionOrderStatus(id, ["awaiting_payment"], "paid");
    expect(typesFor(id)).toEqual(["order.placed"]);
    await d.mergeOrderFulfillment(id, { finalized_at: NOW.toISOString() });
    await d.mergeOrderFulfillment(id, { recovery_attempts: 1, recovery_next_at: NOW.toISOString() });
    await d.mergeOrderFulfillment(id, {
      late_payment: { kind: "duplicate", payment_id: "x", amount_cents: 1, flagged_at: NOW.toISOString() },
    });
    expect(typesFor(id)).toEqual(["order.placed"]);
    await d.mergeOrderFulfillment(id, { eta_minutes: 25 });
    expect(typesFor(id)).toEqual(["order.placed", "order.updated"]);
  });

  it("never for an abandoned or never-announced voided order", async () => {
    const d = getPosDriver();
    const gone = "c7000000-0000-4000-8000-000000000002";
    await d.createOrder(order(gone, "awaiting_payment"));
    await d.transitionOrderStatus(gone, ["awaiting_payment"], "abandoned");
    await d.mergeOrderFulfillment(gone, {
      late_payment: { kind: "late", payment_id: "x", amount_cents: 1, flagged_at: NOW.toISOString() },
    });
    await d.mergeOrderFulfillment(gone, { eta_minutes: 9 });
    const v = "c7000000-0000-4000-8000-000000000003";
    await d.createOrder(order(v, "draft"));
    await d.transitionOrderStatus(v, ["draft"], "voided");
    await d.mergeOrderFulfillment(v, { eta_minutes: 9 });
    expect(typesFor(gone)).toEqual([]);
    expect(typesFor(v)).toEqual([]);
  });
});

describe("8. /v1 cancel mirrors main's storefront cancel", () => {
  it("closes an open card intent, voids, and cancels the delivery", async () => {
    const d = getPosDriver();
    const id = "c8000000-0000-4000-8000-000000000001";
    await d.createOrder(order(id, "draft"));
    const intent = await d.upsertPayment(
      payment(id, "requires_action", { rail: "stripe_online", charge_id: "sim_pi_1" }),
    );
    const delivery = await d.upsertDelivery({
      id: "c8000000-0000-4000-8000-0000000000dd",
      order_id: id,
      tenant_id: DEMO_TENANT_ID,
      location_id: DEMO_LOCATION_DOWNTOWN_ID,
      provider: "in_house_manual",
      status: "pending_assignment",
      zone_id: null,
      fee_cents: 0,
      currency: "USD",
      eta_minutes: null,
      provider_delivery_id: null,
      tracking_ref: null,
      dropoff: { line1: "1 Main", city: "X", region: "NY", postal_code: "10001", country: "US" },
      driver_name: null,
      driver_phone: null,
      simulated: true,
      created_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
    });
    const r = await callV1("POST", `/orders/${id}/cancel`, { body: { reason: "customer" } });
    expect(r.status).toBe(200);
    expect(r.json.fulfillment_status).toBe("canceled");
    expect((await d.getPayment(intent.id))?.status).toBe("canceled");
    expect((await d.getDelivery(delivery.id))?.status).toBe("canceled");
  });

  it("an awaiting_payment checkout cannot be canceled through /v1", async () => {
    const d = getPosDriver();
    const id = "c8000000-0000-4000-8000-000000000002";
    await d.createOrder(order(id, "awaiting_payment"));
    const r = await callV1("POST", `/orders/${id}/cancel`, { body: { reason: "x" } });
    expect(r.status).toBe(409);
    expect(r.json.code).toBe("CANCEL_NOT_ALLOWED");
  });
});

describe("9. /v1 release counts base money, not tips", () => {
  const agent: Principal = {
    kind: "service",
    id: "t",
    tenant_id: DEMO_TENANT_ID,
    location_ids: null,
    scopes: ["orders:read", "orders:write"],
    module: "guests",
  };
  const held = (id: string) =>
    order(id, "draft", { channel: "in_store", hold: { reason: "manual", expires_at: null } });

  it("an 800 tender + 200 tip does not pay a 1000 order", async () => {
    const d = getPosDriver();
    const id = "c9000000-0000-4000-8000-000000000001";
    await d.createOrder(held(id));
    await d.upsertPayment(payment(id, "captured", { amount_cents: 800, tip_cents: 200 }));
    const r = await callV1("POST", `/orders/${id}/release`, { body: {}, p: agent });
    expect(r.status).toBe(402);
    expect(r.json.code).toBe("PAYMENT_REQUIRED");
    expect(r.json.details.amount_due_cents).toBe(200);
    expect((await d.getOrder(id))?.status).toBe("draft");
  });

  it("a refund of the tip leaves the base paid; a refund beyond it does not", async () => {
    const d = getPosDriver();
    const tipOnly = "c9000000-0000-4000-8000-000000000002";
    await d.createOrder(held(tipOnly));
    await d.upsertPayment(
      payment(tipOnly, "captured", { amount_cents: 1000, tip_cents: 200, refunded_cents: 200 }),
    );
    const ok = await callV1("POST", `/orders/${tipOnly}/release`, { body: {}, p: agent });
    expect(ok.status).toBe(200);
    expect(ok.json.fulfillment_status).toBe("placed");

    const intoBase = "c9000000-0000-4000-8000-000000000003";
    await d.createOrder(held(intoBase));
    await d.upsertPayment(
      payment(intoBase, "captured", { amount_cents: 1000, tip_cents: 200, refunded_cents: 300 }),
    );
    const refused = await callV1("POST", `/orders/${intoBase}/release`, { body: {}, p: agent });
    expect(refused.status).toBe(402);
    expect(refused.json.details.amount_due_cents).toBe(100);
  });

  it("a tender in another currency never pays the order", async () => {
    const d = getPosDriver();
    const id = "c9000000-0000-4000-8000-000000000004";
    await d.createOrder(held(id));
    await d.upsertPayment(payment(id, "captured", { currency: "EUR" }));
    const r = await callV1("POST", `/orders/${id}/release`, { body: {}, p: agent });
    expect(r.status).toBe(402);
  });
});

async function callV1(
  method: string,
  path: string,
  opts: { body?: unknown; p?: Principal } = {},
) {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (!opts.p) headers.authorization = `Bearer ${DEV_TOKEN}`;
  const res = await handleV1(
    new Request(`https://pos.test/api/v1${path}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    }),
    path.split("?")[0]!.split("/").filter(Boolean),
    { now: () => NOW, principal: opts.p },
  );
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}
