/**
 * Refunds, voids, comps and discounts end to end through the till endpoints
 * (`/api/orders/[id]/refund|void|discount`) on the mock driver: balance math,
 * per-tender caps, races between tills, idempotent retries, tip refunds kept
 * apart, approvals, the drawer, the kitchen screen, reports and the hub mapping.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import type { MembershipRole, Order, OrderItem, Payment, Staff } from "@/lib/db";
import {
  DEMO_LOCATION_DOWNTOWN_ID as LOCATION,
  DEMO_TENANT_ID as TENANT,
  getPosDriver,
} from "@/lib/db";
import { resetMockOrders, resetMockPayments } from "@/lib/db/mock";

const stripeRequest = vi.fn();
const stripeGet = vi.fn();
vi.mock("@/lib/payments/providers/stripe-client", async (orig) => ({
  ...(await orig<typeof import("@/lib/payments/providers/stripe-client")>()),
  stripeRequest: (...a: unknown[]) => stripeRequest(...a),
  stripeGet: (...a: unknown[]) => stripeGet(...a),
}));

const requireTenantRole = vi.fn();
vi.mock("@/lib/auth/api", () => ({
  requireTenantMember: (...a: unknown[]) => requireTenantRole(...a),
  requireTenantRole: (...a: unknown[]) => requireTenantRole(...a),
}));

/** Who is at the till (the active PIN-switched staff member). */
const till = vi.hoisted(() => ({
  role: "cashier" as MembershipRole | null,
  staff: null as Staff | null,
}));
vi.mock("@/lib/auth/active-staff", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth/active-staff")>()),
  effectiveTerminalRole: async () => ({ role: till.role, staff: till.staff }),
}));

import { POST as refundPOST } from "@/app/api/orders/[id]/refund/route";
import { POST as voidPOST } from "@/app/api/orders/[id]/void/route";
import { POST as discountPOST } from "@/app/api/orders/[id]/discount/route";
import { GET as kitchenGET } from "@/app/api/kitchen/orders/route";
import { POST as webhookPOST } from "@/app/api/payments/stripe/webhook/route";
import { refundPayment, getOrderBalance } from "@/lib/payments/service";
import { selectOpenOrders, selectRecentOrders } from "@/lib/payments/open-orders";
import { buildReceipt } from "@/lib/payments/receipt";
import { buildSalesReport } from "@/lib/reports";
import { toContractOrder } from "@/lib/core/mappers";
import { OrderSchema } from "@openpizza/core";
import { tipFactsForOrder } from "@/lib/core/tips";
import { unitShares } from "./math";

const CARMELA = "80000000-0000-0000-0000-000000000002"; // manager, PIN 2222
const CHRIS = "80000000-0000-0000-0000-000000000003"; // cashier, PIN 3333
const ACCT = "acct_real_adj";

let seq = 0;
let ip = 0;
const nextIp = () => `10.9.${Math.floor(++ip / 250)}.${ip % 250}`;
const rid = (tag: string) => `${tag}-${++seq}-${Math.random().toString(36).slice(2, 10)}`;

function item(id: string, unit: number, qty: number, over: Partial<OrderItem> = {}): OrderItem {
  return {
    id,
    item_id: `30000000-0000-0000-0000-00000000000${(seq % 9) + 1}`,
    item_name: `Pizza ${id.slice(0, 4)}`,
    size_id: null,
    size_name: null,
    base_price_cents: unit,
    quantity: qty,
    modifiers: [],
    notes: null,
    voided: false,
    unit_price_cents: unit,
    line_total_cents: unit * qty,
    ...over,
  };
}

async function seedOrder(
  items: OrderItem[],
  opts: { status?: Order["status"]; tax?: number } = {},
): Promise<Order> {
  seq += 1;
  const subtotal = items.reduce((n, i) => n + i.unit_price_cents * i.quantity, 0);
  const tax = opts.tax ?? 0;
  return getPosDriver().createOrder({
    id: globalThis.crypto.randomUUID(),
    tenant_id: TENANT,
    location_id: LOCATION,
    channel: "in_store",
    currency: "USD",
    items,
    discount_cents: 0,
    totals: {
      subtotal_cents: subtotal,
      discount_cents: 0,
      taxable_cents: subtotal,
      tax_cents: tax,
      tip_cents: 0,
      total_cents: subtotal + tax,
    },
    notes: null,
    status: opts.status ?? "placed",
  });
}

async function seedTender(order: Order, over: Partial<Payment> = {}): Promise<Payment> {
  seq += 1;
  const at = new Date(Date.now() - 60_000 + seq).toISOString();
  return getPosDriver().upsertPayment({
    id: globalThis.crypto.randomUUID(),
    order_id: order.id,
    tenant_id: TENANT,
    location_id: LOCATION,
    rail: "cash",
    status: "captured",
    amount_cents: order.totals.total_cents,
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
    created_at: at,
    updated_at: at,
    ...over,
  });
}

function post(
  handler: (r: Request, c: { params: Promise<{ id: string }> }) => Promise<Response>,
  orderId: string,
  body: Record<string, unknown>,
) {
  return handler(
    new Request(`http://localhost/api/orders/${orderId}/x`, {
      method: "POST",
      headers: { "x-forwarded-for": nextIp(), "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: orderId }) },
  );
}
const refund = (orderId: string, body: Record<string, unknown>) =>
  post(refundPOST, orderId, { reasonCode: "quality", requestId: rid("rf"), ...body });
const voidReq = (orderId: string, body: Record<string, unknown>) =>
  post(voidPOST, orderId, { reasonCode: "entry_error", requestId: rid("vd"), ...body });
const discount = (orderId: string, body: Record<string, unknown>) =>
  post(discountPOST, orderId, { reasonCode: "promotion", requestId: rid("dc"), ...body });

async function asManager() {
  till.role = "manager";
  till.staff = await getPosDriver().getStaffById(TENANT, CARMELA);
}
async function asCashier() {
  till.role = "cashier";
  till.staff = await getPosDriver().getStaffById(TENANT, CHRIS);
}
async function policy(p: { refund?: number; comp?: number; void?: number }) {
  await getPosDriver().setAdjustmentPolicy(TENANT, LOCATION, {
    refund_approval_cents: p.refund ?? 0,
    comp_approval_cents: p.comp ?? 0,
    void_approval_cents: p.void ?? 0,
  });
}
const sum = (ps: Payment[]) => ps.reduce((n, p) => n + p.refunded_cents, 0);

beforeEach(async () => {
  resetMockOrders();
  resetMockPayments();
  stripeRequest.mockReset();
  stripeGet.mockReset();
  requireTenantRole.mockReset();
  requireTenantRole.mockResolvedValue({
    ok: true,
    user: {
      id: "device-1",
      email: "till@example.com",
      memberships: [{ tenant_id: TENANT, role: "owner" }],
    },
  });
  vi.unstubAllEnvs();
  vi.stubEnv("STRIPE_SECRET_KEY", "");
  getPosDriver();
  await asManager();
  await policy({});
  await getPosDriver().clearPinAttempts(TENANT, CARMELA);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// Balance math (the double-charge regression)
// ---------------------------------------------------------------------------

describe("balance never re-opens after a refund", () => {
  it("one of two tenders fully refunded: no balance due, not an open order, receipt not 'Balance due'", async () => {
    const order = await seedOrder([item("l-a1", 1000, 2)], { status: "paid" });
    const cash = await seedTender(order, { amount_cents: 1000 });
    await seedTender(order, { amount_cents: 1000, rail: "stripe_terminal", charge_id: "sim_pi_1" });
    await refundPayment({ paymentId: cash.id, refundId: "full-cash-1" });
    const payments = await getPosDriver().listPaymentsForOrder(order.id);
    expect(payments.find((p) => p.id === cash.id)?.status).toBe("refunded");
    const fresh = (await getPosDriver().getOrder(order.id))!;
    expect(await getOrderBalance(fresh)).toBe(0);
    expect(selectOpenOrders([fresh], new Map([[order.id, payments]]))).toEqual([]);
    const r = buildReceipt(fresh, payments);
    expect(r.balanceCents).toBe(0);
    expect(r.refundedCents).toBe(1000);
    expect(r.netPaidCents).toBe(1000);
  });

  it("a refunded order with an earlier DECLINED card is marked refunded and owes nothing", async () => {
    const order = await seedOrder([item("l-b1", 1500, 1)], { status: "paid" });
    await seedTender(order, { rail: "stripe_terminal", status: "failed", charge_id: "sim_pi_x" });
    await seedTender(order, { amount_cents: 1500 });
    const res = await refund(order.id, { amountCents: 1500 });
    expect(res.status).toBe(200);
    const fresh = (await getPosDriver().getOrder(order.id))!;
    expect(fresh.status).toBe("refunded");
    const payments = await getPosDriver().listPaymentsForOrder(order.id);
    expect(await getOrderBalance(fresh)).toBe(0);
    expect(buildReceipt(fresh, payments)).toMatchObject({ fullyRefunded: true, balanceCents: 0 });
    expect(selectRecentOrders([fresh], new Map([[order.id, payments]]))[0]!.money).toBe("refunded");
  });

  it("a partial refund leaves the order paid (and listed as partially refunded)", async () => {
    const order = await seedOrder([item("l-c1", 1000, 3)], { status: "paid" });
    await seedTender(order);
    expect((await refund(order.id, { amountCents: 700 })).status).toBe(200);
    const fresh = (await getPosDriver().getOrder(order.id))!;
    const payments = await getPosDriver().listPaymentsForOrder(order.id);
    expect(fresh.status).toBe("paid");
    expect(await getOrderBalance(fresh)).toBe(0);
    expect(selectRecentOrders([fresh], new Map([[order.id, payments]]))[0]).toMatchObject({
      money: "partially_refunded",
      refundedCents: 700,
    });
  });
});

// ---------------------------------------------------------------------------
// Partial refunds
// ---------------------------------------------------------------------------

describe("partial refunds", () => {
  it("by amount across tenders: card first, then cash, recorded on the drawer", async () => {
    const order = await seedOrder([item("l-d1", 1000, 3)], { status: "paid" });
    const card = await seedTender(order, { amount_cents: 1200, rail: "stripe_terminal", charge_id: "sim_pi_2" });
    const cash = await seedTender(order, { amount_cents: 1800 });
    const shift = await getPosDriver().openShift({
      tenantId: TENANT,
      locationId: LOCATION,
      staffId: CARMELA,
      openingFloatCents: 10_000,
    });
    const res = await refund(order.id, { amountCents: 2000 });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.record.status).toBe("completed");
    const alloc = Object.fromEntries(
      body.record.allocations.map((a: { payment_id: string; base_cents: number }) => [a.payment_id, a.base_cents]),
    );
    expect(alloc[card.id]).toBe(1200);
    expect(alloc[cash.id]).toBe(800);
    const events = await getPosDriver().listShiftCashEvents(shift.id);
    expect(events).toMatchObject([{ type: "payout", amount_cents: -800, order_id: order.id }]);
    const recon = await getPosDriver().getDrawerReconciliation(shift.id);
    expect(recon.expected_cents).toBe(10_000 - 800);
    await getPosDriver().closeShift({ shiftId: shift.id, countedCents: 9200 });
  });

  it("never more than was captured, per order", async () => {
    const order = await seedOrder([item("l-e1", 1000, 1)], { status: "paid" });
    await seedTender(order);
    const res = await refund(order.id, { amountCents: 1001 });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("refund_exceeds");
    expect(sum(await getPosDriver().listPaymentsForOrder(order.id))).toBe(0);
  });

  it("by item with quantities: the amount comes from the order (discount + tax spread)", async () => {
    const order = await seedOrder([item("l-f1", 1000, 2), item("l-f2", 500, 1)], {
      status: "paid",
      tax: 206,
    });
    await seedTender(order);
    const share = unitShares(order).get("l-f1")!;
    const res = await refund(order.id, { lines: [{ lineId: "l-f1", quantity: 1 }] });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.record.amount_cents).toBe(share[0]);
    expect(body.record.lines).toEqual([{ line_id: "l-f1", quantity: 1, amount_cents: share[0] }]);
    // the remaining units still refund to exactly the total, never beyond
    await refund(order.id, { lines: [{ lineId: "l-f1", quantity: 1 }, { lineId: "l-f2", quantity: 1 }] });
    expect(sum(await getPosDriver().listPaymentsForOrder(order.id))).toBe(order.totals.total_cents);
    const again = await refund(order.id, { lines: [{ lineId: "l-f2", quantity: 1 }] });
    expect(again.status).toBe(422);
  });

  it("two tills refunding the same pizza at once: exactly one gets it", async () => {
    const order = await seedOrder([item("l-g1", 1000, 1), item("l-g2", 1000, 1)], { status: "paid" });
    await seedTender(order);
    const [a, b] = await Promise.all([
      refund(order.id, { lines: [{ lineId: "l-g1", quantity: 1 }] }),
      refund(order.id, { lines: [{ lineId: "l-g1", quantity: 1 }] }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(sum(await getPosDriver().listPaymentsForOrder(order.id))).toBe(1000);
  });

  it("two tills refunding amounts at once never exceed the tender", async () => {
    const order = await seedOrder([item("l-h1", 1000, 1)], { status: "paid" });
    await seedTender(order);
    const results = await Promise.all([
      refund(order.id, { amountCents: 700 }),
      refund(order.id, { amountCents: 700 }),
      refund(order.id, { amountCents: 700 }),
    ]);
    const refunded = sum(await getPosDriver().listPaymentsForOrder(order.id));
    expect(refunded).toBeLessThanOrEqual(1000);
    expect(results.filter((r) => r.status === 200).length).toBeGreaterThanOrEqual(1);
    const records = await getPosDriver().listOrderAdjustments(order.id);
    const moved = records.flatMap((r) => r.allocations).reduce((n, a) => n + a.base_cents + a.tip_cents, 0);
    expect(moved).toBe(refunded);
  });

  it("a retry with the same request id moves nothing again", async () => {
    const order = await seedOrder([item("l-i1", 1000, 2)], { status: "paid" });
    await seedTender(order);
    const requestId = rid("same");
    const first = await refund(order.id, { amountCents: 500, requestId });
    const second = await refund(order.id, { amountCents: 500, requestId });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect((await second.json()).replayed).toBe(true);
    expect(sum(await getPosDriver().listPaymentsForOrder(order.id))).toBe(500);
    expect(await getPosDriver().listOrderAdjustments(order.id)).toHaveLength(1);
  });

  it("a crashed request resumes on retry without refunding twice", async () => {
    const order = await seedOrder([item("l-j1", 1000, 2)], { status: "paid" });
    await seedTender(order, { amount_cents: 1000 });
    await seedTender(order, { amount_cents: 1000, rail: "stripe_terminal", charge_id: "sim_pi_j" });
    const requestId = rid("crash");
    // Simulate a crash after the card part: the ledger row is pending and the
    // card already shows this request's refund.
    const driver = getPosDriver();
    await driver.beginOrderRefund({
      id: requestId,
      tenant_id: TENANT,
      location_id: LOCATION,
      order_id: order.id,
      kind: "refund",
      status: "pending",
      amount_cents: 1500,
      tip_cents: 0,
      lines: [],
      allocations: [],
      reason_code: "quality",
      reason_text: null,
      staff_id: CARMELA,
      actor_user_id: "device-1",
      approved_by: null,
      meta: null,
      created_at: "",
      updated_at: "",
    });
    const card = (await driver.listPaymentsForOrder(order.id)).find((p) => p.rail === "stripe_terminal")!;
    await refundPayment({
      paymentId: card.id,
      amountCents: 1000,
      tipCents: 0,
      refundId: `${requestId}_${card.id.replace(/[^0-9a-zA-Z]/g, "").slice(0, 8)}_0`,
    });
    const res = await refund(order.id, { amountCents: 1500, requestId });
    expect(res.status).toBe(200);
    expect((await res.json()).record.status).toBe("completed");
    expect(sum(await driver.listPaymentsForOrder(order.id))).toBe(1500);
  });
});

// ---------------------------------------------------------------------------
// Tip refunds: kept apart and flagged
// ---------------------------------------------------------------------------

describe("tip refunds", () => {
  it("a food refund never touches the tip; a tip refund is recorded separately and flagged", async () => {
    const order = await seedOrder([item("l-k1", 1000, 2)], { status: "paid" });
    const card = await seedTender(order, {
      rail: "stripe_terminal",
      charge_id: "sim_pi_k",
      amount_cents: 2000,
      tip_cents: 400,
    });
    await refund(order.id, { amountCents: 1000 });
    let p = (await getPosDriver().getPayment(card.id))!;
    expect(p.refunded_cents).toBe(1000);
    expect(p.tip_refunded_cents).toBe(0);
    // Tip facts: the server keeps their tip.
    const facts = () =>
      tipFactsForOrder(
        {
          id: order.id,
          tenant_id: TENANT,
          location_id: LOCATION,
          business_date: "2026-11-09",
          currency: "USD",
          staff_id: null,
          status: "paid",
          tip_cents: 0,
          timezone: "UTC",
        },
        [p],
      );
    expect(facts().filter((f) => f.kind === "adjustment")).toEqual([]);

    const res = await refund(order.id, { tipCents: 150, reasonCode: "other", reasonText: "tip typo" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.record).toMatchObject({ tip_cents: 150, meta: { tip_refund: true } });
    p = (await getPosDriver().getPayment(card.id))!;
    expect(p.tip_refunded_cents).toBe(150);
    expect(facts().filter((f) => f.kind === "adjustment").map((f) => f.amount_cents)).toEqual([-150]);
    // Tip refund caps at the tip.
    expect((await refund(order.id, { tipCents: 251 })).status).toBe(409);
    const audit = (await getPosDriver().listAuditLog(TENANT)).find((a) => a.detail?.includes("TIP REFUND 150"));
    expect(audit).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

describe("manager approval above the location threshold", () => {
  it("a cashier refunds alone up to the threshold; above it needs a manager PIN", async () => {
    await policy({ refund: 500 });
    await asCashier();
    const order = await seedOrder([item("l-m1", 1000, 2)], { status: "paid" });
    await seedTender(order);
    expect((await refund(order.id, { amountCents: 500 })).status).toBe(200);

    const requestId = rid("appr");
    const denied = await refund(order.id, { amountCents: 800, requestId });
    expect(denied.status).toBe(403);
    expect((await denied.json()).code).toBe("approval_required");
    const wrong = await refund(order.id, {
      amountCents: 800,
      requestId,
      approval: { staffId: CARMELA, pin: "9999" },
    });
    expect(wrong.status).toBe(401);
    // A cashier cannot approve (even with the right PIN).
    const cashierApproves = await refund(order.id, {
      amountCents: 800,
      requestId,
      approval: { staffId: CHRIS, pin: "3333" },
    });
    expect(cashierApproves.status).toBe(401);
    const ok = await refund(order.id, {
      amountCents: 800,
      requestId,
      approval: { staffId: CARMELA, pin: "2222" },
    });
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body.record).toMatchObject({ approved_by: CARMELA, staff_id: CHRIS });
    expect(sum(await getPosDriver().listPaymentsForOrder(order.id))).toBe(1300);
    const audit = (await getPosDriver().listAuditLog(TENANT)).filter((a) => a.action === "payment_refund");
    expect(audit.some((a) => a.detail?.includes(CHRIS) && a.detail?.includes(CARMELA))).toBe(true);
  });

  it("with no PIN-switched staff (and PINs in use) nothing is allowed", async () => {
    till.role = null;
    till.staff = null;
    const order = await seedOrder([item("l-n1", 1000, 1)], { status: "paid" });
    await seedTender(order);
    const res = await refund(order.id, { amountCents: 100 });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("staff_required");
  });

  it("a reason is required", async () => {
    const order = await seedOrder([item("l-o1", 1000, 1)], { status: "paid" });
    await seedTender(order);
    const res = await post(refundPOST, order.id, { requestId: rid("nr"), amountCents: 100 });
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe("reason_required");
  });
});

// ---------------------------------------------------------------------------
// Voids
// ---------------------------------------------------------------------------

describe("voids", () => {
  it("voiding a fired item before payment reprices the order and tells the kitchen", async () => {
    const order = await seedOrder([item("l-p1", 1000, 2), item("l-p2", 600, 1)]);
    expect(order.items[0]!.fired_at).toBeTruthy(); // placed = sent to the kitchen
    const res = await voidReq(order.id, { lines: [{ lineId: "l-p1", quantity: 1 }] });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.order.totals.subtotal_cents).toBe(1600);
    expect(body.order.items.filter((i: OrderItem) => i.voided)).toHaveLength(1);
    expect(body.balanceCents).toBe(1600);
    const board = await (
      await kitchenGET(
        new Request(`http://localhost/api/kitchen/orders?tenantId=${TENANT}&locationId=${LOCATION}`),
      )
    ).json();
    expect(
      board.voided.some((v: { orderId: string; scope: string }) => v.orderId === order.id && v.scope === "lines"),
    ).toBe(true);
    const audit = (await getPosDriver().listAuditLog(TENANT)).find((a) => a.action === "order_line_void");
    expect(audit?.detail).toContain(CARMELA);
  });

  it("voiding fired food above the void threshold needs approval (a cashier)", async () => {
    await policy({ void: 500 });
    await asCashier();
    const order = await seedOrder([item("l-q1", 1000, 1), item("l-q2", 100, 1)]);
    expect((await voidReq(order.id, { lines: [{ lineId: "l-q2" }] })).status).toBe(200);
    const r = await voidReq(order.id, { lines: [{ lineId: "l-q1" }] });
    expect(r.status).toBe(422); // the last item: void the order instead
    const whole = await voidReq(order.id, { wholeOrder: true, reasonCode: "walkout" });
    expect(whole.status).toBe(403);
  });

  it("a paid order: a line void is refused (refund it), the whole order refunds in full and ends voided", async () => {
    const order = await seedOrder([item("l-r1", 1000, 2)], { status: "paid" });
    const card = await seedTender(order, {
      rail: "stripe_terminal",
      charge_id: "sim_pi_r",
      amount_cents: 2000,
      tip_cents: 300,
    });
    const line = await voidReq(order.id, { lines: [{ lineId: "l-r1", quantity: 1 }] });
    expect(line.status).toBe(409);
    expect((await line.json()).code).toBe("use_refund");
    const whole = await voidReq(order.id, { wholeOrder: true, reasonCode: "walkout" });
    expect(whole.status).toBe(200);
    const p = (await getPosDriver().getPayment(card.id))!;
    expect(p).toMatchObject({ status: "refunded", refunded_cents: 2300, tip_refunded_cents: 300 });
    expect((await getPosDriver().getOrder(order.id))!.status).toBe("voided");
  });

  it("voiding an unpaid order cancels its open tender and leaves it voided", async () => {
    const order = await seedOrder([item("l-s1", 1000, 1)]);
    const open = await seedTender(order, {
      rail: "stripe_terminal",
      status: "requires_action",
      charge_id: "sim_pi_s",
    });
    const res = await voidReq(order.id, { wholeOrder: true, reasonCode: "walkout" });
    expect(res.status).toBe(200);
    expect((await getPosDriver().getOrder(order.id))!.status).toBe("voided");
    expect((await getPosDriver().getPayment(open.id))!.status).toBe("canceled");
    const board = await (
      await kitchenGET(
        new Request(`http://localhost/api/kitchen/orders?tenantId=${TENANT}&locationId=${LOCATION}`),
      )
    ).json();
    expect(board.voided.some((v: { orderId: string; scope: string }) => v.orderId === order.id && v.scope === "order")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Comps and discounts
// ---------------------------------------------------------------------------

describe("comps and discounts", () => {
  it("comp an item, then 10% off the rest; Σ adjustments == discount; tax follows", async () => {
    const order = await seedOrder([item("l-t1", 1000, 2), item("l-t2", 500, 2)]);
    const comp = await discount(order.id, { type: "comp", lineId: "l-t1", quantity: 1, reasonCode: "quality" });
    expect(comp.status).toBe(200);
    const pct = await discount(order.id, { type: "discount", percentBps: 1000 });
    expect(pct.status).toBe(200);
    const o = (await pct.json()).order as Order;
    // subtotal 3000, comp 1000, 10% of 2000 = 200
    expect(o.totals.discount_cents).toBe(1200);
    expect(o.adjustments!.reduce((n, a) => n + a.amount_cents, 0)).toBe(1200);
    expect(o.totals.total_cents).toBe(1800);
    // voiding the comped line drops its comp and re-takes the %
    const v = await voidReq(order.id, { lines: [{ lineId: "l-t1" }] });
    const after = (await v.json()).order as Order;
    expect(after.adjustments!.map((a) => a.type)).toEqual(["discount"]);
    expect(after.totals.discount_cents).toBe(100);
    // the hub sees a comp/discount adjustment list that ties to the totals
    const contract = toContractOrder({ order: o, payments: [], timezone: "UTC" });
    expect(OrderSchema.parse(contract)).toBeTruthy();
    expect(contract.adjustments.map((a) => a.type)).toEqual(["comp", "discount"]);
    expect(contract.lines.reduce((n, l) => n + l.discount_cents, 0)).toBe(1200);
    expect(contract.lines.find((l) => l.id === "l-t1")!.discount_cents).toBeGreaterThanOrEqual(1000);
  });

  it("above the comp threshold a cashier needs approval; removing a discount needs none", async () => {
    await policy({ comp: 300 });
    await asCashier();
    const order = await seedOrder([item("l-u1", 1000, 1)]);
    expect((await discount(order.id, { type: "discount", amountCents: 300 })).status).toBe(200);
    const big = await discount(order.id, { type: "discount", amountCents: 301 });
    expect(big.status).toBe(403);
    const approved = await discount(order.id, {
      type: "discount",
      amountCents: 400,
      approval: { staffId: CARMELA, pin: "2222" },
    });
    expect(approved.status).toBe(200);
    const o = (await approved.json()).order as Order;
    expect(o.adjustments!.find((a) => a.amount_cents === 400)?.approved_by).toBe(CARMELA);
    const removed = await discount(order.id, { type: "discount", removeId: o.adjustments![0]!.id });
    expect(removed.status).toBe(200);
    expect(((await removed.json()).order as Order).totals.discount_cents).toBe(400);
  });

  it("a paid order cannot be comped (refund instead); a part-paid one only down to what was paid", async () => {
    const paid = await seedOrder([item("l-v1", 1000, 1)], { status: "paid" });
    await seedTender(paid);
    const r = await discount(paid.id, { type: "comp", lineId: "l-v1" });
    expect(r.status).toBe(409);
    expect((await r.json()).code).toBe("use_refund");
    const part = await seedOrder([item("l-v2", 1000, 2)]);
    await seedTender(part, { amount_cents: 1500 });
    expect((await discount(part.id, { type: "discount", amountCents: 600 })).status).toBe(409);
    expect((await discount(part.id, { type: "discount", amountCents: 500 })).status).toBe(200);
  });

  it("two tills editing at once: both land (compare-and-set retry), nothing lost", async () => {
    const order = await seedOrder([item("l-w1", 1000, 1), item("l-w2", 1000, 1), item("l-w3", 1000, 1)]);
    const [a, b] = await Promise.all([
      discount(order.id, { type: "comp", lineId: "l-w1" }),
      voidReq(order.id, { lines: [{ lineId: "l-w2" }] }),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const o = (await getPosDriver().getOrder(order.id))!;
    expect(o.items.find((i) => i.id === "l-w2")!.voided).toBe(true);
    expect(o.totals).toMatchObject({ subtotal_cents: 2000, discount_cents: 1000, total_cents: 1000 });
  });
});

// ---------------------------------------------------------------------------
// Stripe (real mode)
// ---------------------------------------------------------------------------

describe("Stripe card refunds (real mode)", () => {
  function goLive() {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_adj");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://localhost:54321");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service-key");
  }

  it("refunds through Stripe with a per-tender idempotency key; reason goes to metadata", async () => {
    goLive();
    stripeRequest.mockResolvedValue({ id: "re_live_1", status: "succeeded" });
    const order = await seedOrder([item("l-x1", 1000, 2)], { status: "paid" });
    const card = await seedTender(order, {
      rail: "stripe_terminal",
      charge_id: "pi_live_1",
      connect_account_id: ACCT,
      simulated: false,
      amount_cents: 2000,
      tip_cents: 200,
    });
    const requestId = rid("live");
    const res = await refund(order.id, { amountCents: 500, tipCents: 100, requestId, reasonText: "cold" });
    expect(res.status).toBe(200);
    expect(stripeRequest).toHaveBeenCalledTimes(1);
    const [path, params, opts] = stripeRequest.mock.calls[0]!;
    expect(path).toBe("/refunds");
    expect(params).toMatchObject({ payment_intent: "pi_live_1", amount: 600, refund_application_fee: true });
    expect(params.reason).toBeUndefined(); // free text is never sent as Stripe's enum
    expect(params.metadata).toMatchObject({ adjustment_id: requestId, tip_cents: "100", order_id: order.id });
    expect(params.metadata.staff_reason).toContain("cold");
    expect(opts).toMatchObject({ stripeAccount: ACCT });
    expect(opts.idempotencyKey).toBe(
      `refund_${card.id}_${requestId}_${card.id.replace(/[^0-9a-zA-Z]/g, "").slice(0, 8)}_0`,
    );
    const p = (await getPosDriver().getPayment(card.id))!;
    expect(p).toMatchObject({ refunded_cents: 600, tip_refunded_cents: 100 });
    expect(p.refunds![0]!.processor_ref).toBe("re_live_1");
  });

  it("a Stripe error records nothing; the retry uses the same idempotency key", async () => {
    goLive();
    const order = await seedOrder([item("l-y1", 1000, 1)], { status: "paid" });
    await seedTender(order, {
      rail: "stripe_terminal",
      charge_id: "pi_live_2",
      connect_account_id: ACCT,
      simulated: false,
    });
    stripeRequest.mockRejectedValueOnce(new Error("stripe down"));
    const requestId = rid("retry");
    const first = await refund(order.id, { amountCents: 400, requestId });
    expect(first.status).toBe(502);
    expect(sum(await getPosDriver().listPaymentsForOrder(order.id))).toBe(0);
    stripeRequest.mockResolvedValue({ id: "re_live_2", status: "succeeded" });
    const second = await refund(order.id, { amountCents: 400, requestId });
    expect(second.status).toBe(200);
    expect(stripeRequest.mock.calls[0]![2].idempotencyKey).toBe(stripeRequest.mock.calls[1]![2].idempotencyKey);
    expect(sum(await getPosDriver().listPaymentsForOrder(order.id))).toBe(400);
  });

  it("a refund Stripe later fails is released by the webhook (money held again)", async () => {
    goLive();
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_adj");
    stripeRequest.mockResolvedValue({ id: "re_live_3", status: "pending" });
    const order = await seedOrder([item("l-z1", 1000, 1)], { status: "paid" });
    const card = await seedTender(order, {
      rail: "stripe_terminal",
      charge_id: "pi_live_3",
      connect_account_id: ACCT,
      simulated: false,
    });
    await refund(order.id, { amountCents: 1000 });
    expect((await getPosDriver().getOrder(order.id))!.status).toBe("refunded");
    const payload = JSON.stringify({
      type: "charge.refund.updated",
      account: ACCT,
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: "re_live_3",
          object: "refund",
          status: "failed",
          amount: 1000,
          payment_intent: "pi_live_3",
          failure_reason: "expired_or_canceled_card",
        },
      },
    });
    const ts = Math.floor(Date.now() / 1000);
    const sig = createHmac("sha256", "whsec_adj").update(`${ts}.${payload}`).digest("hex");
    const res = await webhookPOST(
      new Request("http://localhost/api/payments/stripe/webhook", {
        method: "POST",
        headers: { "stripe-signature": `t=${ts},v1=${sig}` },
        body: payload,
      }),
    );
    expect((await res.json()).released).toBe(true);
    const p = (await getPosDriver().getPayment(card.id))!;
    expect(p).toMatchObject({ status: "captured", refunded_cents: 0 });
    expect((await getPosDriver().getOrder(order.id))!.status).toBe("completed");
    const record = (await getPosDriver().listOrderAdjustments(order.id))[0]!;
    expect(record.status).toBe("partial");
  });
});

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

describe("reports reflect partial refunds, tip refunds, comps and line voids", () => {
  it("tallies them", async () => {
    const order = await seedOrder([item("l-ra", 1000, 2), item("l-rb", 500, 1)]);
    await voidReq(order.id, { lines: [{ lineId: "l-rb" }] });
    await discount(order.id, { type: "comp", lineId: "l-ra", quantity: 1 });
    const o = (await getPosDriver().getOrder(order.id))!;
    await seedTender(o, { amount_cents: o.totals.total_cents, tip_cents: 200 });
    await getPosDriver().transitionOrderStatus(o.id, ["placed"], "paid");
    await refund(o.id, { amountCents: 300, tipCents: 50 });
    const report = buildSalesReport({
      tenantId: TENANT,
      locationId: LOCATION,
      range: { from: null, to: null },
      orders: [(await getPosDriver().getOrder(o.id))!],
      payments: await getPosDriver().listPaymentsForOrder(o.id),
      categoryOf: () => null,
      locationName: () => "Downtown",
    });
    expect(report).toMatchObject({
      refund_count: 1,
      refund_cents: 350,
      tip_refund_cents: 50,
      comp_count: 1,
      comp_cents: 1000,
      line_void_count: 1,
      line_void_cents: 500,
      discount_cents: 1000,
    });
    expect(report.paymentMix[0]!.refunded_cents).toBe(350);
  });
});
