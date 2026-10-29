import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextResponse } from "next/server";
import {
  getPosDriver,
  type CreateOrderInput,
  type OrderChannel,
  type OrderStatus,
  type Payment,
} from "@/lib/db";
import type { ConnectAccount } from "@/lib/db/payment-types";
import { resetMockOrders, resetMockPayments } from "@/lib/db/mock";

const stripeRequest = vi.fn();
const stripeGet = vi.fn();
vi.mock("@/lib/payments/providers/stripe-client", async (orig) => ({
  ...(await orig<typeof import("@/lib/payments/providers/stripe-client")>()),
  stripeRequest: (...a: unknown[]) => stripeRequest(...a),
  stripeGet: (...a: unknown[]) => stripeGet(...a),
}));

const requireTenantRole = vi.fn();
const requireTenantMember = vi.fn();
vi.mock("@/lib/auth/api", () => ({
  requireTenantMember: (...a: unknown[]) => requireTenantMember(...a),
  requireTenantRole: (...a: unknown[]) => requireTenantRole(...a),
}));

import { POST as paymentsPOST } from "@/app/api/payments/route";
import { POST as refundPOST } from "@/app/api/payments/refund/route";
import { POST as cancelPOST } from "@/app/api/shop/orders/cancel/route";
import { CANCEL_WINDOW_MS } from "@/lib/shop/cancel-window";
import {
  GET as ordersGET,
  POST as ordersPOST,
} from "@/app/api/orders/route";
import { RefundExceedsError, refundPayment } from "@/lib/payments/service";
import { createConnectAccount } from "@/lib/payments/connect";
import { LiveKeyOutsideProductionError } from "@/lib/payments/env";
import { stripeOnlineRail } from "@/lib/payments/rails/stripe-online";
import { stripeTerminalRail } from "@/lib/payments/rails/stripe-terminal";
import { useCustomerCart } from "@/lib/store/customer-cart";

const TENANT = "10000000-0000-0000-0000-000000000001";
const LOCATION = "10000000-0000-0000-0000-000000000101";
const ACCT = "acct_real_1";

let seq = 0;

async function seedOrder(
  channel: OrderChannel = "online_pickup",
  status: OrderStatus = "placed",
): Promise<string> {
  seq += 1;
  const id = `final-order-${seq}`;
  const input: CreateOrderInput = {
    id,
    tenant_id: TENANT,
    location_id: LOCATION,
    channel,
    currency: "USD",
    items: [],
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
  };
  await getPosDriver().createOrder(input);
  return id;
}

async function seedTender(
  orderId: string,
  over: Partial<Payment> = {},
): Promise<Payment> {
  seq += 1;
  return getPosDriver().upsertPayment({
    id: `fr-tender-${seq}`,
    order_id: orderId,
    tenant_id: TENANT,
    location_id: LOCATION,
    rail: "stripe_online",
    status: "requires_action",
    amount_cents: 1000,
    tip_cents: 0,
    application_fee_cents: 0,
    currency: "USD",
    charge_id: `pi_fr_${seq}`,
    connect_account_id: ACCT,
    crypto_tx_hash: null,
    crypto_chain: null,
    cash_tendered_cents: null,
    cash_change_cents: null,
    refunded_cents: 0,
    simulated: false,
    raw: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...over,
  });
}

function goLive() {
  getPosDriver();
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://localhost:54321");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service-key");
}

function acct(): ConnectAccount {
  return {
    tenant_id: TENANT,
    account_id: ACCT,
    status: "connected",
    charges_enabled: true,
    payouts_enabled: true,
    details_submitted: true,
    simulated: false,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

beforeEach(() => {
  resetMockOrders();
  resetMockPayments();
  stripeRequest.mockReset();
  stripeGet.mockReset();
  requireTenantRole.mockReset();
  requireTenantMember.mockReset();
  requireTenantRole.mockResolvedValue({ ok: true, user: { id: "u1", email: "o@x" } });
  requireTenantMember.mockResolvedValue({ ok: true, user: { id: "u1", email: "o@x" } });
  vi.unstubAllEnvs();
  vi.stubEnv("STRIPE_SECRET_KEY", "");
  getPosDriver();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

function cancelReq(orderId: unknown) {
  return new Request("http://localhost/api/shop/orders/cancel", {
    method: "POST",
    headers: { "x-forwarded-for": "9.1.1.1" },
    body: JSON.stringify({ orderId }),
  });
}

describe("1: cancel a just-placed, unpaid online order", () => {
  it("voids it anonymously and cancels its delivery", async () => {
    const orderId = await seedOrder("online_delivery");
    await getPosDriver().upsertDelivery({
      id: "del-1",
      order_id: orderId,
      tenant_id: TENANT,
      location_id: LOCATION,
      provider: "in_house_manual",
      status: "pending_assignment",
      zone_id: null,
      fee_cents: 399,
      currency: "USD",
      eta_minutes: 30,
      provider_delivery_id: "inhouse-1",
      tracking_ref: null,
      dropoff: { line1: "1", city: "c", region: "r", postal_code: "10001", country: "US" },
      driver_name: null,
      driver_phone: null,
      simulated: true,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    });
    const res = await cancelPOST(cancelReq(orderId));
    expect(res.status).toBe(200);
    expect((await getPosDriver().getOrder(orderId))?.status).toBe("voided");
    expect((await getPosDriver().getDeliveryForOrder(orderId))?.status).toBe("canceled");
    // Idempotent.
    expect((await cancelPOST(cancelReq(orderId))).status).toBe(200);
  });

  it("refuses in-store orders, paid orders, settled tenders and old orders", async () => {
    const inStore = await seedOrder("in_store");
    expect((await cancelPOST(cancelReq(inStore))).status).toBe(404);

    const paid = await seedOrder("online_pickup", "paid");
    expect((await cancelPOST(cancelReq(paid))).status).toBe(409);

    const withTender = await seedOrder("online_pickup");
    await seedTender(withTender, { status: "captured" });
    expect((await cancelPOST(cancelReq(withTender))).status).toBe(409);
    expect((await getPosDriver().getOrder(withTender))?.status).toBe("placed");

    const old = await seedOrder("online_pickup");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + CANCEL_WINDOW_MS + 60_000);
    expect((await cancelPOST(cancelReq(old))).status).toBe(409);
  });

  it("cancels an open card intent first", async () => {
    goLive();
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
    stripeRequest.mockResolvedValue({ id: "pi", status: "canceled" });
    const orderId = await seedOrder("online_pickup");
    const t = await seedTender(orderId, { charge_id: "pi_open_x" });
    expect((await cancelPOST(cancelReq(orderId))).status).toBe(200);
    expect(stripeRequest.mock.calls[0]![0]).toBe("/payment_intents/pi_open_x/cancel");
    expect((await getPosDriver().getPayment(t.id))?.status).toBe("canceled");
  });

  it("the customer cart adopts the server's repriced lines", () => {
    useCustomerCart.getState().replaceItems([
      {
        id: "srv-1",
        item_id: "i",
        item_name: "Repriced",
        size_id: null,
        size_name: null,
        base_price_cents: 1200,
        quantity: 2,
        modifiers: [],
        notes: null,
        voided: false,
        unit_price_cents: 1200,
        line_total_cents: 2400,
      },
    ]);
    const items = useCustomerCart.getState().items;
    expect(items).toHaveLength(1);
    expect(items[0]!.base_price_cents).toBe(1200);
    expect(useCustomerCart.getState().subtotalCents()).toBe(2400);
  });
});

describe("2: a failed intent cancel is not swallowed", () => {
  beforeEach(async () => {
    goLive();
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
    await getPosDriver().upsertConnectAccount(acct());
  });

  function pay(orderId: string) {
    return paymentsPOST(
      new Request("http://localhost/api/payments", {
        method: "POST",
        headers: { "x-forwarded-for": "9.2.2.2" },
        body: JSON.stringify({
          orderId,
          tenantId: TENANT,
          locationId: LOCATION,
          currency: "USD",
          amountCents: 1,
          paymentId: `fr-new-${seq++}`,
          rail: "stripe_online",
        }),
      }),
    );
  }

  for (const [label, get] of [
    ["a still-cancelable intent", () => stripeGet.mockResolvedValue({ status: "requires_payment_method" })],
    ["an unreachable Stripe", () => stripeGet.mockRejectedValue(new Error("down"))],
  ] as const) {
    it(`${label}: 502 and no second intent`, async () => {
      const orderId = await seedOrder();
      const old = await seedTender(orderId);
      stripeRequest.mockRejectedValue(new Error("cancel failed"));
      get();
      const res = await pay(orderId);
      expect(res.status).toBe(502);
      expect(stripeRequest.mock.calls.map((c) => c[0])).toEqual([
        `/payment_intents/${old.charge_id}/cancel`,
      ]);
      expect((await getPosDriver().getPayment(old.id))?.status).toBe("requires_action");
    });
  }

  it("a processing intent is synced to pending and nothing new is created", async () => {
    const orderId = await seedOrder();
    const old = await seedTender(orderId);
    stripeRequest.mockRejectedValue(new Error("cannot cancel"));
    stripeGet.mockResolvedValue({ status: "processing" });
    const res = await pay(orderId);
    expect(res.status).toBe(409); // pending now covers the amount due
    expect((await getPosDriver().getPayment(old.id))?.status).toBe("pending");
    expect(stripeRequest).toHaveBeenCalledTimes(1);
  });
});

describe("3: refunds are atomic under concurrency", () => {
  async function tender(rail: Payment["rail"], amount = 1000) {
    const orderId = await seedOrder("in_store", "paid");
    return seedTender(orderId, { rail, status: "captured", amount_cents: amount, simulated: true });
  }

  for (const rail of ["cash", "stripe_terminal"] as const) {
    it(`${rail}: concurrent refunds with different ids both land`, async () => {
      if (rail === "stripe_terminal") {
        goLive();
        vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
        stripeRequest.mockResolvedValue({ id: "re", status: "succeeded" });
      }
      const t = await tender(rail);
      await Promise.all([
        refundPayment({ paymentId: t.id, amountCents: 300, refundId: "a" }),
        refundPayment({ paymentId: t.id, amountCents: 400, refundId: "b" }),
      ]);
      const after = await getPosDriver().getPayment(t.id);
      expect(after?.refunded_cents).toBe(700);
      expect([...(after?.refund_ids ?? [])].sort()).toEqual(["a", "b"]);
    });

    it(`${rail}: concurrent over-refund is refused`, async () => {
      if (rail === "stripe_terminal") {
        goLive();
        vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
        stripeRequest.mockResolvedValue({ id: "re", status: "succeeded" });
      }
      const t = await tender(rail);
      const results = await Promise.allSettled([
        refundPayment({ paymentId: t.id, amountCents: 700, refundId: "a" }),
        refundPayment({ paymentId: t.id, amountCents: 700, refundId: "b" }),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
      expect(rejected.reason).toBeInstanceOf(RefundExceedsError);
      expect((await getPosDriver().getPayment(t.id))?.refunded_cents).toBe(700);
    });
  }

  it("cash: a failed rail call releases the reservation", async () => {
    const t = await tender("cash");
    const rails = await import("@/lib/payments/registry");
    const spy = vi
      .spyOn(rails.requirePaymentRail(t.rail), "refund")
      .mockRejectedValue(new Error("rail down"));
    await expect(
      refundPayment({ paymentId: t.id, amountCents: 300, refundId: "x" }),
    ).rejects.toThrow("rail down");
    spy.mockRestore();
    const after = await getPosDriver().getPayment(t.id);
    expect(after?.refunded_cents).toBe(0);
    expect(after?.refund_ids ?? []).toEqual([]);
  });

  it("a stale upsert cannot roll back refund bookkeeping", async () => {
    const t = await tender("cash");
    await refundPayment({ paymentId: t.id, amountCents: 300, refundId: "a" });
    await getPosDriver().upsertPayment({ ...t, status: "captured" }); // stale snapshot
    const after = await getPosDriver().getPayment(t.id);
    expect(after?.refunded_cents).toBe(300);
    expect(after?.refund_ids).toEqual(["a"]);
  });
});

describe("5: refund route details", () => {
  const UUID = "22222222-2222-4222-8222-222222222222";

  async function setup() {
    const orderId = await seedOrder("in_store", "paid");
    return seedTender(orderId, {
      id: UUID,
      rail: "cash",
      status: "captured",
      simulated: true,
    });
  }
  function req(body: Record<string, unknown>) {
    return new Request("http://localhost/api/payments/refund", {
      method: "POST",
      headers: { "x-forwarded-for": "9.5.5.5" },
      body: JSON.stringify({ paymentId: UUID, ...body }),
    });
  }
  async function audits() {
    return (await getPosDriver().listAuditLog(TENANT)).filter(
      (a) => a.action === "payment_refund" || a.action === "payment_void",
    );
  }

  it("over-refund is 409, not 502", async () => {
    await setup();
    expect((await refundPOST(req({ amountCents: 5000, refundId: "refund-xxx-1" }))).status).toBe(409);
  });

  it("an idempotent replay writes no second audit entry", async () => {
    await setup();
    expect((await refundPOST(req({ amountCents: 300, refundId: "refund-r1-aaa" }))).status).toBe(200);
    expect((await refundPOST(req({ amountCents: 300, refundId: "refund-r1-aaa" }))).status).toBe(200);
    expect(await audits()).toHaveLength(1);
  });

  it("the audit records the amount actually refunded (default remainder)", async () => {
    await setup();
    await refundPOST(req({ amountCents: 300, refundId: "refund-r1-aaa" }));
    await refundPOST(req({ refundId: "refund-r2-bbb" })); // default = remainder (700)
    const detail = (await audits()).map((a) => a.detail).join("\n");
    expect(detail).toContain("Refunded 300¢");
    expect(detail).toContain("Refunded 700¢");
  });
});

describe("5: /api/orders roles", () => {
  const body = {
    id: "ord-roles-1",
    tenant_id: TENANT,
    location_id: LOCATION,
    channel: "in_store",
    currency: "USD",
    items: [],
    discount_cents: 0,
    totals: { subtotal_cents: 0, discount_cents: 0, taxable_cents: 0, tax_cents: 0, tip_cents: 0, total_cents: 0 },
    notes: null,
  };

  it("creation needs owner/manager/cashier (kitchen is refused)", async () => {
    requireTenantRole.mockResolvedValue({
      ok: false,
      res: NextResponse.json({ error: "no" }, { status: 403 }),
    });
    const res = await ordersPOST(
      new Request("http://localhost/api/orders", {
        method: "POST",
        headers: { "x-forwarded-for": "9.6.6.6" },
        body: JSON.stringify(body),
      }),
    );
    expect(res.status).toBe(403);
    expect(requireTenantRole).toHaveBeenCalledWith(TENANT, ["owner", "manager", "cashier"]);
  });

  it("listing orders needs a tenant member", async () => {
    requireTenantMember.mockResolvedValue({
      ok: false,
      res: NextResponse.json({ error: "no" }, { status: 401 }),
    });
    const res = await ordersGET(
      new Request(`http://localhost/api/orders?tenantId=${TENANT}&locationId=${LOCATION}`),
    );
    expect(res.status).toBe(401);
  });
});

describe("6: a live key never runs outside production", () => {
  beforeEach(() => {
    goLive();
    stripeRequest.mockResolvedValue({ id: "x", status: "succeeded", client_secret: "cs" });
  });
  const charge = {
    context: { tenantId: TENANT, locationId: LOCATION, connectAccountId: ACCT, idempotencyKey: "k" },
    amount: { amount: 1000, currency: "USD" },
    capture: true,
  };

  for (const key of ["sk_live_abc", "rk_live_abc"]) {
    it(`${key}: Connect creation and card charges are refused`, async () => {
      vi.stubEnv("STRIPE_SECRET_KEY", key);
      vi.stubEnv("VERCEL_ENV", "preview");
      await expect(createConnectAccount(TENANT)).rejects.toBeInstanceOf(LiveKeyOutsideProductionError);
      await expect(stripeOnlineRail.createCharge(charge)).rejects.toBeInstanceOf(LiveKeyOutsideProductionError);
      await expect(stripeTerminalRail.createCharge(charge)).rejects.toBeInstanceOf(LiveKeyOutsideProductionError);
      expect(stripeRequest).not.toHaveBeenCalled();
    });
  }

  it("no VERCEL_ENV (local) is also refused; production is allowed; test keys are unaffected", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_live_abc");
    await expect(createConnectAccount(TENANT)).rejects.toBeInstanceOf(LiveKeyOutsideProductionError);
    vi.stubEnv("VERCEL_ENV", "production");
    await expect(stripeOnlineRail.createCharge(charge)).resolves.toBeTruthy();
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_abc");
    await expect(stripeOnlineRail.createCharge(charge)).resolves.toBeTruthy();
  });
});
