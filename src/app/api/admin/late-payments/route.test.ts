/**
 * A late/duplicate payment whose newest settled tender was recorded from outside
 * POS (rail `external`) must be resolvable: the refund route cannot send that
 * money back, so it is "owed by hand" like crypto, and Mark refunded attests it.
 * It must not throw half way (a card refunded, then a 5xx with the item stuck).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getPosDriver, DEMO_LOCATION_DOWNTOWN_ID, DEMO_TENANT_ID, type Payment } from "@/lib/db";
import { resetMockOrders, resetMockPayments } from "@/lib/db/mock";

vi.mock("@/lib/auth/api", () => ({
  requireTenantRole: async () => ({
    ok: true,
    user: { id: "00000000-0000-4000-8000-0000000000aa", email: "owner@example.com" },
  }),
}));

import { POST } from "./route";

const ORDER = "d3000000-0000-4000-8000-000000000001";
const CASH = "d3000000-0000-4000-8000-0000000000c1";
const EXT = "d3000000-0000-4000-8000-0000000000e1";
const T0 = "2026-06-04T22:00:00.000Z";

const post = (action: string) =>
  POST(
    new Request("https://pos.test/api/admin/late-payments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orderId: ORDER, action }),
    }),
  );

function tender(id: string, rail: Payment["rail"], created: string, extra: Partial<Payment> = {}): Payment {
  return {
    id,
    order_id: ORDER,
    tenant_id: DEMO_TENANT_ID,
    location_id: DEMO_LOCATION_DOWNTOWN_ID,
    rail,
    status: "captured",
    amount_cents: 500,
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
    raw: null,
    created_at: created,
    updated_at: created,
    ...extra,
  };
}

beforeEach(async () => {
  resetMockOrders();
  resetMockPayments();
  const d = getPosDriver();
  await d.createOrder({
    id: ORDER,
    tenant_id: DEMO_TENANT_ID,
    location_id: DEMO_LOCATION_DOWNTOWN_ID,
    channel: "online_pickup",
    currency: "USD",
    items: [],
    discount_cents: 0,
    totals: { subtotal_cents: 500, discount_cents: 0, taxable_cents: 500, tax_cents: 0, tip_cents: 0, total_cents: 500 },
    notes: null,
    status: "abandoned",
    fulfillment: {
      type: "pickup",
      scheduled_for: "asap",
      promised_at: T0,
      late_payment: { kind: "late", payment_id: EXT, amount_cents: 1000, flagged_at: T0 },
    },
  });
  await d.upsertPayment(tender(CASH, "cash", "2026-06-04T22:00:00.000Z"));
  await d.upsertPayment(
    tender(EXT, "external", "2026-06-04T22:05:00.000Z", {
      method: "cash",
      processor: "driver",
      collection: "cash_on_delivery",
    }),
  );
});

describe("late payment whose newest tender is external", () => {
  it("refunds what it can, owes the external part by hand, and Mark refunded resolves it", async () => {
    const d = getPosDriver();
    const r = await post("refund");
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.refundOwedManually).toBe(true);
    expect(body.note).toMatch(/outside POS/);
    // the cash tender was refunded; the external one is untouched and still owed
    expect((await d.getPayment(CASH))?.refunded_cents).toBe(500);
    expect((await d.getPayment(EXT))?.refunded_cents).toBe(0);
    expect((await d.getOrder(ORDER))?.fulfillment?.late_payment?.resolved).toBe("refund_owed_manual");

    const done = await post("mark_refunded");
    expect(done.status).toBe(200);
    expect((await d.getPayment(EXT))?.refunded_cents).toBe(500);
    expect((await d.getOrder(ORDER))?.fulfillment?.late_payment?.resolved).toBe("refunded");
    // idempotent: nothing left to mark
    expect((await post("mark_refunded")).status).toBe(409);
  });

  it("does not mark the item resolved when the refund could not be booked (exceeds)", async () => {
    const d = getPosDriver();
    expect((await post("refund")).status).toBe(200);
    // someone already booked 300 of the 500 by hand: 500 more no longer fits
    expect((await d.reservePaymentRefund(EXT, 300, "elsewhere", {})).ok).toBe(true);
    const r = await post("mark_refunded");
    expect(r.status).toBe(409);
    expect((await r.json()).error).toMatch(/already refunded in part/);
    const marker = (await d.getOrder(ORDER))?.fulfillment?.late_payment;
    expect(marker?.resolved).toBe("refund_owed_manual"); // still open
    expect(marker?.claim).toBeFalsy(); // and released for another try
  });
});
