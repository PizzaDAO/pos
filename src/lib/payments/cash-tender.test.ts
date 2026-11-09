import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getPosDriver, type CreateOrderInput } from "@/lib/db";
import { resetMockOrders, resetMockPayments } from "@/lib/db/mock";
import { cashTenderError, planCashTender } from "./cash-tender";
import { CashUnderTenderError, getOrderBalance, takePayment } from "./service";

vi.mock("@/lib/auth/api", () => ({
  requireTenantMember: async () => ({ ok: true, user: { id: "u1", email: "s@x" } }),
  requireTenantRole: async () => ({ ok: true, user: { id: "u1", email: "s@x" } }),
}));

import { POST as paymentsPOST } from "@/app/api/payments/route";

const TENANT = "10000000-0000-0000-0000-000000000001";
const LOCATION = "10000000-0000-0000-0000-000000000101";

describe("planCashTender", () => {
  it("nothing typed means exact cash for balance + tip", () => {
    expect(planCashTender({ balanceCents: 2596, tipCents: 300 })).toEqual({
      kind: "full",
      amountCents: 2596,
      tipCents: 300,
      cashTenderedCents: 2896,
      changeCents: 0,
    });
  });

  it("overpaying gives change and keeps the tip", () => {
    expect(
      planCashTender({ balanceCents: 2596, tipCents: 0, tenderedCents: 5000 }),
    ).toMatchObject({ kind: "full", amountCents: 2596, changeCents: 2404 });
  });

  it("short cash is a partial tender for what was handed over, with no tip", () => {
    expect(
      planCashTender({ balanceCents: 2596, tipCents: 300, tenderedCents: 1000 }),
    ).toEqual({
      kind: "partial",
      amountCents: 1000,
      tipCents: 0,
      cashTenderedCents: 1000,
      changeCents: 0,
      remainingCents: 1596,
    });
  });

  it("covering the balance but not the tip is refused, never guessed", () => {
    expect(
      planCashTender({ balanceCents: 2000, tipCents: 300, tenderedCents: 2100 }),
    ).toEqual({ kind: "short_of_tip", shortCents: 200 });
  });

  it("nothing due", () => {
    expect(planCashTender({ balanceCents: 0, tipCents: 0 })).toEqual({
      kind: "nothing_due",
    });
  });

  it("cashTenderError: short of amount + tip is an error; omitted is exact", () => {
    expect(cashTenderError({ amountCents: 2596, tipCents: 0, cashTenderedCents: 1000 })).toBeTruthy();
    expect(cashTenderError({ amountCents: 2000, tipCents: 300, cashTenderedCents: 2000 })).toBeTruthy();
    expect(cashTenderError({ amountCents: 2000, tipCents: 300, cashTenderedCents: 2300 })).toBeNull();
    expect(cashTenderError({ amountCents: 2000, tipCents: 0 })).toBeNull();
  });
});

let seq = 0;
async function seedOrder(
  total: number,
  channel: CreateOrderInput["channel"] = "in_store",
): Promise<string> {
  seq += 1;
  const id = `cash-tender-${seq}`;
  const input: CreateOrderInput = {
    id,
    tenant_id: TENANT,
    location_id: LOCATION,
    channel,
    currency: "USD",
    items: [
      {
        id: "l1",
        item_id: "i1",
        item_name: "Pizza",
        size_id: null,
        size_name: null,
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
      tip_cents: 0,
      total_cents: total,
    },
    notes: null,
    status: "placed",
  };
  await getPosDriver().createOrder(input);
  return id;
}

function pay(orderId: string, body: Record<string, unknown>) {
  return paymentsPOST(
    new Request("http://localhost/api/payments", {
      method: "POST",
      headers: { "x-forwarded-for": "5.5.5.5" },
      body: JSON.stringify({
        orderId,
        tenantId: TENANT,
        locationId: LOCATION,
        currency: "USD",
        tipCents: 0,
        ...body,
      }),
    }),
  );
}

beforeEach(() => {
  resetMockOrders();
  resetMockPayments();
  vi.stubEnv("STRIPE_SECRET_KEY", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /api/payments cash tenders", () => {
  it("rejects a cash tender short of amount + tip (nothing recorded, order unpaid)", async () => {
    const orderId = await seedOrder(2596);
    const res = await pay(orderId, {
      paymentId: "short-1",
      rail: "cash",
      amountCents: 2596,
      cashTenderedCents: 1000,
    });
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe("cash_under_tender");
    expect(await getPosDriver().getPayment("short-1")).toBeNull();
    const order = await getPosDriver().getOrder(orderId);
    expect(order?.status).toBe("placed");
    expect(await getOrderBalance(order!)).toBe(2596);
  });

  it("rejects cash that covers the base but not the tip", async () => {
    const orderId = await seedOrder(2000);
    const res = await pay(orderId, {
      paymentId: "short-tip",
      rail: "cash",
      amountCents: 2000,
      tipCents: 300,
      cashTenderedCents: 2000,
    });
    expect(res.status).toBe(422);
  });

  it("partial cash leaves the rest due; a second cash tender finishes with change", async () => {
    const orderId = await seedOrder(2596);
    const first = await pay(orderId, {
      paymentId: "part-1",
      rail: "cash",
      amountCents: 1000,
      cashTenderedCents: 1000,
    });
    expect(first.status).toBe(201);
    const a = await first.json();
    expect(a.balanceCents).toBe(1596);
    expect(a.orderStatus).not.toBe("paid");
    expect(a.payment.cash_tendered_cents).toBe(1000);
    expect(a.payment.cash_change_cents).toBe(0);

    const second = await pay(orderId, {
      paymentId: "part-2",
      rail: "cash",
      amountCents: 1596,
      cashTenderedCents: 2000,
    });
    expect(second.status).toBe(201);
    const b = await second.json();
    expect(b.balanceCents).toBe(0);
    expect(b.orderStatus).toBe("paid");
    expect(b.payment.cash_change_cents).toBe(404);
  });

  it("cash then card: card takes the remaining balance", async () => {
    const orderId = await seedOrder(2596);
    await pay(orderId, {
      paymentId: "cc-cash",
      rail: "cash",
      amountCents: 1000,
      cashTenderedCents: 1000,
    });
    const res = await pay(orderId, {
      paymentId: "cc-card",
      rail: "stripe_terminal",
      amountCents: 1596,
      tipCents: 200,
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.orderStatus).toBe("paid");
    expect(body.balanceCents).toBe(0);
    const tenders = await getPosDriver().listPaymentsForOrder(orderId);
    expect(tenders.map((t) => t.amount_cents).sort()).toEqual([1000, 1596]);
  });

  it("never takes more than the remaining balance", async () => {
    const orderId = await seedOrder(2596);
    await pay(orderId, {
      paymentId: "ob-1",
      rail: "cash",
      amountCents: 1000,
      cashTenderedCents: 1000,
    });
    const res = await pay(orderId, {
      paymentId: "ob-2",
      rail: "cash",
      amountCents: 2596,
      cashTenderedCents: 5000,
    });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("amount_exceeds_balance");
    expect(await getPosDriver().getPayment("ob-2")).toBeNull();
  });

  it("the service refuses a short cash tender too (defense in depth)", async () => {
    const orderId = await seedOrder(2000);
    await expect(
      takePayment({
        paymentId: "svc-short",
        orderId,
        tenantId: TENANT,
        locationId: LOCATION,
        rail: "cash",
        amountCents: 2000,
        tipCents: 0,
        currency: "USD",
        cashTenderedCents: 1999,
      }),
    ).rejects.toBeInstanceOf(CashUnderTenderError);
    expect(await getPosDriver().getPayment("svc-short")).toBeNull();
  });

  it("a short cash tender is refused BEFORE superseded online tenders are canceled", async () => {
    const orderId = await seedOrder(2000, "online_pickup");
    const card = await pay(orderId, {
      paymentId: "online-card",
      rail: "stripe_online",
      amountCents: 2000,
    });
    expect(card.status).toBe(201);
    const cardTender = (await card.json()).payment;
    const before = await getPosDriver().getPayment(cardTender.id);
    expect(before?.status).not.toBe("canceled");

    const res = await pay(orderId, {
      paymentId: "online-cash-short",
      rail: "cash",
      amountCents: 2000,
      cashTenderedCents: 500,
    });
    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatch(/Reload the till/);
    // The customer's card checkout was left alone.
    expect((await getPosDriver().getPayment(cardTender.id))?.status).toBe(before?.status);
  });
});
