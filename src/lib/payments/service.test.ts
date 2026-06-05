import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  getPosDriver,
  type CreateOrderInput,
  type OrderTotals,
  type OrderItem,
} from "@/lib/db";
import {
  getOrderBalance,
  refreshPaymentStatus,
  refundPayment,
  takePayment,
} from "@/lib/payments/service";
import { resetMockOrders, resetMockPayments } from "@/lib/db/mock";

const TENANT = "10000000-0000-0000-0000-000000000001";
const LOCATION = "10000000-0000-0000-0000-000000000101";

let orderSeq = 0;

function totals(total: number): OrderTotals {
  return {
    subtotal_cents: total,
    discount_cents: 0,
    taxable_cents: total,
    tax_cents: 0,
    tip_cents: 0,
    total_cents: total,
  };
}

function lineFor(total: number): OrderItem {
  return {
    id: `line-${total}`,
    item_id: "i1",
    item_name: "Pizza",
    size_id: "s1",
    size_name: "L",
    base_price_cents: total,
    quantity: 1,
    modifiers: [],
    notes: null,
    voided: false,
    unit_price_cents: total,
    line_total_cents: total,
  };
}

async function seedOrder(total: number): Promise<string> {
  orderSeq += 1;
  const id = `order-${Date.now()}-${orderSeq}`;
  const input: CreateOrderInput = {
    id,
    tenant_id: TENANT,
    location_id: LOCATION,
    channel: "in_store",
    currency: "USD",
    items: [lineFor(total)],
    discount_cents: 0,
    totals: totals(total),
    notes: null,
    status: "placed",
  };
  await getPosDriver().createOrder(input);
  return id;
}

beforeEach(() => {
  resetMockOrders();
  resetMockPayments();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("payment idempotency — no double charge", () => {
  it("returns the same tender (one charge) when the same paymentId is taken twice", async () => {
    const orderId = await seedOrder(2000);
    const paymentId = "pay-dupe-1";
    const first = await takePayment({
      paymentId,
      orderId,
      tenantId: TENANT,
      locationId: LOCATION,
      rail: "cash",
      amountCents: 2000,
      tipCents: 0,
      currency: "USD",
    });
    const second = await takePayment({
      paymentId,
      orderId,
      tenantId: TENANT,
      locationId: LOCATION,
      rail: "cash",
      amountCents: 2000,
      tipCents: 0,
      currency: "USD",
    });

    expect(second.id).toBe(first.id);
    expect(second.charge_id).toBe(first.charge_id);
    const all = await getPosDriver().listPaymentsForOrder(orderId);
    expect(all).toHaveLength(1);
  });

  it("flips the order to paid only once settled tenders cover the total", async () => {
    const orderId = await seedOrder(3000);
    await takePayment({
      paymentId: "pay-full",
      orderId,
      tenantId: TENANT,
      locationId: LOCATION,
      rail: "cash",
      amountCents: 3000,
      tipCents: 0,
      currency: "USD",
    });
    const order = await getPosDriver().getOrder(orderId);
    expect(order?.status).toBe("paid");
    expect(await getOrderBalance(order!)).toBe(0);
  });
});

describe("split payment", () => {
  it("drives the balance to zero across multiple tenders and pays only when covered", async () => {
    const orderId = await seedOrder(5000);

    await takePayment({
      paymentId: "split-a",
      orderId,
      tenantId: TENANT,
      locationId: LOCATION,
      rail: "cash",
      amountCents: 2000,
      tipCents: 0,
      currency: "USD",
    });
    let order = await getPosDriver().getOrder(orderId);
    expect(order?.status).not.toBe("paid");
    expect(await getOrderBalance(order!)).toBe(3000);

    await takePayment({
      paymentId: "split-b",
      orderId,
      tenantId: TENANT,
      locationId: LOCATION,
      rail: "stripe_terminal",
      amountCents: 3000,
      tipCents: 0,
      currency: "USD",
    });
    order = await getPosDriver().getOrder(orderId);
    expect(order?.status).toBe("paid");
    expect(await getOrderBalance(order!)).toBe(0);

    const all = await getPosDriver().listPaymentsForOrder(orderId);
    expect(all).toHaveLength(2);
  });
});

describe("platform fee on card tenders (wired through the rail)", () => {
  it("records a non-zero application fee for a card rail and zero for cash", async () => {
    const orderId = await seedOrder(2000);
    const card = await takePayment({
      paymentId: "fee-card",
      orderId,
      tenantId: TENANT,
      locationId: LOCATION,
      rail: "stripe_online",
      amountCents: 2000,
      tipCents: 0,
      currency: "USD",
    });
    expect(card.application_fee_cents).toBeGreaterThan(0);

    const orderId2 = await seedOrder(2000);
    const cash = await takePayment({
      paymentId: "fee-cash",
      orderId: orderId2,
      tenantId: TENANT,
      locationId: LOCATION,
      rail: "cash",
      amountCents: 2000,
      tipCents: 0,
      currency: "USD",
    });
    expect(cash.application_fee_cents).toBe(0);
  });
});

describe("crypto pending → confirm", () => {
  it("does NOT settle the order while a crypto tender is only pending", async () => {
    const orderId = await seedOrder(2500);
    const tender = await takePayment({
      paymentId: "crypto-1",
      orderId,
      tenantId: TENANT,
      locationId: LOCATION,
      rail: "crypto_onchain_usdc",
      amountCents: 2500,
      tipCents: 0,
      currency: "USD",
    });
    // Simulated onchain charge starts pending.
    expect(tender.status).toBe("pending");
    const order = await getPosDriver().getOrder(orderId);
    // Pending counts toward the displayed balance (so the cashier isn't asked
    // to collect twice) but the order is NOT yet paid (not settled).
    expect(order?.status).not.toBe("paid");
    expect(await getOrderBalance(order!)).toBe(0);
  });

  it("settles the order once the crypto tender confirms (captured) via the watcher", async () => {
    const orderId = await seedOrder(2500);
    await takePayment({
      paymentId: "crypto-2",
      orderId,
      tenantId: TENANT,
      locationId: LOCATION,
      rail: "crypto_onchain_usdc",
      amountCents: 2500,
      tipCents: 0,
      currency: "USD",
    });
    const driver = getPosDriver();
    // Advance wall-clock past the simulated confirmation window so the rail's
    // status() reports `captured`; refreshPaymentStatus then settles the order.
    const realNow = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(realNow + 60_000);
    const updated = await refreshPaymentStatus("crypto-2");
    expect(updated?.status).toBe("captured");
    const order = await driver.getOrder(orderId);
    expect(order?.status).toBe("paid");
  });
});

describe("refund / void paths", () => {
  it("marks a tender refunded and flips the order to refunded when all are refunded", async () => {
    const orderId = await seedOrder(2000);
    await takePayment({
      paymentId: "refund-1",
      orderId,
      tenantId: TENANT,
      locationId: LOCATION,
      rail: "stripe_terminal",
      amountCents: 2000,
      tipCents: 0,
      currency: "USD",
    });
    const refunded = await refundPayment({ paymentId: "refund-1" });
    expect(refunded?.status).toBe("refunded");
    expect(refunded?.refunded_cents).toBe(2000);
    const order = await getPosDriver().getOrder(orderId);
    expect(order?.status).toBe("refunded");
  });

  it("does NOT mark the order refunded on a partial refund of a single tender", async () => {
    const orderId = await seedOrder(2000);
    await takePayment({
      paymentId: "refund-partial",
      orderId,
      tenantId: TENANT,
      locationId: LOCATION,
      rail: "stripe_terminal",
      amountCents: 2000,
      tipCents: 0,
      currency: "USD",
    });
    const refunded = await refundPayment({
      paymentId: "refund-partial",
      amountCents: 500,
    });
    expect(refunded?.refunded_cents).toBe(500);
    expect(refunded?.status).toBe("captured"); // not fully refunded
    const order = await getPosDriver().getOrder(orderId);
    expect(order?.status).not.toBe("refunded");
  });
});
