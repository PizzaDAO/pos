import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getPosDriver,
  type CreateOrderInput,
  type OrderItem,
  type OrderTotals,
} from "@/lib/db";
import type { ConnectAccount } from "@/lib/db/payment-types";
import { resetMockOrders, resetMockPayments } from "@/lib/db/mock";

// Capture Stripe calls from the card rails + terminal connection-token route.
const stripeRequest = vi.fn();
const stripeGet = vi.fn();
vi.mock("@/lib/payments/providers/stripe-client", async (orig) => ({
  ...(await orig<typeof import("@/lib/payments/providers/stripe-client")>()),
  stripeRequest: (...a: unknown[]) => stripeRequest(...a),
  stripeGet: (...a: unknown[]) => stripeGet(...a),
  verifyStripeWebhook: () => true,
}));

const requireTenantRole = vi.fn();
vi.mock("@/lib/auth/api", () => ({
  requireTenantRole: (...a: unknown[]) => requireTenantRole(...a),
}));

import { POST as paymentsPOST } from "@/app/api/payments/route";
import { POST as tokenPOST } from "@/app/api/payments/stripe/connection-token/route";
import { POST as webhookPOST } from "@/app/api/payments/stripe/webhook/route";
import { NextResponse } from "next/server";
import { takePayment } from "@/lib/payments/service";
import { CARD_NOT_READY_MESSAGE, isCardReady } from "@/lib/payments/connect";

const TENANT = "10000000-0000-0000-0000-0000000000a1";
const LOCATION = "10000000-0000-0000-0000-0000000000b1";

function acct(o: Partial<ConnectAccount>): ConnectAccount {
  return {
    tenant_id: TENANT,
    account_id: "acct_real_1",
    status: "connected",
    charges_enabled: true,
    payouts_enabled: true,
    details_submitted: true,
    simulated: false,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...o,
  };
}

let seq = 0;
const OTHER_TENANT = "10000000-0000-0000-0000-0000000000a2";
const OTHER_LOCATION = "10000000-0000-0000-0000-0000000000b2";

async function seedOrder(
  total = 2000,
  tenantId = TENANT,
  locationId = LOCATION,
): Promise<string> {
  seq += 1;
  const id = `gate-order-${seq}`;
  const totals: OrderTotals = {
    subtotal_cents: total,
    discount_cents: 0,
    taxable_cents: total,
    tax_cents: 0,
    tip_cents: 0,
    total_cents: total,
  };
  const line: OrderItem = {
    id: "l1",
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
  const input: CreateOrderInput = {
    id,
    tenant_id: tenantId,
    location_id: locationId,
    channel: "in_store",
    currency: "USD",
    items: [line],
    discount_cents: 0,
    totals,
    notes: null,
    status: "placed",
  };
  await getPosDriver().createOrder(input);
  return id;
}

function payReq(orderId: string, rail: string, n: string) {
  return new Request("http://localhost/api/payments", {
    method: "POST",
    headers: { "x-forwarded-for": `9.9.9.${n.length}${seq}` },
    body: JSON.stringify({
      paymentId: `gate-pay-${n}-${seq}`,
      orderId,
      tenantId: TENANT,
      locationId: LOCATION,
      rail,
      amountCents: 2000,
      currency: "USD",
    }),
  });
}

function tokenReq(tenantId?: string) {
  return new Request("http://localhost/api/payments/stripe/connection-token", {
    method: "POST",
    body: JSON.stringify({ tenantId }),
  });
}

beforeEach(async () => {
  resetMockOrders();
  resetMockPayments();
  stripeRequest.mockReset();
  stripeGet.mockReset();
  stripeGet.mockResolvedValue({ id: "acct_real_1", charges_enabled: false });
  requireTenantRole.mockReset();
  requireTenantRole.mockResolvedValue({ ok: true, user: { id: "u1", email: "s@x" } });
  vi.unstubAllEnvs();
  vi.stubEnv("STRIPE_SECRET_KEY", "");
  // Clear any stored account for the tenant by resetting to a placeholder.
  await getPosDriver().upsertConnectAccount(acct({ account_id: "acct_reset" }));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("real mode: card rails refuse tenants without a usable account", () => {
  for (const rail of ["stripe_online", "stripe_terminal"]) {
    it(`${rail}: 409 when charges_enabled is false`, async () => {
      await getPosDriver().upsertConnectAccount(
        acct({ charges_enabled: false, status: "pending" }),
      );
      vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
      const res = await paymentsPOST(payReq(await seedOrder(), rail, "a"));
      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe(CARD_NOT_READY_MESSAGE);
      expect(stripeRequest).not.toHaveBeenCalled();
    });

    it(`${rail}: 409 for a leftover simulated account`, async () => {
      await getPosDriver().upsertConnectAccount(
        acct({ account_id: "acct_sim_abc", simulated: true }),
      );
      vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
      const res = await paymentsPOST(payReq(await seedOrder(), rail, "b"));
      expect(res.status).toBe(409);
      expect(stripeRequest).not.toHaveBeenCalled();
    });
  }

  it("takePayment itself refuses a card rail with no account id in real mode", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
    await expect(
      takePayment({
        paymentId: "gate-direct-1",
        orderId: await seedOrder(),
        tenantId: TENANT,
        locationId: LOCATION,
        rail: "stripe_online",
        amountCents: 2000,
        tipCents: 0,
        currency: "USD",
        connectAccountId: null,
      }),
    ).rejects.toThrow(CARD_NOT_READY_MESSAGE);
  });

  it("an order whose tenant has no account is refused", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
    const orderId = await seedOrder(2000, OTHER_TENANT, OTHER_LOCATION);
    const req = new Request("http://localhost/api/payments", {
      method: "POST",
      headers: { "x-forwarded-for": "8.8.8.8" },
      body: JSON.stringify({
        paymentId: "gate-none",
        orderId,
        tenantId: OTHER_TENANT,
        locationId: OTHER_LOCATION,
        rail: "stripe_online",
        amountCents: 2000,
        currency: "USD",
      }),
    });
    expect((await paymentsPOST(req)).status).toBe(409);
    expect(stripeRequest).not.toHaveBeenCalled();
  });

  it("connection-token: refuses without a usable account (409) and without a tenantId (400)", async () => {
    await getPosDriver().upsertConnectAccount(acct({ charges_enabled: false }));
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
    const a = await tokenPOST(tokenReq(TENANT));
    expect(a.status).toBe(409);
    const b = await tokenPOST(tokenReq(undefined));
    expect(b.status).toBe(400);
    expect(stripeRequest).not.toHaveBeenCalled();
  });
});

describe("real mode: connected account proceeds", () => {
  it("connection-token mints with stripeAccount set", async () => {
    await getPosDriver().upsertConnectAccount(acct({ account_id: "acct_real_9" }));
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
    stripeRequest.mockResolvedValue({ secret: "tok_1" });
    const res = await tokenPOST(tokenReq(TENANT));
    expect(res.status).toBe(200);
    expect(stripeRequest).toHaveBeenCalledWith(
      "/terminal/connection_tokens",
      {},
      { stripeAccount: "acct_real_9" },
    );
  });

  it("stripe_online charge is created on the connected account", async () => {
    await getPosDriver().upsertConnectAccount(acct({ account_id: "acct_real_9" }));
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
    stripeRequest.mockResolvedValue({
      id: "pi_1",
      status: "succeeded",
      client_secret: "cs",
    });
    const res = await paymentsPOST(payReq(await seedOrder(), "stripe_online", "c"));
    expect(res.status).toBe(201);
    const call = stripeRequest.mock.calls.find((c) =>
      String(c[0]).includes("payment_intents"),
    );
    expect(call?.[2]).toMatchObject({ stripeAccount: "acct_real_9" });
  });
});

describe("simulated mode and non-card rails are unaffected", () => {
  it("card rail settles simulated with no account", async () => {
    const res = await paymentsPOST(payReq(await seedOrder(), "stripe_online", "d"));
    expect(res.status).toBe(201);
    expect(stripeRequest).not.toHaveBeenCalled();
  });

  it("cash works in real mode with no connected account", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
    const res = await paymentsPOST(payReq(await seedOrder(), "cash", "e"));
    expect(res.status).toBe(201);
  });
});

describe("tenant/location come from the order, not the client", () => {
  function mismatchReq(orderId: string, tenantId: string, locationId: string) {
    return new Request("http://localhost/api/payments", {
      method: "POST",
      headers: { "x-forwarded-for": "7.7.7.7" },
      body: JSON.stringify({
        paymentId: `gate-mm-${tenantId.slice(-2)}-${locationId.slice(-2)}`,
        orderId,
        tenantId,
        locationId,
        rail: "stripe_online",
        amountCents: 2000,
        currency: "USD",
      }),
    });
  }

  it("rejects a tenantId that differs from the order (no PaymentIntent on the other tenant)", async () => {
    // The OTHER tenant is fully onboarded; an attacker names it on TENANT's order.
    await getPosDriver().upsertConnectAccount(
      acct({ tenant_id: OTHER_TENANT, account_id: "acct_victim" }),
    );
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
    const res = await paymentsPOST(
      mismatchReq(await seedOrder(), OTHER_TENANT, LOCATION),
    );
    expect(res.status).toBe(400);
    expect(stripeRequest).not.toHaveBeenCalled();
    expect(await getPosDriver().getPayment("gate-mm-a2-b1")).toBeNull();
  });

  it("rejects a locationId that differs from the order", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
    const res = await paymentsPOST(
      mismatchReq(await seedOrder(), TENANT, OTHER_LOCATION),
    );
    expect(res.status).toBe(400);
    expect(stripeRequest).not.toHaveBeenCalled();
  });
});

describe("idempotent retry happens before the card gate", () => {
  it("returns the existing tender even if the account is no longer ready", async () => {
    await getPosDriver().upsertConnectAccount(acct({ account_id: "acct_real_9" }));
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
    stripeRequest.mockResolvedValue({ id: "pi_1", status: "succeeded", client_secret: "cs" });
    const orderId = await seedOrder();
    const mk = () =>
      new Request("http://localhost/api/payments", {
        method: "POST",
        headers: { "x-forwarded-for": "6.6.6.6" },
        body: JSON.stringify({
          paymentId: "gate-retry-1",
          orderId,
          tenantId: TENANT,
          locationId: LOCATION,
          rail: "stripe_online",
          amountCents: 2000,
          currency: "USD",
        }),
      });
    expect((await paymentsPOST(mk())).status).toBe(201);
    // Account becomes unusable (e.g. disabled); the retry must not be refused.
    await getPosDriver().upsertConnectAccount(
      acct({ account_id: "acct_real_9", charges_enabled: false }),
    );
    stripeGet.mockResolvedValue({ id: "acct_real_9", charges_enabled: false });
    const intents = stripeRequest.mock.calls.length;
    const retry = await paymentsPOST(mk());
    expect(retry.status).toBe(201);
    expect((await retry.json()).payment.id).toBe("gate-retry-1");
    expect(stripeRequest.mock.calls.length).toBe(intents);
  });
});

describe("stale charges_enabled is refreshed from Stripe once", () => {
  it("proceeds and persists when Stripe says charges are now enabled", async () => {
    await getPosDriver().upsertConnectAccount(
      acct({ account_id: "acct_real_1", charges_enabled: false, status: "pending" }),
    );
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
    stripeGet.mockResolvedValue({
      id: "acct_real_1",
      charges_enabled: true,
      payouts_enabled: true,
      details_submitted: true,
    });
    stripeRequest.mockResolvedValue({ id: "pi_2", status: "succeeded", client_secret: "cs" });
    const res = await paymentsPOST(payReq(await seedOrder(), "stripe_online", "r"));
    expect(res.status).toBe(201);
    expect(stripeGet).toHaveBeenCalledTimes(1);
    expect((await getPosDriver().getConnectAccount(TENANT))?.charges_enabled).toBe(true);
  });

  it("still refuses when Stripe says charges are not enabled", async () => {
    await getPosDriver().upsertConnectAccount(
      acct({ charges_enabled: false, status: "pending" }),
    );
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
    const res = await paymentsPOST(payReq(await seedOrder(), "stripe_online", "s"));
    expect(res.status).toBe(409);
    expect(stripeGet).toHaveBeenCalledTimes(1);
  });
});

describe("connection-token requires staff on the tenant", () => {
  it("returns 401/403 from the auth helper without minting", async () => {
    await getPosDriver().upsertConnectAccount(acct({ account_id: "acct_real_9" }));
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
    requireTenantRole.mockResolvedValue({
      ok: false,
      res: NextResponse.json({ error: "Not authorized for this tenant." }, { status: 403 }),
    });
    const res = await tokenPOST(tokenReq(TENANT));
    expect(res.status).toBe(403);
    expect(stripeRequest).not.toHaveBeenCalled();
  });

  it("checks owner|manager|cashier for the body tenant", async () => {
    await tokenPOST(tokenReq(TENANT));
    expect(requireTenantRole).toHaveBeenCalledWith(TENANT, [
      "owner",
      "manager",
      "cashier",
    ]);
  });

  it("is 400 without a tenantId (before auth)", async () => {
    expect((await tokenPOST(tokenReq(undefined))).status).toBe(400);
    expect(requireTenantRole).not.toHaveBeenCalled();
  });
});

describe("isCardReady (public UI hint)", () => {
  it("is always true in simulated mode", async () => {
    expect(await isCardReady(TENANT)).toBe(true);
    expect(await isCardReady("10000000-0000-0000-0000-0000000000ee")).toBe(true);
  });

  it("is false in real mode without a charges-enabled real account, with no Stripe call", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
    await getPosDriver().upsertConnectAccount(acct({ charges_enabled: false }));
    expect(await isCardReady(TENANT)).toBe(false);
    await getPosDriver().upsertConnectAccount(
      acct({ account_id: "acct_sim_x", simulated: true }),
    );
    expect(await isCardReady(TENANT)).toBe(false);
    expect(await isCardReady("10000000-0000-0000-0000-0000000000ee")).toBe(false);
    expect(stripeGet).not.toHaveBeenCalled();
  });

  it("is true for a charges-enabled real account", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
    await getPosDriver().upsertConnectAccount(acct({}));
    expect(await isCardReady(TENANT)).toBe(true);
  });
});

describe("account.updated webhook", () => {
  function hook(obj: Record<string, unknown>) {
    return new Request("http://localhost/api/payments/stripe/webhook", {
      method: "POST",
      headers: { "stripe-signature": "t=1,v1=x" },
      body: JSON.stringify({ type: "account.updated", data: { object: obj } }),
    });
  }

  it("syncs charges_enabled onto the tenant matched by account id", async () => {
    await getPosDriver().upsertConnectAccount(
      acct({ account_id: "acct_wh_1", charges_enabled: false, payouts_enabled: false, status: "pending" }),
    );
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
    stripeGet.mockResolvedValue({
      id: "acct_wh_1",
      charges_enabled: true,
      payouts_enabled: true,
      details_submitted: true,
    });
    const res = await webhookPOST(
      hook({ id: "acct_wh_1", charges_enabled: true, payouts_enabled: true, details_submitted: true }),
    );
    expect(res.status).toBe(200);
    const row = await getPosDriver().getConnectAccount(TENANT);
    expect(row?.charges_enabled).toBe(true);
    expect(row?.status).toBe("connected");
    expect(await isCardReady(TENANT)).toBe(true);
  });

  it("ignores an unknown account id", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
    const res = await webhookPOST(hook({ id: "acct_nobody", charges_enabled: true }));
    expect(res.status).toBe(200);
  });

  it("re-fetches from Stripe instead of trusting a stale event payload", async () => {
    await getPosDriver().upsertConnectAccount(
      acct({ account_id: "acct_wh_2", charges_enabled: true }),
    );
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
    // Current Stripe state: charges disabled. The (older) event claims enabled.
    stripeGet.mockResolvedValue({ id: "acct_wh_2", charges_enabled: false });
    await webhookPOST(hook({ id: "acct_wh_2", charges_enabled: true }));
    expect(stripeGet).toHaveBeenCalledTimes(1);
    expect((await getPosDriver().getConnectAccount(TENANT))?.charges_enabled).toBe(false);
  });

  it("on fetch failure applies the payload only if the event is not older than the stored row", async () => {
    await getPosDriver().upsertConnectAccount(
      acct({ account_id: "acct_wh_3", charges_enabled: false, status: "pending" }),
    );
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
    stripeGet.mockRejectedValue(new Error("stripe down"));
    const old = { type: "account.updated", created: 1, data: { object: { id: "acct_wh_3", charges_enabled: true, payouts_enabled: true, details_submitted: true } } };
    const mk = (e: unknown) =>
      new Request("http://localhost/api/payments/stripe/webhook", {
        method: "POST",
        headers: { "stripe-signature": "t=1,v1=x" },
        body: JSON.stringify(e),
      });
    await webhookPOST(mk(old));
    expect((await getPosDriver().getConnectAccount(TENANT))?.charges_enabled).toBe(false);
    const fresh = { ...old, created: Math.floor(Date.now() / 1000) + 60 };
    await webhookPOST(mk(fresh));
    expect((await getPosDriver().getConnectAccount(TENANT))?.charges_enabled).toBe(true);
  });
});

describe("isCardReady recovers a stale not-ready status (throttled)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("refreshes once after 5 min, not before, and persists", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
    await getPosDriver().upsertConnectAccount(
      acct({ charges_enabled: false, status: "pending" }),
    );
    stripeGet.mockResolvedValue({
      id: "acct_real_1",
      charges_enabled: true,
      payouts_enabled: true,
      details_submitted: true,
    });
    expect(await isCardReady(TENANT)).toBe(false); // fresh row: no Stripe call
    expect(stripeGet).not.toHaveBeenCalled();

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 6 * 60_000);
    expect(await isCardReady(TENANT)).toBe(true);
    expect(stripeGet).toHaveBeenCalledTimes(1);
    expect(await isCardReady(TENANT)).toBe(true); // now stored as ready
    expect(stripeGet).toHaveBeenCalledTimes(1);
  });

  it("an unchanged refresh bumps updated_at so the throttle holds, and errors are swallowed", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
    await getPosDriver().upsertConnectAccount(
      acct({ charges_enabled: false, status: "pending" }),
    );
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 6 * 60_000);
    stripeGet.mockResolvedValue({ id: "acct_real_1", charges_enabled: false });
    expect(await isCardReady(TENANT)).toBe(false);
    expect(await isCardReady(TENANT)).toBe(false);
    expect(stripeGet).toHaveBeenCalledTimes(1);

    // Stale again later; a Stripe error must not throw.
    vi.setSystemTime(Date.now() + 6 * 60_000);
    stripeGet.mockRejectedValue(new Error("boom"));
    expect(await isCardReady(TENANT)).toBe(false);
  });
});

describe("takePayment guards paymentId reuse", () => {
  it("throws a conflict when the existing payment belongs to another order", async () => {
    const first = await seedOrder();
    const second = await seedOrder();
    const base = {
      paymentId: "gate-conflict-1",
      tenantId: TENANT,
      locationId: LOCATION,
      rail: "cash" as const,
      amountCents: 2000,
      tipCents: 0,
      currency: "USD",
    };
    await takePayment({ ...base, orderId: first });
    await expect(takePayment({ ...base, orderId: second })).rejects.toThrow(
      /already used for another order/,
    );
    // Same order: idempotent.
    expect((await takePayment({ ...base, orderId: first })).id).toBe("gate-conflict-1");
  });
});
