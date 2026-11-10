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
import { StripeError } from "@/lib/payments/providers/stripe-client";

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
import { POST as legacyRefundPOST } from "@/app/api/payments/refund/route";
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
function goLiveStripe() {
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_adj");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://localhost:54321");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service-key");
}

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
    expect(params.metadata).toMatchObject({ tip_cents: "100", order_id: order.id });
    expect(params.metadata.refund_id.startsWith(`${requestId}_`)).toBe(true);
    expect(params.metadata.staff_reason).toContain("cold");
    expect(opts).toMatchObject({ stripeAccount: ACCT });
    expect(opts.idempotencyKey).toBe(
      `refund_${card.id}_${requestId}_${card.id.replace(/[^0-9a-zA-Z]/g, "").slice(0, 8)}_0`,
    );
    const p = (await getPosDriver().getPayment(card.id))!;
    expect(p).toMatchObject({ refunded_cents: 600, tip_refunded_cents: 100 });
    expect(p.refunds![0]!.processor_ref).toBe("re_live_1");
  });

  it("an unknown Stripe outcome (network) keeps the refund pending; the retry uses the same key, refunds once", async () => {
    goLive();
    const order = await seedOrder([item("l-y1", 1000, 1)], { status: "paid" });
    await seedTender(order, {
      rail: "stripe_terminal",
      charge_id: "pi_live_2",
      connect_account_id: ACCT,
      simulated: false,
    });
    stripeRequest.mockRejectedValueOnce(new Error("socket hang up"));
    const requestId = rid("retry");
    const first = await refund(order.id, { amountCents: 400, requestId });
    const fb = await first.json();
    expect(fb.record.status).toBe("pending");
    expect(fb.pending).toBe(true);
    // Reserved (holds the cap) but not confirmed.
    const p1 = (await getPosDriver().listPaymentsForOrder(order.id))[0]!;
    expect(p1.refunds![0]).toMatchObject({ state: "pending", amount_cents: 400 });
    // Held, not refunded: status, refunded_cents and reports wait for the confirm.
    expect(p1).toMatchObject({ status: "captured", refunded_cents: 0, refund_reserved_cents: 400 });
    expect(selectRecentOrders([(await getPosDriver().getOrder(order.id))!], new Map([[order.id, [p1]]]))[0]!.money).toBe("paid");
    stripeRequest.mockResolvedValue({ id: "re_live_2", status: "succeeded" });
    const second = await refund(order.id, { amountCents: 400, requestId });
    expect(second.status).toBe(200);
    expect((await second.json()).record.status).toBe("completed");
    expect(stripeRequest).toHaveBeenCalledTimes(2);
    expect(stripeRequest.mock.calls[0]![2].idempotencyKey).toBe(stripeRequest.mock.calls[1]![2].idempotencyKey);
    const p2 = (await getPosDriver().listPaymentsForOrder(order.id))[0]!;
    expect(p2.refunded_cents).toBe(400);
    expect(p2.refunds).toHaveLength(1);
    expect(p2.refunds![0]).toMatchObject({ state: "succeeded", processor_ref: "re_live_2" });
  });

  it("Stripe succeeded but the response was lost: the retry refunds nothing more", async () => {
    goLive();
    stripeRequest.mockResolvedValue({ id: "re_lost", status: "succeeded" });
    const order = await seedOrder([item("l-y2", 1000, 1)], { status: "paid" });
    await seedTender(order, { rail: "stripe_terminal", charge_id: "pi_lost", connect_account_id: ACCT, simulated: false });
    const requestId = rid("lost");
    expect((await refund(order.id, { amountCents: 300, requestId })).status).toBe(200);
    const again = await refund(order.id, { amountCents: 300, requestId });
    expect((await again.json()).replayed).toBe(true);
    expect(stripeRequest).toHaveBeenCalledTimes(1);
    expect(sum(await getPosDriver().listPaymentsForOrder(order.id))).toBe(300);
  });

  it("Stripe succeeded but recording it failed: the retry records it once (same key), no other tender is touched", async () => {
    goLive();
    stripeRequest.mockResolvedValue({ id: "re_db", status: "succeeded" });
    const order = await seedOrder([item("l-y3", 1000, 2)], { status: "paid" });
    const card = await seedTender(order, {
      rail: "stripe_terminal",
      charge_id: "pi_db",
      connect_account_id: ACCT,
      simulated: false,
      amount_cents: 1000,
    });
    const cash = await seedTender(order, { amount_cents: 1000 });
    const driver = getPosDriver();
    const spy = vi.spyOn(driver, "confirmPaymentRefund").mockRejectedValueOnce(new Error("db down"));
    const requestId = rid("db");
    const first = await refund(order.id, { amountCents: 1500, requestId });
    const fb = await first.json();
    expect(fb.error).toBeTruthy();
    // Never re-planned onto the cash tender after the card money moved.
    expect((await driver.getPayment(cash.id))!.refunded_cents).toBe(0);
    spy.mockRestore();
    const second = await refund(order.id, { amountCents: 1500, requestId });
    expect((await second.json()).record.status).toBe("completed");
    const c = (await driver.getPayment(card.id))!;
    expect(c.refunded_cents).toBe(1000);
    expect(c.refunds).toHaveLength(1);
    expect((await driver.getPayment(cash.id))!.refunded_cents).toBe(500);
    // Stripe was asked twice for the card part, with ONE key (it replays, no second refund).
    const keys = stripeRequest.mock.calls.map((c) => c[2].idempotencyKey);
    expect(new Set(keys).size).toBe(1);
  });

  it("a definite Stripe refusal releases the reservation and the retry uses the NEXT key", async () => {
    goLive();
    const order = await seedOrder([item("l-y4", 1000, 1)], { status: "paid" });
    await seedTender(order, { rail: "stripe_terminal", charge_id: "pi_4xx", connect_account_id: ACCT, simulated: false });
    stripeRequest.mockRejectedValueOnce(new StripeError("charge disputed", 400, null));
    const requestId = rid("4xx");
    const first = await refund(order.id, { amountCents: 400, requestId });
    expect(first.status).toBe(502);
    expect(sum(await getPosDriver().listPaymentsForOrder(order.id))).toBe(0);
    stripeRequest.mockResolvedValue({ id: "re_ok", status: "succeeded" });
    const second = await refund(order.id, { amountCents: 400, requestId });
    expect((await second.json()).record.status).toBe("completed");
    const [k1, k2] = stripeRequest.mock.calls.map((c) => c[2].idempotencyKey);
    expect(k1).not.toBe(k2);
    expect(sum(await getPosDriver().listPaymentsForOrder(order.id))).toBe(400);
  });

  it("a replayed Stripe refund that FAILED is never recorded as a success", async () => {
    goLive();
    stripeRequest.mockResolvedValue({ id: "re_failed", status: "failed" });
    const order = await seedOrder([item("l-y5", 1000, 1)], { status: "paid" });
    await seedTender(order, { rail: "stripe_terminal", charge_id: "pi_failed", connect_account_id: ACCT, simulated: false });
    const res = await refund(order.id, { amountCents: 400 });
    expect(res.status).toBe(502);
    expect(sum(await getPosDriver().listPaymentsForOrder(order.id))).toBe(0);
  });

  it("concurrent card refunds are serialized by the reservation: no overflow into the tip", async () => {
    goLive();
    stripeRequest.mockImplementation(async () => ({ id: `re_${Math.random()}`, status: "succeeded" }));
    const order = await seedOrder([item("l-y6", 1000, 1)], { status: "paid" });
    const card = await seedTender(order, {
      rail: "stripe_terminal",
      charge_id: "pi_conc",
      connect_account_id: ACCT,
      simulated: false,
      amount_cents: 1000,
      tip_cents: 300,
    });
    await Promise.all([refund(order.id, { amountCents: 700 }), refund(order.id, { amountCents: 700 })]);
    const p = (await getPosDriver().getPayment(card.id))!;
    expect(p.tip_refunded_cents).toBe(0);
    expect(p.refunded_cents).toBeLessThanOrEqual(1000);
    const stripeTotal = stripeRequest.mock.calls.reduce((n, c) => n + (c[1].amount as number), 0);
    expect(stripeTotal).toBe(p.refunded_cents);
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
    await refund(order.id, { amountCents: 1000, requestId: rid("wh") });
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
    // Back to the status it had before the refund (from the ledger row).
    expect((await getPosDriver().getOrder(order.id))!.status).toBe("paid");
    const record = (await getPosDriver().listOrderAdjustments(order.id))[0]!;
    // Re-derived from the tenders: nothing of it was returned after all.
    expect(record).toMatchObject({ status: "failed", allocations: [] });
    // Resuming the request uses a NEW key: the failed refund is never replayed.
    stripeRequest.mockClear();
    stripeRequest.mockResolvedValue({ id: "re_live_3b", status: "succeeded" });
    const resumed = await refund(order.id, { requestId: record.id, amountCents: 1000 });
    expect((await resumed.json()).record.status).toBe("completed");
    expect(stripeRequest.mock.calls[0]![2].idempotencyKey).toMatch(/_1$/);
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

// ---------------------------------------------------------------------------
// Review fixes (phase 1)
// ---------------------------------------------------------------------------

describe("refunded tenders and the balance", () => {
  it("an UNPAID order: a refunded tender does not count ($100 split: A $30 refunded, B $30 live => $70 due)", async () => {
    const order = await seedOrder([item("l-ba", 10_000, 1)]);
    await seedTender(order, { amount_cents: 3000, status: "refunded", refunded_cents: 3000 });
    await seedTender(order, { amount_cents: 3000 });
    expect(await getOrderBalance((await getPosDriver().getOrder(order.id))!)).toBe(7000);
  });

  it("a PAID order with refunds owes nothing and takes no new tender", async () => {
    const order = await seedOrder([item("l-bb", 5000, 1)], { status: "paid" });
    await seedTender(order, { amount_cents: 2000, status: "refunded", refunded_cents: 2000 });
    await seedTender(order, { amount_cents: 3000 });
    const fresh = (await getPosDriver().getOrder(order.id))!;
    expect(await getOrderBalance(fresh)).toBe(0);
    expect(buildReceipt(fresh, await getPosDriver().listPaymentsForOrder(order.id)).balanceCents).toBe(0);
  });

  it("refunds are refused on an order never paid in full; voiding it gives the part payment back", async () => {
    const order = await seedOrder([item("l-bc", 5000, 1)]);
    const cash = await seedTender(order, { amount_cents: 2000 });
    const res = await refund(order.id, { amountCents: 500 });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("order_unpaid");
    const v = await voidReq(order.id, { wholeOrder: true, reasonCode: "walkout" });
    expect(v.status).toBe(200);
    expect((await getPosDriver().getPayment(cash.id))!.refunded_cents).toBe(2000);
    expect((await getPosDriver().getOrder(order.id))!.status).toBe("voided");
  });
});

describe("edits after a refund, marketplace and stored value", () => {
  it("no comp / discount once any refund exists", async () => {
    const order = await seedOrder([item("l-ca", 1000, 2)], { status: "paid" });
    await seedTender(order);
    await refund(order.id, { amountCents: 100 });
    const r = await discount(order.id, { type: "comp", lineId: "l-ca" });
    expect(r.status).toBe(409);
    expect((await r.json()).code).toBe("refund_exists");
  });

  it("marketplace orders and stored-value sales cannot be comped, discounted or voided", async () => {
    const mk = await seedOrder([item("l-cb", 1000, 1)]);
    const driver = getPosDriver();
    // Mark them the way the channels / gift card modules do.
    const o1 = (await driver.getOrder(mk.id))!;
    o1.source = { type: "integration", channel: "marketplace" };
    expect((await discount(mk.id, { type: "discount", amountCents: 100 })).status).toBe(409);
    expect((await voidReq(mk.id, { wholeOrder: true, reasonCode: "walkout" })).status).toBe(409);
    const sv = await seedOrder([item("l-cc", 1000, 1)]);
    const o2 = (await driver.getOrder(sv.id))!;
    o2.core_ext = { ...(o2.core_ext ?? {}), stored_value: true } as never;
    const r = await voidReq(sv.id, { lines: [{ lineId: "l-cc" }] });
    expect(r.status).toBe(409);
    expect((await r.json()).code).toBe("not_adjustable");
  });
});

describe("voids: approval first", () => {
  it("a refused approval cancels no tender", async () => {
    await policy({ void: 0 });
    await asCashier();
    const order = await seedOrder([item("l-da", 1000, 1)]);
    const open = await seedTender(order, { rail: "stripe_terminal", status: "requires_action", charge_id: "sim_pi_da" });
    const res = await voidReq(order.id, { wholeOrder: true, reasonCode: "walkout" });
    expect(res.status).toBe(403);
    expect((await getPosDriver().getPayment(open.id))!.status).toBe("requires_action");
  });

  it("an approver must work at the order's location", async () => {
    await policy({ refund: 0 });
    await asCashier();
    const driver = getPosDriver();
    const carmela = (await driver.getStaffById(TENANT, CARMELA))!;
    await driver.upsertStaff({ ...carmela, location_ids: ["10000000-0000-0000-0000-0000000009ff"] });
    try {
      const order = await seedOrder([item("l-db", 1000, 1)], { status: "paid" });
      await seedTender(order);
      const r = await refund(order.id, { amountCents: 100, approval: { staffId: CARMELA, pin: "2222" } });
      expect(r.status).toBe(401);
    } finally {
      await driver.upsertStaff({ ...carmela, location_ids: [] });
    }
  });

  it("a request id replayed for another kind of edit is a conflict", async () => {
    const order = await seedOrder([item("l-dc", 1000, 1), item("l-dd", 500, 1)]);
    const requestId = rid("kind");
    expect((await discount(order.id, { type: "discount", amountCents: 100, requestId })).status).toBe(200);
    const r = await voidReq(order.id, { lines: [{ lineId: "l-dd" }], requestId });
    expect(r.status).toBe(409);
    expect((await r.json()).code).toBe("request_conflict");
  });
});

describe("unfinished item refunds", () => {
  it("a failed item refund resumes under the same id (units re-reserved)", async () => {
    goLiveStripe();
    const order = await seedOrder([item("l-ea", 1000, 2)], { status: "paid" });
    await seedTender(order, { rail: "stripe_terminal", charge_id: "pi_ea", connect_account_id: ACCT, simulated: false });
    stripeRequest.mockRejectedValueOnce(new StripeError("try later", 400, null));
    const requestId = rid("ea");
    const first = await refund(order.id, { lines: [{ lineId: "l-ea", quantity: 1 }], requestId });
    expect((await first.json()).record.status).toBe("failed");
    stripeRequest.mockResolvedValue({ id: "re_ea", status: "succeeded" });
    const second = await refund(order.id, { lines: [{ lineId: "l-ea", quantity: 1 }], requestId });
    expect((await second.json()).record.status).toBe("completed");
    expect(await getPosDriver().listOrderAdjustments(order.id)).toHaveLength(1);
  });

  it("a stuck pending item refund can be canceled, which releases its units", async () => {
    const order = await seedOrder([item("l-eb", 1000, 1)], { status: "paid" });
    await seedTender(order);
    const driver = getPosDriver();
    const requestId = rid("stuck");
    await driver.beginOrderRefund({
      id: requestId,
      tenant_id: TENANT,
      location_id: LOCATION,
      order_id: order.id,
      kind: "refund",
      status: "pending",
      amount_cents: 1000,
      tip_cents: 0,
      lines: [{ line_id: "l-eb", quantity: 1, amount_cents: 1000 }],
      allocations: [],
      reason_code: "quality",
      reason_text: null,
      staff_id: null,
      actor_user_id: "device-1",
      approved_by: null,
      meta: null,
      created_at: "",
      updated_at: "",
    });
    const payments = await driver.listPaymentsForOrder(order.id);
    const fresh = (await driver.getOrder(order.id))!;
    const rows = selectRecentOrders([fresh], new Map([[order.id, payments]]), 50, await driver.listOrderAdjustments(order.id));
    expect(rows[0]!.unfinishedRefunds).toBe(1);
    expect((await refund(order.id, { lines: [{ lineId: "l-eb", quantity: 1 }] })).status).toBe(422);
    const c = await refund(order.id, { requestId, cancel: true });
    expect((await c.json()).record.status).toBe("failed");
    expect((await refund(order.id, { lines: [{ lineId: "l-eb", quantity: 1 }] })).status).toBe(200);
  });

  it("a cash refund resumed after a crash writes its drawer payout exactly once", async () => {
    const order = await seedOrder([item("l-ec", 1000, 1)], { status: "paid" });
    const cash = await seedTender(order);
    const driver = getPosDriver();
    const shift = await driver.openShift({ tenantId: TENANT, locationId: LOCATION, staffId: CARMELA, openingFloatCents: 0 });
    const requestId = rid("cash");
    await driver.beginOrderRefund({
      id: requestId,
      tenant_id: TENANT,
      location_id: LOCATION,
      order_id: order.id,
      kind: "refund",
      status: "pending",
      amount_cents: 400,
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
    // The money moved, then the process died before the drawer row.
    await refundPayment({
      paymentId: cash.id,
      amountCents: 400,
      tipCents: 0,
      refundId: `${requestId}_${cash.id.replace(/[^0-9a-zA-Z]/g, "").slice(0, 8)}_0`,
    });
    await refund(order.id, { requestId, amountCents: 400 });
    await refund(order.id, { requestId, amountCents: 400 });
    const events = (await driver.listShiftCashEvents(shift.id)).filter((e) => e.order_id === order.id);
    expect(events).toMatchObject([{ type: "payout", amount_cents: -400 }]);
    await driver.closeShift({ shiftId: shift.id, countedCents: 0 });
  });
});

describe("webhook: failed refund on a voided order", () => {
  it("restores the status it had and keeps the money visible", async () => {
    goLiveStripe();
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_adj2");
    stripeRequest.mockResolvedValue({ id: "re_void_1", status: "succeeded" });
    const order = await seedOrder([item("l-fa", 1000, 1)], { status: "paid" });
    const card = await seedTender(order, { rail: "stripe_terminal", charge_id: "pi_void_1", connect_account_id: ACCT, simulated: false });
    await voidReq(order.id, { wholeOrder: true, reasonCode: "walkout" });
    expect((await getPosDriver().getOrder(order.id))!.status).toBe("voided");
    const payload = JSON.stringify({
      type: "refund.failed",
      account: ACCT,
      data: { object: { id: "re_void_1", object: "refund", status: "failed", payment_intent: "pi_void_1" } },
    });
    const ts = Math.floor(Date.now() / 1000);
    const sig = createHmac("sha256", "whsec_adj2").update(`${ts}.${payload}`).digest("hex");
    await webhookPOST(
      new Request("http://localhost/api/payments/stripe/webhook", {
        method: "POST",
        headers: { "stripe-signature": `t=${ts},v1=${sig}` },
        body: payload,
      }),
    );
    expect((await getPosDriver().getOrder(order.id))!.status).toBe("paid");
    expect((await getPosDriver().getPayment(card.id))!.status).toBe("captured");
  });
});

describe("legacy single-tender refund route", () => {
  it("refuses a refund without a client refund id", async () => {
    const order = await seedOrder([item("l-ga", 1000, 1)], { status: "paid" });
    const t = await seedTender(order);
    const res = await legacyRefundPOST(
      new Request("http://localhost/api/payments/refund", {
        method: "POST",
        headers: { "x-forwarded-for": nextIp() },
        body: JSON.stringify({ paymentId: t.id, amountCents: 100 }),
      }),
    );
    expect(res.status).toBe(422);
    expect((await getPosDriver().getPayment(t.id))!.refunded_cents).toBe(0);
  });
});

describe("pending card refunds never flip the status", () => {
  it("a full card refund pending at Stripe leaves the tender captured and the order paid", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_adj");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://localhost:54321");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service-key");
    stripeRequest.mockRejectedValueOnce(new Error("timeout"));
    const order = await seedOrder([item("l-ha", 1000, 1)], { status: "paid" });
    const card = await seedTender(order, { rail: "stripe_terminal", charge_id: "pi_ha", connect_account_id: ACCT, simulated: false });
    const requestId = rid("ha");
    await refund(order.id, { amountCents: 1000, requestId });
    expect((await getPosDriver().getPayment(card.id))!.status).toBe("captured");
    expect((await getPosDriver().getOrder(order.id))!.status).toBe("paid");
    // A second refund cannot take the held room meanwhile.
    expect((await refund(order.id, { amountCents: 1 })).status).toBe(409);
    stripeRequest.mockResolvedValue({ id: "re_ha", status: "succeeded" });
    await refund(order.id, { amountCents: 1000, requestId });
    expect((await getPosDriver().getPayment(card.id))!).toMatchObject({ status: "refunded", refunded_cents: 1000, refund_reserved_cents: 0 });
    expect((await getPosDriver().getOrder(order.id))!.status).toBe("refunded");
  });
});

describe("VOID ticket for fired food", () => {
  it("prints a VOID ticket on the location's network printer, once per void", async () => {
    const { createPrinter, printVoidTicket } = await import("@/lib/printing/queue");
    const { printer } = await createPrinter({
      tenantId: TENANT,
      locationId: LOCATION,
      label: "Line",
      protocol: "star_cloudprnt",
    });
    const order = await seedOrder([item("l-pa", 1000, 2), item("l-pb", 500, 1)]);
    const requestId = rid("vprint");
    expect((await voidReq(order.id, { lines: [{ lineId: "l-pa", quantity: 1 }], requestId })).status).toBe(200);
    // The hook runs after the response; run it again directly: idempotent per void.
    const after = (await getPosDriver().getOrder(order.id))!;
    await printVoidTicket({
      order: after,
      items: after.items.filter((i) => i.voided),
      scope: "lines",
      dedupeKey: requestId,
    });
    await new Promise((r) => setTimeout(r, 10));
    const jobs = (await getPosDriver().listPrintJobs(TENANT, LOCATION, 50)).filter(
      (j) => j.printer_id === printer.id && j.order_id === order.id,
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.document.lines.map((l) => l.text).join("\n")).toMatch(/\*\*\* VOID \*\*\*/);
    expect(jobs[0]!.document.lines.map((l) => l.text).join("\n")).toMatch(/1x Pizza/);
  });
});

// ---------------------------------------------------------------------------
// Re-review fixes (M1-M3 + LOWs)
// ---------------------------------------------------------------------------

function signedRefundFailed(secret: string, refundId: string, pi: string, nowSec: number) {
  const payload = JSON.stringify({
    type: "refund.failed",
    account: ACCT,
    data: { object: { id: refundId, object: "refund", status: "failed", payment_intent: pi } },
  });
  const sig = createHmac("sha256", secret).update(`${nowSec}.${payload}`).digest("hex");
  return new Request("http://localhost/api/payments/stripe/webhook", {
    method: "POST",
    headers: { "stripe-signature": `t=${nowSec},v1=${sig}` },
    body: payload,
  });
}

describe("M1: a void-originated pending refund can be resumed and canceled", () => {
  async function voidPendingCard(tag: string) {
    goLiveStripe();
    const order = await seedOrder([item(`l-${tag}`, 1000, 1)], { status: "paid" });
    await seedTender(order, { rail: "stripe_terminal", charge_id: `pi_${tag}`, connect_account_id: ACCT, simulated: false });
    stripeRequest.mockRejectedValueOnce(new Error("timeout"));
    const requestId = rid(tag);
    const v = await voidReq(order.id, { wholeOrder: true, reasonCode: "walkout", requestId });
    expect((await v.json()).record.status).toBe("pending");
    return { order, requestId };
  }

  it("resume with only the request id (the stored void reason stands)", async () => {
    const { order, requestId } = await voidPendingCard("m1a");
    stripeRequest.mockResolvedValue({ id: "re_m1a", status: "succeeded" });
    const res = await post(refundPOST, order.id, { requestId });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.record).toMatchObject({ status: "completed", reason_code: "walkout" });
    expect(sum(await getPosDriver().listPaymentsForOrder(order.id))).toBe(1000);
  });

  it("cancel with only the request id is refused while the card refund may be in flight", async () => {
    const { order, requestId } = await voidPendingCard("m1b");
    const res = await post(refundPOST, order.id, { requestId, cancel: true });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("refund_in_flight");
  });
});

describe("M2: Stripe idempotency errors and identical replays", () => {
  it("an idempotency_error leaves the refund pending; the retry sends identical parameters", async () => {
    goLiveStripe();
    const order = await seedOrder([item("l-m2", 1000, 2)], { status: "paid" });
    await seedTender(order, { rail: "stripe_terminal", charge_id: "pi_m2", connect_account_id: ACCT, simulated: false, amount_cents: 2000, tip_cents: 300 });
    stripeRequest.mockRejectedValueOnce(
      new StripeError("Keys for idempotent requests can only be used with the same parameters", 400, {
        error: { type: "idempotency_error", message: "x" },
      }),
    );
    const requestId = rid("m2");
    const first = await refund(order.id, { amountCents: 500, tipCents: 100, requestId, reasonText: "cold" });
    expect((await first.json()).record.status).toBe("pending");
    stripeRequest.mockResolvedValue({ id: "re_m2", status: "succeeded" });
    // A different body on the retry changes nothing that is sent.
    const second = await refund(order.id, { amountCents: 999, requestId, reasonCode: "late" });
    expect((await second.json()).record.status).toBe("completed");
    expect(stripeRequest).toHaveBeenCalledTimes(2);
    expect(stripeRequest.mock.calls[1]).toEqual(stripeRequest.mock.calls[0]);
  });
});

describe("M3: paid in full is history, not current money", () => {
  it("$100: A $30 refunded while unpaid, then B $30 and C $40: $30 still due, not paid", async () => {
    const order = await seedOrder([item("l-m3", 10_000, 1)]);
    const a = await seedTender(order, { amount_cents: 3000 });
    // Given back while the order was unpaid (the legacy path refuses it now; the
    // service call is what a void does).
    await refundPayment({ paymentId: a.id, refundId: "m3-a-back-0001" });
    expect((await getPosDriver().getPayment(a.id))!.refunds![0]!.covering).toBe(false);
    await seedTender(order, { amount_cents: 3000 });
    let fresh = (await getPosDriver().getOrder(order.id))!;
    expect(await getOrderBalance(fresh)).toBe(7000);
    const { takePayment } = await import("@/lib/payments/service");
    await takePayment({
      paymentId: globalThis.crypto.randomUUID(),
      orderId: order.id,
      tenantId: TENANT,
      locationId: LOCATION,
      rail: "cash",
      amountCents: 4000,
      tipCents: 0,
      currency: "USD",
    });
    fresh = (await getPosDriver().getOrder(order.id))!;
    expect(await getOrderBalance(fresh)).toBe(3000);
    expect(fresh.status).toBe("placed");
  });

  it("the legacy refund route refuses an order that was never paid in full", async () => {
    const order = await seedOrder([item("l-m3b", 5000, 1)]);
    const t = await seedTender(order, { amount_cents: 2000 });
    const res = await legacyRefundPOST(
      new Request("http://localhost/api/payments/refund", {
        method: "POST",
        headers: { "x-forwarded-for": nextIp() },
        body: JSON.stringify({ paymentId: t.id, amountCents: 100, refundId: "m3-legacy-0001" }),
      }),
    );
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("order_unpaid");
  });
});

describe("one execution per request, the sweeper, old refund failures", () => {
  it("a doubled request: one runs, the other is told to retry; refunded once", async () => {
    goLiveStripe();
    const order = await seedOrder([item("l-dbl", 1000, 1)], { status: "paid" });
    await seedTender(order, { rail: "stripe_terminal", charge_id: "pi_dbl", connect_account_id: ACCT, simulated: false });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    stripeRequest.mockImplementation(async () => {
      await gate;
      return { id: "re_dbl", status: "succeeded" };
    });
    const requestId = rid("dbl");
    const a = refund(order.id, { amountCents: 600, requestId });
    await new Promise((r) => setTimeout(r, 20));
    const b = await refund(order.id, { amountCents: 600, requestId });
    expect(b.status).toBe(409);
    expect(await b.json()).toMatchObject({ code: "in_progress", pending: true });
    release();
    expect((await a).status).toBe(200);
    expect(sum(await getPosDriver().listPaymentsForOrder(order.id))).toBe(600);
    expect(stripeRequest).toHaveBeenCalledTimes(1);
  });

  it("the sweeper alerts on stuck refunds and finishes their card refunds with the same key", async () => {
    goLiveStripe();
    const order = await seedOrder([item("l-swp", 1000, 1)], { status: "paid" });
    await seedTender(order, { rail: "stripe_terminal", charge_id: "pi_swp", connect_account_id: ACCT, simulated: false });
    stripeRequest.mockRejectedValueOnce(new Error("timeout"));
    const requestId = rid("swp");
    await refund(order.id, { amountCents: 400, requestId });
    stripeRequest.mockResolvedValue({ id: "re_swp", status: "succeeded" });
    const { sweepPendingRefunds } = await import("./service");
    // Not stale yet: untouched.
    expect((await sweepPendingRefunds(new Date())).stale).toBe(0);
    const out = await sweepPendingRefunds(new Date(Date.now() + 16 * 60_000));
    expect(out).toMatchObject({ stale: 1, resumed: 1 });
    const [k1, k2] = stripeRequest.mock.calls.map((c) => c[2].idempotencyKey);
    expect(k1).toBe(k2);
    expect((await getPosDriver().listOrderAdjustments(order.id))[0]!.status).toBe("completed");
    expect(sum(await getPosDriver().listPaymentsForOrder(order.id))).toBe(400);
  });

  it("a refund that fails more than an hour later restores the order to completed, not the kitchen", async () => {
    goLiveStripe();
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_old");
    stripeRequest.mockResolvedValue({ id: "re_old", status: "succeeded" });
    const order = await seedOrder([item("l-old", 1000, 1)], { status: "paid" });
    await seedTender(order, { rail: "stripe_terminal", charge_id: "pi_old", connect_account_id: ACCT, simulated: false });
    await getPosDriver().transitionOrderStatus(order.id, ["paid"], "in_kitchen");
    await refund(order.id, { amountCents: 1000, requestId: rid("old") });
    expect((await getPosDriver().getOrder(order.id))!.status).toBe("refunded");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.now() + 2 * 60 * 60_000));
    try {
      await webhookPOST(signedRefundFailed("whsec_old", "re_old", "pi_old", Math.floor(Date.now() / 1000)));
    } finally {
      vi.useRealTimers();
    }
    expect((await getPosDriver().getOrder(order.id))!.status).toBe("completed");
  });
});

describe("EOD report dates refunds by refund time", () => {
  it("a refund two days after the sale is in the refund day's report, not the sale day's", async () => {
    const order = await seedOrder([item("l-eod", 1000, 1)], { status: "paid" });
    const t = await seedTender(order);
    await refund(order.id, { amountCents: 400 });
    const p = (await getPosDriver().getPayment(t.id))!;
    const later = new Date(Date.parse(p.refunds![0]!.at) + 2 * 24 * 60 * 60_000).toISOString();
    const moved = { ...p, refunds: p.refunds!.map((r) => ({ ...r, at: later })) };
    const saleDay = order.created_at.slice(0, 10);
    const refundDay = later.slice(0, 10);
    const report = (from: string, to: string) =>
      buildSalesReport({
        tenantId: TENANT,
        locationId: LOCATION,
        range: { from, to },
        orders: [order],
        payments: [moved],
        categoryOf: () => null,
        locationName: () => "Downtown",
      });
    expect(report(saleDay, saleDay)).toMatchObject({ refund_cents: 0, order_count: 1 });
    expect(report(refundDay, refundDay)).toMatchObject({ refund_cents: 400, refund_count: 1, order_count: 0 });
  });
});

// ---------------------------------------------------------------------------
// Follow-ups: timeouts, the webhook and the claim, stuck refunds, covering
// ---------------------------------------------------------------------------

describe("follow-ups: Stripe timeouts are unknown outcomes", () => {
  it("a timed-out Stripe refund stays pending; the retry replays the same key and confirms it", async () => {
    goLiveStripe();
    const { StripeTimeoutError } = await import("@/lib/payments/providers/stripe-client");
    const order = await seedOrder([item("l-to", 1000, 1)], { status: "paid" });
    await seedTender(order, { rail: "stripe_terminal", charge_id: "pi_to", connect_account_id: ACCT, simulated: false });
    stripeRequest.mockRejectedValueOnce(new StripeTimeoutError("/refunds", 25_000));
    const requestId = rid("to");
    const first = await refund(order.id, { amountCents: 400, requestId });
    expect((await first.json()).record.status).toBe("pending");
    const p1 = (await getPosDriver().listPaymentsForOrder(order.id))[0]!;
    expect(p1).toMatchObject({ refunded_cents: 0, refund_reserved_cents: 400 });
    expect(p1.refund_ids).toHaveLength(1); // reserved, never released
    stripeRequest.mockResolvedValue({ id: "re_to", status: "succeeded" });
    const second = await refund(order.id, { amountCents: 400, requestId });
    expect((await second.json()).record.status).toBe("completed");
    const [k1, k2] = stripeRequest.mock.calls.map((c) => c[2].idempotencyKey);
    expect(k1).toBe(k2);
    expect(sum(await getPosDriver().listPaymentsForOrder(order.id))).toBe(400);
  });
});

describe("follow-ups: the refund.failed webhook never frees a live claim", () => {
  it("re-derives the record but leaves claimed_until as it was", async () => {
    goLiveStripe();
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_claim");
    stripeRequest.mockResolvedValue({ id: "re_claim", status: "pending" });
    const order = await seedOrder([item("l-cl", 1000, 1)], { status: "paid" });
    await seedTender(order, { rail: "stripe_terminal", charge_id: "pi_claim", connect_account_id: ACCT, simulated: false });
    const requestId = rid("claim");
    await refund(order.id, { amountCents: 400, requestId });
    const driver = getPosDriver();
    // Another execution of the request holds the claim right now.
    const until = new Date(Date.now() + 60_000).toISOString();
    expect(await driver.claimOrderAdjustment(order.id, requestId, until)).toBe(true);
    const res = await webhookPOST(signedRefundFailed("whsec_claim", "re_claim", "pi_claim", Math.floor(Date.now() / 1000)));
    expect((await res.json()).released).toBe(true);
    const record = (await driver.listOrderAdjustments(order.id)).find((r) => r.id === requestId)!;
    expect(record.status).toBe("failed");
    expect(record.meta).toMatchObject({ refund_failed: "re_claim" });
    expect(record.claimed_until).toBe(until);
    // So a doubled request is still refused while the claim lives.
    expect(await driver.claimOrderAdjustment(order.id, requestId, until)).toBe(false);
  });
});

describe("follow-ups: a part payment given back earlier does not block `refunded`", () => {
  it("$100: A $30 refunded while unpaid, then B pays $100 and is fully refunded: the order is refunded", async () => {
    const order = await seedOrder([item("l-cov", 10_000, 1)]);
    const a = await seedTender(order, { amount_cents: 3000 });
    await refundPayment({ paymentId: a.id, refundId: "cov-a-back-0001" });
    expect((await getPosDriver().getPayment(a.id))!.refunds![0]!.covering).toBe(false);
    expect((await getPosDriver().getOrder(order.id))!.status).toBe("placed");
    const { takePayment } = await import("@/lib/payments/service");
    const b = await takePayment({
      paymentId: globalThis.crypto.randomUUID(),
      orderId: order.id,
      tenantId: TENANT,
      locationId: LOCATION,
      rail: "cash",
      amountCents: 10_000,
      tipCents: 0,
      currency: "USD",
    });
    expect((await getPosDriver().getOrder(order.id))!.status).toBe("paid");
    await refundPayment({ paymentId: b.id, refundId: "cov-b-full-0001" });
    expect((await getPosDriver().getPayment(b.id))!.refunds![0]!.covering).toBe(true);
    expect((await getPosDriver().getOrder(order.id))!.status).toBe("refunded");
  });

  it("an order whose only refunds were given back while unpaid is still not `refunded`", async () => {
    const order = await seedOrder([item("l-cov2", 10_000, 1)]);
    const a = await seedTender(order, { amount_cents: 3000 });
    await refundPayment({ paymentId: a.id, refundId: "cov2-a-back-01" });
    expect((await getPosDriver().getOrder(order.id))!.status).toBe("placed");
  });
});

describe("follow-ups: resolving a refund stuck pending at Stripe", () => {
  async function stuck(tag: string, amount = 500) {
    goLiveStripe();
    const order = await seedOrder([item(`l-${tag}`, 1000, 2)], { status: "paid" });
    const card = await seedTender(order, {
      rail: "stripe_terminal",
      charge_id: `pi_${tag}`,
      connect_account_id: ACCT,
      simulated: false,
      amount_cents: 2000,
    });
    const idem = () =>
      new StripeError("Keys for idempotent requests can only be used with the same parameters", 400, {
        error: { type: "idempotency_error", message: "x" },
      });
    stripeRequest.mockRejectedValue(idem());
    const requestId = rid(tag);
    await refund(order.id, { amountCents: amount, requestId });
    // The retry hits the same idempotency error: stuck pending.
    await refund(order.id, { amountCents: amount, requestId });
    const p = (await getPosDriver().getPayment(card.id))!;
    const entry = p.refunds![0]!;
    expect(entry.state).toBe("pending");
    stripeRequest.mockReset();
    return { order, card, requestId, refundId: entry.request_id! };
  }
  const later = () => Date.now() + 10 * 60_000;

  it("refuses while the Stripe call may still be in flight", async () => {
    const { card, refundId } = await stuck("rs0");
    const { resolveStuckCardRefund } = await import("@/lib/payments/refund-resolve");
    await expect(
      resolveStuckCardRefund({ tenantId: TENANT, paymentId: card.id, refundId }),
    ).rejects.toMatchObject({ code: "too_recent" });
    expect(stripeGet).not.toHaveBeenCalled();
  });

  it("Stripe has it: confirmed with the re_ id (looked up by our refund id), never refunded again", async () => {
    const { order, card, requestId, refundId } = await stuck("rs1");
    stripeGet.mockResolvedValue({
      data: [
        { id: "re_other", status: "succeeded", amount: 100, payment_intent: "pi_rs1", metadata: { refund_id: "someone-else" } },
        { id: "re_found", status: "succeeded", amount: 500, payment_intent: "pi_rs1", metadata: { refund_id: refundId, payment_id: card.id } },
      ],
      has_more: false,
    });
    const { resolveStuckCardRefund } = await import("@/lib/payments/refund-resolve");
    const out = await resolveStuckCardRefund({ tenantId: TENANT, paymentId: card.id, refundId, now: later() });
    expect(out.outcome).toBe("confirmed");
    expect(stripeRequest).not.toHaveBeenCalled();
    expect(stripeGet.mock.calls[0]![0]).toBe("/refunds?payment_intent=pi_rs1&limit=100");
    expect(stripeGet.mock.calls[0]![1]).toMatchObject({ stripeAccount: ACCT });
    const p = (await getPosDriver().getPayment(card.id))!;
    expect(p).toMatchObject({ refunded_cents: 500, refund_reserved_cents: 0 });
    expect(p.refunds![0]).toMatchObject({ state: "succeeded", processor_ref: "re_found" });
    const record = (await getPosDriver().listOrderAdjustments(order.id)).find((r) => r.id === requestId)!;
    expect(record.status).toBe("completed");
    expect(record.claimed_until ?? null).toBeNull();
    // Already resolved: a second call changes nothing.
    await expect(
      resolveStuckCardRefund({ tenantId: TENANT, paymentId: card.id, refundId, now: later() }),
    ).rejects.toMatchObject({ code: "already_resolved" });
  });

  it("Stripe has none: released with a tombstone; resuming the request uses the NEXT key", async () => {
    const { order, card, requestId, refundId } = await stuck("rs2");
    stripeGet.mockResolvedValue({ data: [], has_more: false });
    const { resolveStuckCardRefund } = await import("@/lib/payments/refund-resolve");
    const out = await resolveStuckCardRefund({ tenantId: TENANT, paymentId: card.id, refundId, now: later() });
    expect(out.outcome).toBe("released");
    const p = (await getPosDriver().getPayment(card.id))!;
    expect(p).toMatchObject({ refunded_cents: 0, refund_reserved_cents: 0 });
    expect(p.refunds).toEqual([]);
    expect(p.refund_ids).toContain(refundId);
    expect((await getPosDriver().listOrderAdjustments(order.id)).find((r) => r.id === requestId)!.status).toBe("failed");
    stripeRequest.mockResolvedValue({ id: "re_next", status: "succeeded" });
    const resumed = await refund(order.id, { amountCents: 500, requestId });
    expect((await resumed.json()).record.status).toBe("completed");
    expect(stripeRequest.mock.calls[0]![2].idempotencyKey).toMatch(/_1$/);
  });

  it("Stripe failed it: released", async () => {
    const { card, refundId } = await stuck("rs3");
    stripeGet.mockResolvedValue({
      data: [{ id: "re_fail", status: "failed", amount: 500, payment_intent: "pi_rs3", metadata: { refund_id: refundId } }],
      has_more: false,
    });
    const { resolveStuckCardRefund } = await import("@/lib/payments/refund-resolve");
    expect((await resolveStuckCardRefund({ tenantId: TENANT, paymentId: card.id, refundId, now: later() })).outcome).toBe(
      "released",
    );
  });

  it("another amount at Stripe, or a re_ id of another refund: nothing changes", async () => {
    const { card, refundId } = await stuck("rs4");
    const { resolveStuckCardRefund } = await import("@/lib/payments/refund-resolve");
    stripeGet.mockResolvedValue({
      data: [{ id: "re_amt", status: "succeeded", amount: 900, payment_intent: "pi_rs4", metadata: { refund_id: refundId } }],
      has_more: false,
    });
    await expect(
      resolveStuckCardRefund({ tenantId: TENANT, paymentId: card.id, refundId, now: later() }),
    ).rejects.toMatchObject({ code: "mismatch" });
    stripeGet.mockReset();
    stripeGet.mockResolvedValue({ id: "re_x", status: "succeeded", amount: 500, payment_intent: "pi_rs4", metadata: { refund_id: "other" } });
    await expect(
      resolveStuckCardRefund({ tenantId: TENANT, paymentId: card.id, refundId, stripeRefundId: "re_x", now: later() }),
    ).rejects.toMatchObject({ code: "mismatch" });
    stripeGet.mockResolvedValue({ id: "re_y", status: "succeeded", amount: 500, payment_intent: "pi_elsewhere", metadata: {} });
    await expect(
      resolveStuckCardRefund({ tenantId: TENANT, paymentId: card.id, refundId, stripeRefundId: "re_y", now: later() }),
    ).rejects.toMatchObject({ code: "mismatch" });
    const p = (await getPosDriver().getPayment(card.id))!;
    expect(p.refunds![0]!.state).toBe("pending");
    expect(p.refund_reserved_cents).toBe(500);
  });

  it("a re_ id from the dashboard (no metadata) for the same amount confirms it", async () => {
    const { card, refundId } = await stuck("rs5");
    const nowSec = Math.floor(Date.now() / 1000);
    // Older than the refund it would confirm: refused.
    stripeGet.mockResolvedValueOnce({
      id: "re_old", status: "succeeded", amount: 500, payment_intent: "pi_rs5", metadata: {}, created: nowSec - 3600,
    });
    const { resolveStuckCardRefund: r0 } = await import("@/lib/payments/refund-resolve");
    await expect(
      r0({ tenantId: TENANT, paymentId: card.id, refundId, stripeRefundId: "re_old", now: later() }),
    ).rejects.toMatchObject({ code: "mismatch" });
    stripeGet.mockResolvedValue({
      id: "re_dash", status: "succeeded", amount: 500, payment_intent: "pi_rs5", metadata: {}, created: nowSec,
    });
    const { resolveStuckCardRefund } = await import("@/lib/payments/refund-resolve");
    const out = await resolveStuckCardRefund({
      tenantId: TENANT, paymentId: card.id, refundId, stripeRefundId: "re_dash", now: later(),
    });
    expect(out.outcome).toBe("confirmed");
    expect(stripeGet.mock.calls.at(-1)![0]).toBe("/refunds/re_dash");
    expect((await getPosDriver().getPayment(card.id))!.refunds![0]!.processor_ref).toBe("re_dash");
  });

  it("another tenant's payment is not found", async () => {
    const { card, refundId } = await stuck("rs6");
    const { resolveStuckCardRefund } = await import("@/lib/payments/refund-resolve");
    await expect(
      resolveStuckCardRefund({ tenantId: "10000000-0000-0000-0000-00000000ffff", paymentId: card.id, refundId, now: later() }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("a dry run only reports; the outcome pressed must still match what Stripe says", async () => {
    const { card, refundId } = await stuck("rs8");
    stripeGet.mockResolvedValue({ data: [], has_more: false });
    const { resolveStuckCardRefund } = await import("@/lib/payments/refund-resolve");
    const dry = await resolveStuckCardRefund({ tenantId: TENANT, paymentId: card.id, refundId, dryRun: true, now: later() });
    expect(dry).toMatchObject({ dryRun: true, outcome: "released", stripeRefund: null });
    expect((await getPosDriver().getPayment(card.id))!.refunds![0]!.state).toBe("pending");
    await expect(
      resolveStuckCardRefund({ tenantId: TENANT, paymentId: card.id, refundId, expect: "confirmed", now: later() }),
    ).rejects.toMatchObject({ code: "mismatch" });
    expect((await getPosDriver().getPayment(card.id))!.refunds![0]!.state).toBe("pending");
    const out = await resolveStuckCardRefund({ tenantId: TENANT, paymentId: card.id, refundId, expect: "released", now: later() });
    expect(out.outcome).toBe("released");
  });

  it("RACE: a till retry confirms the refund while the resolver looks it up: the release fails, nothing is undone", async () => {
    const { card, refundId } = await stuck("rs9");
    const driver = getPosDriver();
    stripeGet.mockImplementation(async () => {
      // The till's retry lands meanwhile (as if it had got past the lock just
      // before the resolver took it): Stripe refunded, POS confirmed.
      await driver.confirmPaymentRefund(card.id, refundId, "re_till");
      return { data: [], has_more: false };
    });
    const { resolveStuckCardRefund } = await import("@/lib/payments/refund-resolve");
    await expect(
      resolveStuckCardRefund({ tenantId: TENANT, paymentId: card.id, refundId, now: later() }),
    ).rejects.toMatchObject({ code: "in_progress" });
    const p = (await driver.getPayment(card.id))!;
    expect(p.refunds![0]).toMatchObject({ state: "succeeded", processor_ref: "re_till" });
    expect(p.refunded_cents).toBe(500);
  });

  it("RACE: while the resolver holds the tender's lock, a till retry never calls Stripe", async () => {
    const { order, card, requestId, refundId } = await stuck("rs10");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    stripeGet.mockImplementation(async () => {
      await gate;
      return { data: [], has_more: false };
    });
    const { resolveStuckCardRefund } = await import("@/lib/payments/refund-resolve");
    // A legacy-route style refund id is not a till request: only the lock guards it.
    const resolving = resolveStuckCardRefund({ tenantId: TENANT, paymentId: card.id, refundId, now: later() });
    await new Promise((r) => setTimeout(r, 10));
    stripeRequest.mockResolvedValue({ id: "re_should_not", status: "succeeded" });
    await expect(refundPayment({ paymentId: card.id, refundId })).rejects.toThrow(/resolving/);
    expect(stripeRequest).not.toHaveBeenCalled();
    release();
    expect((await resolving).outcome).toBe("released");
    // The lock is gone afterwards.
    expect(await getPosDriver().takePaymentRefundLock(card.id, "probe", new Date(Date.now() + 1000).toISOString())).toBe(true);
    void order;
    void requestId;
  });

  it("while a till runs the same request, it is refused (one execution at a time)", async () => {
    const { order, card, requestId, refundId } = await stuck("rs7");
    await getPosDriver().claimOrderAdjustment(order.id, requestId, new Date(Date.now() + 60_000).toISOString());
    const { resolveStuckCardRefund } = await import("@/lib/payments/refund-resolve");
    await expect(
      resolveStuckCardRefund({ tenantId: TENANT, paymentId: card.id, refundId, now: later() }),
    ).rejects.toMatchObject({ code: "in_progress" });
    expect(stripeGet).not.toHaveBeenCalled();
  });
});

describe("follow-ups: the sweeper alerts once a day and never resends an expired key", () => {
  it("dedupes the stuck alert and skips card refunds past the idempotency window", async () => {
    goLiveStripe();
    const obs = await import("@/lib/observability");
    const order = await seedOrder([item("l-swd", 1000, 1)], { status: "paid" });
    await seedTender(order, { rail: "stripe_terminal", charge_id: "pi_swd", connect_account_id: ACCT, simulated: false });
    stripeRequest.mockRejectedValue(new Error("socket hang up"));
    const requestId = rid("swd");
    await refund(order.id, { amountCents: 400, requestId });
    stripeRequest.mockClear();
    const spy = vi.spyOn(obs, "captureError");
    const { sweepPendingRefunds } = await import("./service");
    const stuckAlerts = () => spy.mock.calls.filter((c) => (c[1] as { scope?: string })?.scope === "refund-stuck").length;
    try {
      vi.useFakeTimers({ toFake: ["Date"] });
      const t0 = Date.now();
      vi.setSystemTime(new Date(t0 + 20 * 60_000));
      await sweepPendingRefunds(new Date());
      vi.setSystemTime(new Date(t0 + 40 * 60_000));
      await sweepPendingRefunds(new Date());
      expect(stuckAlerts()).toBe(1);
      expect(stripeRequest).toHaveBeenCalledTimes(2); // still within the window: resumed (same key)
      // A day later: alerted again, but the expired key is never resent.
      stripeRequest.mockClear();
      vi.setSystemTime(new Date(t0 + 25 * 60 * 60_000));
      await sweepPendingRefunds(new Date());
      expect(stuckAlerts()).toBe(2);
      expect(stripeRequest).not.toHaveBeenCalled();
      const record = (await getPosDriver().listOrderAdjustments(order.id)).find((r) => r.id === requestId)!;
      expect(record.meta).toMatchObject({ needs_resolution: true });
    } finally {
      vi.useRealTimers();
      spy.mockRestore();
    }
  });
});
