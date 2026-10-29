import { describe, expect, it, vi } from "vitest";
import {
  DEMO_LOCATION_DOWNTOWN_ID,
  DEMO_TENANT_ID,
  getPosDriver,
} from "@/lib/db";
import { requirePaymentRail } from "./registry";
import {
  BalanceExceededError,
  getOrderBalance,
  refundIdempotencyKey,
  refundPayment,
  RefundRejectedError,
  takePayment,
} from "./service";

/**
 * Atomic tender reservation + per-request refund idempotency (mock driver,
 * mirroring supabase/migrations/20260610000000_atomic_tenders_refunds.sql).
 */
let seq = 0;
const uid = (p: string) => `${p}-${Date.now().toString(36)}-${(seq += 1)}`;

async function seedOrder(totalCents: number): Promise<string> {
  const id = uid("atomic-order");
  await getPosDriver().createOrder({
    id,
    tenant_id: DEMO_TENANT_ID,
    location_id: DEMO_LOCATION_DOWNTOWN_ID,
    channel: "in_store",
    currency: "USD",
    items: [],
    discount_cents: 0,
    totals: {
      subtotal_cents: totalCents,
      discount_cents: 0,
      taxable_cents: totalCents,
      tax_cents: 0,
      tip_cents: 0,
      total_cents: totalCents,
    },
    notes: null,
  });
  return id;
}

const tender = (orderId: string, paymentId: string, amountCents: number) => ({
  paymentId,
  orderId,
  tenantId: DEMO_TENANT_ID,
  locationId: DEMO_LOCATION_DOWNTOWN_ID,
  rail: "stripe_terminal" as const,
  amountCents,
  tipCents: 0,
  currency: "USD",
});

describe("atomic tender reservation", () => {
  it("lets exactly one of several concurrent full-balance tenders succeed", async () => {
    const orderId = await seedOrder(2500);
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) =>
        takePayment(tender(orderId, uid(`race-${i}`), 2500)),
      ),
    );
    const ok = results.filter((r) => r.status === "fulfilled");
    const refused = results.filter(
      (r) => r.status === "rejected" && r.reason instanceof BalanceExceededError,
    );
    expect(ok).toHaveLength(1);
    expect(refused).toHaveLength(7);

    const payments = await getPosDriver().listPaymentsForOrder(orderId);
    expect(payments).toHaveLength(1);
    const order = await getPosDriver().getOrder(orderId);
    expect(await getOrderBalance(order!)).toBe(0);
  });

  it("never lets concurrent split tenders exceed the total", async () => {
    const orderId = await seedOrder(1000);
    await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) =>
        takePayment(tender(orderId, uid(`split-${i}`), 400)),
      ),
    );
    const payments = await getPosDriver().listPaymentsForOrder(orderId);
    const covered = payments
      .filter((p) => p.status !== "failed" && p.status !== "canceled")
      .reduce((s, p) => s + p.amount_cents, 0);
    expect(covered).toBeLessThanOrEqual(1000);
    expect(payments).toHaveLength(2); // 400 + 400; a third 400 would overpay
  });

  it("releases the reservation when the rail fails", async () => {
    const orderId = await seedOrder(900);
    const rail = requirePaymentRail("stripe_terminal");
    const spy = vi
      .spyOn(rail, "createCharge")
      .mockRejectedValueOnce(new Error("card declined"));
    await expect(
      takePayment(tender(orderId, uid("declined"), 900)),
    ).rejects.toThrow("card declined");
    spy.mockRestore();
    const order = await getPosDriver().getOrder(orderId);
    expect(await getOrderBalance(order!)).toBe(900);
    await expect(
      takePayment(tender(orderId, uid("retry"), 900)),
    ).resolves.toMatchObject({ amount_cents: 900 });
  });

  it("is idempotent on the payment id", async () => {
    const orderId = await seedOrder(700);
    const id = uid("same");
    const [a, b] = await Promise.all([
      takePayment(tender(orderId, id, 700)),
      takePayment(tender(orderId, id, 700)),
    ]);
    expect(a.id).toBe(id);
    expect(b.id).toBe(id);
    expect(await getPosDriver().listPaymentsForOrder(orderId)).toHaveLength(1);
  });
});

describe("refund idempotency", () => {
  async function paidTender(total: number) {
    const orderId = await seedOrder(total);
    const paymentId = uid("refundable");
    await takePayment(tender(orderId, paymentId, total));
    return paymentId;
  }

  it("uses a distinct rail key per refund request and replays retries", async () => {
    const paymentId = await paidTender(2000);
    const rail = requirePaymentRail("stripe_terminal");
    const spy = vi.spyOn(rail, "refund");

    const first = uid("refund-a");
    await refundPayment({ paymentId, refundId: first, amountCents: 500 });
    // Retry of the SAME refund request → no second rail call, no double count.
    const replay = await refundPayment({
      paymentId,
      refundId: first,
      amountCents: 500,
    });
    expect(replay?.refunded_cents).toBe(500);
    expect(spy).toHaveBeenCalledTimes(1);

    // A DIFFERENT partial refund reaches the rail with its own key.
    const second = uid("refund-b");
    const after = await refundPayment({
      paymentId,
      refundId: second,
      amountCents: 700,
    });
    expect(after?.refunded_cents).toBe(1200);
    expect(spy).toHaveBeenCalledTimes(2);
    const keys = spy.mock.calls.map((c) => c[0].context.idempotencyKey);
    expect(keys).toEqual([
      refundIdempotencyKey(paymentId, first),
      refundIdempotencyKey(paymentId, second),
    ]);
    expect(new Set(keys).size).toBe(2);
    spy.mockRestore();
  });

  it("refuses refunds beyond the refundable amount, even concurrently", async () => {
    const paymentId = await paidTender(1000);
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) =>
        refundPayment({
          paymentId,
          refundId: uid(`rr-${i}`),
          amountCents: 400,
        }),
      ),
    );
    const refused = results.filter(
      (r) => r.status === "rejected" && r.reason instanceof RefundRejectedError,
    );
    expect(refused.length).toBe(3);
    const payment = await getPosDriver().getPayment(paymentId);
    expect(payment?.refunded_cents).toBe(800);
  });

  it("rejects reusing a refund id for another payment", async () => {
    const a = await paidTender(500);
    const b = await paidTender(500);
    const refundId = uid("shared");
    await refundPayment({ paymentId: a, refundId, amountCents: 100 });
    await expect(
      refundPayment({ paymentId: b, refundId, amountCents: 100 }),
    ).rejects.toBeInstanceOf(RefundRejectedError);
  });
});
