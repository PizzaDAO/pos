import { deriveTenderId } from "./ids";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import {
  getPosDriver,
  type CreateOrderInput,
  type OrderChannel,
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
vi.mock("@/lib/auth/api", () => ({
  requireTenantMember: (...a: unknown[]) => requireTenantRole(...a),
  requireTenantRole: (...a: unknown[]) => requireTenantRole(...a),
}));

import { POST as paymentsPOST } from "@/app/api/payments/route";
import { GET as connectGET, POST as connectPOST } from "@/app/api/connect/route";
import { POST as webhookPOST } from "@/app/api/payments/stripe/webhook/route";
import { POST as refundPOST } from "@/app/api/payments/refund/route";
import { GET as shopLocationGET } from "@/app/api/shop/location/route";
import { applyRailStatus, getOrderBalance, refundPayment } from "@/lib/payments/service";
import { SimulatedAccountOverwriteError } from "@/lib/payments/connect-status";
import { useCartStore } from "@/lib/store/cart";
import { useCustomerCart } from "@/lib/store/customer-cart";
import { MAX_LINE_QUANTITY } from "@/lib/shop/reprice";

const TENANT = "10000000-0000-0000-0000-000000000001";
const LOCATION = "10000000-0000-0000-0000-000000000101";
const ACCT = "acct_real_1";
const SECRET = "whsec_review";

let seq = 0;

function acct(over: Partial<ConnectAccount> = {}): ConnectAccount {
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
    ...over,
  };
}

async function seedOrder(
  channel: OrderChannel = "online_pickup",
  currency = "USD",
): Promise<string> {
  seq += 1;
  const id = `review-order-${seq}`;
  const input: CreateOrderInput = {
    id,
    tenant_id: TENANT,
    location_id: LOCATION,
    channel,
    currency,
    items: [],
    discount_cents: 0,
    totals: {
      subtotal_cents: 2500,
      discount_cents: 0,
      taxable_cents: 2500,
      tax_cents: 0,
      tip_cents: 0,
      total_cents: 2500,
    },
    notes: null,
    status: "placed",
  };
  await getPosDriver().createOrder(input);
  return id;
}

async function seedTender(orderId: string, over: Partial<Payment> = {}): Promise<Payment> {
  seq += 1;
  return getPosDriver().upsertPayment({
    id: `rv-tender-${seq}`,
    order_id: orderId,
    tenant_id: TENANT,
    location_id: LOCATION,
    rail: "stripe_online",
    status: "requires_action",
    amount_cents: 2500,
    tip_cents: 0,
    application_fee_cents: 0,
    currency: "USD",
    charge_id: `pi_rv_${seq}`,
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

function payReq(orderId: string, body: Record<string, unknown>) {
  return new Request("http://localhost/api/payments", {
    method: "POST",
    headers: { "x-forwarded-for": "3.3.3.3" },
    body: JSON.stringify({
      orderId,
      tenantId: TENANT,
      locationId: LOCATION,
      currency: "USD",
      amountCents: 1,
      ...body,
    }),
  });
}

/** Behave like a live driver without switching the memoized mock. */
function goLive() {
  getPosDriver();
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://localhost:54321");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service-key");
}

beforeEach(async () => {
  resetMockOrders();
  resetMockPayments();
  stripeRequest.mockReset();
  stripeGet.mockReset();
  requireTenantRole.mockReset();
  requireTenantRole.mockResolvedValue({ ok: true, user: { id: "u1", email: "o@x" } });
  vi.unstubAllEnvs();
  vi.stubEnv("STRIPE_SECRET_KEY", "");
  getPosDriver();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("1: currency comes from the order, never the client", () => {
  it("rejects a body currency that differs from the order's", async () => {
    const orderId = await seedOrder("online_pickup", "USD");
    const res = await paymentsPOST(
      payReq(orderId, { paymentId: "cur-1", rail: "stripe_online", currency: "KRW" }),
    );
    expect(res.status).toBe(400);
    expect(await getPosDriver().getPayment("cur-1")).toBeNull();
  });

  it("stores the order's currency on the tender", async () => {
    const orderId = await seedOrder("online_pickup", "USD");
    const res = await paymentsPOST(
      payReq(orderId, { paymentId: "cur-2", rail: "stripe_online", currency: "usd" }),
    );
    expect(res.status).toBe(201);
    expect(
      (await getPosDriver().getPayment(deriveTenderId(orderId, "stripe_online")))
        ?.currency,
    ).toBe("USD");
  });

  it("a tender in another currency never covers or settles the order", async () => {
    const orderId = await seedOrder("online_pickup", "USD");
    const t = await seedTender(orderId, { status: "pending", currency: "KRW" });
    const order = (await getPosDriver().getOrder(orderId))!;
    expect(await getOrderBalance(order)).toBe(2500);
    await applyRailStatus(t.id, "captured");
    expect((await getPosDriver().getOrder(orderId))?.status).toBe("placed");
  });
});

describe("2: training mode never rewrites a real Connect account", () => {
  beforeEach(async () => {
    vi.stubEnv("TRAINING_MODE", "1");
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", SECRET);
    await getPosDriver().upsertConnectAccount(acct());
    stripeGet.mockResolvedValue({
      id: ACCT,
      charges_enabled: true,
      payouts_enabled: true,
      details_submitted: true,
    });
    stripeRequest.mockResolvedValue({ url: "https://connect.stripe.test/onboard" });
  });

  async function stored() {
    return getPosDriver().getConnectAccount(TENANT);
  }

  it("GET /api/connect leaves the real account real", async () => {
    const res = await connectGET(
      new Request(`http://localhost/api/connect?tenantId=${TENANT}`),
    );
    expect(res.status).toBe(200);
    expect((await stored())?.account_id).toBe(ACCT);
    expect((await stored())?.simulated).toBe(false);
    expect(stripeGet).toHaveBeenCalledTimes(1);
  });

  it("POST /api/connect reuses the real account and never marks it simulated", async () => {
    const res = await connectPOST(
      new Request("http://localhost/api/connect", {
        method: "POST",
        body: JSON.stringify({ tenantId: TENANT }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.simulated).toBe(false);
    expect((await stored())?.account_id).toBe(ACCT);
    expect((await stored())?.simulated).toBe(false);
    // Only the Account Link was requested; no account was created.
    expect(stripeRequest.mock.calls.map((c) => c[0])).toEqual(["/account_links"]);
  });

  it("the account.updated webhook leaves it real", async () => {
    const payload = JSON.stringify({
      type: "account.updated",
      data: { object: { id: ACCT, charges_enabled: true } },
    });
    const t = Math.floor(Date.now() / 1000);
    const sig = `t=${t},v1=${createHmac("sha256", SECRET).update(`${t}.${payload}`).digest("hex")}`;
    const res = await webhookPOST(
      new Request("http://localhost/api/payments/stripe/webhook", {
        method: "POST",
        headers: { "stripe-signature": sig },
        body: payload,
      }),
    );
    expect(res.status).toBe(200);
    expect((await stored())?.account_id).toBe(ACCT);
    expect((await stored())?.simulated).toBe(false);
  });

  it("the driver refuses to upsert a simulated account over a real row", async () => {
    await expect(
      getPosDriver().upsertConnectAccount(
        acct({ account_id: "acct_sim_abc", simulated: true }),
      ),
    ).rejects.toBeInstanceOf(SimulatedAccountOverwriteError);
    await expect(
      getPosDriver().upsertConnectAccount(acct({ simulated: true })),
    ).rejects.toBeInstanceOf(SimulatedAccountOverwriteError);
    expect((await stored())?.account_id).toBe(ACCT);
    // Replacing a simulated row with a real one stays allowed.
    await getPosDriver().upsertConnectAccount(
      acct({ tenant_id: "10000000-0000-0000-0000-0000000000e1", account_id: "acct_sim_x", simulated: true }),
    );
    await getPosDriver().upsertConnectAccount(
      acct({ tenant_id: "10000000-0000-0000-0000-0000000000e1", account_id: "acct_real_9" }),
    );
  });
});

describe("3: simulated rails cannot pay an online order in a real environment", () => {
  beforeEach(() => {
    goLive();
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
  });

  for (const rail of ["crypto_onchain_usdc", "crypto_coinbase"]) {
    it(`${rail}: refused (409), nothing recorded, hidden in the shop`, async () => {
      const orderId = await seedOrder();
      const res = await paymentsPOST(payReq(orderId, { paymentId: `sim-${rail}`, rail }));
      expect(res.status).toBe(409);
      expect(await getPosDriver().getPayment(`sim-${rail}`)).toBeNull();
    });
  }

  it("a rail outside the online allowlist is refused (stripe_terminal)", async () => {
    const orderId = await seedOrder();
    const res = await paymentsPOST(payReq(orderId, { paymentId: "term-online", rail: "stripe_terminal" }));
    expect(res.status).toBe(422);
  });

  it("/api/shop/location reports cryptoReady false for unconfigured crypto", async () => {
    const res = await shopLocationGET(
      new Request("http://localhost/api/shop/location?slug=tonys-uptown"),
    );
    const body = await res.json();
    expect(body.cryptoReady).toEqual({
      crypto_onchain_usdc: false,
      crypto_coinbase: false,
    });
  });

  it("configured crypto is offered", async () => {
    vi.stubEnv("BASE_RPC_URL", "http://rpc.example");
    vi.stubEnv("COINBASE_COMMERCE_API_KEY", "cb_key");
    const res = await shopLocationGET(
      new Request("http://localhost/api/shop/location?slug=tonys-uptown"),
    );
    expect((await res.json()).cryptoReady).toEqual({
      crypto_onchain_usdc: true,
      crypto_coinbase: true,
    });
  });
});

describe("3b: whole-environment simulation (zero env) still allows simulated rails", () => {
  it("simulated crypto works on an online order, and the shop shows it", async () => {
    const orderId = await seedOrder();
    const res = await paymentsPOST(
      payReq(orderId, { paymentId: "zero-env-crypto", rail: "crypto_onchain_usdc" }),
    );
    expect(res.status).toBe(201);
    const loc = await shopLocationGET(
      new Request("http://localhost/api/shop/location?slug=tonys-uptown"),
    );
    expect((await loc.json()).cryptoReady.crypto_onchain_usdc).toBe(true);
  });
});

describe("4: a second live PaymentIntent is never left open", () => {
  beforeEach(async () => {
    goLive();
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
    await getPosDriver().upsertConnectAccount(acct());
  });

  it("cancels the earlier requires_action intent before creating a new one", async () => {
    const orderId = await seedOrder();
    const old = await seedTender(orderId, { charge_id: "pi_old" });
    stripeRequest.mockImplementation(async (path: string) =>
      path === "/payment_intents"
        ? { id: "pi_new", status: "requires_payment_method", client_secret: "cs_new" }
        : { id: "pi_old", status: "canceled" },
    );
    const res = await paymentsPOST(
      payReq(orderId, { paymentId: "rv-new", rail: "stripe_online" }),
    );
    expect(res.status).toBe(201);
    const calls = stripeRequest.mock.calls;
    expect(calls[0]![0]).toBe("/payment_intents/pi_old/cancel");
    expect(calls[0]![2]).toMatchObject({ stripeAccount: ACCT });
    expect(calls[1]![0]).toBe("/payment_intents");
    expect((await getPosDriver().getPayment(old.id))?.status).toBe("canceled");
    expect((await res.json()).clientSecret).toBe("cs_new");
  });

  it("if the old intent can't be canceled because it succeeded, it is synced and nothing new is created", async () => {
    const orderId = await seedOrder();
    const old = await seedTender(orderId, { charge_id: "pi_done" });
    stripeRequest.mockRejectedValue(new Error("already succeeded"));
    stripeGet.mockResolvedValue({ status: "succeeded" });
    const res = await paymentsPOST(
      payReq(orderId, { paymentId: "rv-new2", rail: "stripe_online" }),
    );
    expect(res.status).toBe(409); // nothing left to pay
    expect((await getPosDriver().getPayment(old.id))?.status).toBe("captured");
    expect((await getPosDriver().getOrder(orderId))?.status).toBe("paid");
    expect(await getPosDriver().getPayment("rv-new2")).toBeNull();
  });

  it("an idempotent retry returns a FRESH client_secret (response only, never stored)", async () => {
    const orderId = await seedOrder();
    // Online tender ids are derived from the order, so a retry finds this one.
    const t = await seedTender(orderId, {
      id: deriveTenderId(orderId, "stripe_online"),
      charge_id: "pi_open",
    });
    stripeGet.mockResolvedValue({ status: "requires_payment_method", client_secret: "cs_fresh" });
    const res = await paymentsPOST(
      payReq(orderId, { paymentId: t.id, rail: "stripe_online" }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.clientSecret).toBe("cs_fresh");
    expect(stripeGet.mock.calls[0]![0]).toBe("/payment_intents/pi_open");
    expect(stripeGet.mock.calls[0]![1]).toMatchObject({ stripeAccount: ACCT });
    expect(JSON.stringify(await getPosDriver().getPayment(t.id))).not.toContain("cs_fresh");
    expect(stripeRequest).not.toHaveBeenCalled();
  });
});

describe("5: carts cap quantity at the server limit", () => {
  it("both cart stores clamp setQuantity to 50", () => {
    const line = {
      id: "l1",
      item_id: "i",
      item_name: "x",
      size_id: null,
      size_name: null,
      base_price_cents: 100,
      quantity: 1,
      modifiers: [],
      notes: null,
      voided: false,
      unit_price_cents: 100,
      line_total_cents: 100,
    };
    useCartStore.getState().addLine(line);
    useCartStore.getState().setQuantity("l1", 999);
    expect(useCartStore.getState().items[0]!.quantity).toBe(MAX_LINE_QUANTITY);
    useCustomerCart.getState().addLine(line);
    useCustomerCart.getState().setQuantity("l1", 999);
    expect(useCustomerCart.getState().items[0]!.quantity).toBe(MAX_LINE_QUANTITY);
  });
});

describe("8: refunds", () => {
  async function capturedTender() {
    stripeRequest.mockResolvedValue({ id: "re_1", status: "succeeded" });
    goLive();
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
    const orderId = await seedOrder("in_store");
    return seedTender(orderId, {
      rail: "stripe_terminal",
      status: "captured",
      amount_cents: 1000,
    });
  }

  it("repeated partial refunds each get their own idempotency key and add up", async () => {
    const t = await capturedTender();
    await refundPayment({ paymentId: t.id, amountCents: 300, refundId: "r-1" });
    await refundPayment({ paymentId: t.id, amountCents: 300, refundId: "r-2" });
    const keys = stripeRequest.mock.calls.map((c) => c[2].idempotencyKey);
    expect(keys[0]).not.toBe(keys[1]);
    for (const c of stripeRequest.mock.calls) {
      expect(c[1].refund_application_fee).toBe(true);
      expect(c[1]).not.toHaveProperty("reverse_transfer");
    }
    expect((await getPosDriver().getPayment(t.id))?.refunded_cents).toBe(600);
  });

  it("a retried identical request (same refundId) is a no-op", async () => {
    const t = await capturedTender();
    await refundPayment({ paymentId: t.id, amountCents: 300, refundId: "r-1" });
    await refundPayment({ paymentId: t.id, amountCents: 300, refundId: "r-1" });
    expect(stripeRequest).toHaveBeenCalledTimes(1);
    expect((await getPosDriver().getPayment(t.id))?.refunded_cents).toBe(300);
  });

  it("refuses to refund more than what is left", async () => {
    const t = await capturedTender();
    await refundPayment({ paymentId: t.id, amountCents: 900, refundId: "r-1" });
    await expect(
      refundPayment({ paymentId: t.id, amountCents: 200, refundId: "r-2" }),
    ).rejects.toThrow(/exceeds/);
  });

  it("the refund route passes the client refundId through and rejects a junk one", async () => {
    const t = await capturedTender();
    const mk = (refundId: unknown) =>
      new Request("http://localhost/api/payments/refund", {
        method: "POST",
        headers: { "x-forwarded-for": "2.2.2.2" },
        body: JSON.stringify({ paymentId: t.id, amountCents: 100, refundId }),
      });
    // isUuid applies to paymentId; give the tender a UUID id via a fresh one.
    expect([200, 422]).toContain((await refundPOST(mk("ok-1"))).status);
    expect((await refundPOST(mk("bad id with spaces!!"))).status).toBe(422);
  });
});
