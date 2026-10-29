import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getPosDriver,
  type CreateOrderInput,
  type OrderItem,
  type OrderTotals,
} from "@/lib/db";
import type { ConnectAccount } from "@/lib/db/payment-types";
import { resetMockOrders, resetMockPayments } from "@/lib/db/mock";

// Capture Stripe calls from the terminal connection-token route.
const stripeRequest = vi.fn();
vi.mock("@/lib/payments/providers/stripe-client", async (orig) => ({
  ...(await orig<typeof import("@/lib/payments/providers/stripe-client")>()),
  stripeRequest: (...a: unknown[]) => stripeRequest(...a),
}));

import { POST as paymentsPOST } from "@/app/api/payments/route";
import { POST as tokenPOST } from "@/app/api/payments/stripe/connection-token/route";
import { takePayment } from "@/lib/payments/service";
import { CARD_NOT_READY_MESSAGE } from "@/lib/payments/connect";

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
async function seedOrder(total = 2000): Promise<string> {
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
    tenant_id: TENANT,
    location_id: LOCATION,
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

  it("no-account tenant is refused too (unknown tenant)", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
    const req = new Request("http://localhost/api/payments", {
      method: "POST",
      headers: { "x-forwarded-for": "8.8.8.8" },
      body: JSON.stringify({
        paymentId: "gate-none",
        orderId: await seedOrder(),
        tenantId: "10000000-0000-0000-0000-0000000000ff",
        locationId: LOCATION,
        rail: "stripe_online",
        amountCents: 2000,
        currency: "USD",
      }),
    });
    expect((await paymentsPOST(req)).status).toBe(409);
  });

  it("connection-token: refuses without a usable account (incl. no tenantId)", async () => {
    await getPosDriver().upsertConnectAccount(acct({ charges_enabled: false }));
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
    const a = await tokenPOST(tokenReq(TENANT));
    expect(a.status).toBe(409);
    const b = await tokenPOST(tokenReq(undefined));
    expect(b.status).toBe(409);
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
