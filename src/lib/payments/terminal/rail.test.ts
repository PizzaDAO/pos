import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getPosDriver } from "@/lib/db";

const stripeRequest = vi.fn();
const stripeGet = vi.fn();
vi.mock("@/lib/payments/providers/stripe-client", async (orig) => ({
  ...(await orig<typeof import("@/lib/payments/providers/stripe-client")>()),
  stripeRequest: (...a: unknown[]) => stripeRequest(...a),
  stripeGet: (...a: unknown[]) => stripeGet(...a),
}));

import { stripeTerminalRail } from "@/lib/payments/rails/stripe-terminal";

const ctx = {
  tenantId: "t1",
  locationId: "l1",
  connectAccountId: "acct_real_1",
  idempotencyKey: "pay-1",
};

function goReal() {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://localhost:54321");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "k");
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
}

beforeEach(() => {
  stripeRequest.mockReset();
  stripeRequest.mockResolvedValue({ id: "pi_1", status: "requires_payment_method" });
  vi.unstubAllEnvs();
  getPosDriver();
});
afterEach(() => vi.unstubAllEnvs());

describe("stripe_terminal rail (server-driven)", () => {
  it("creates a card_present intent with automatic capture, NEVER confirming it server-side", async () => {
    goReal();
    const res = await stripeTerminalRail.createCharge({
      context: ctx,
      amount: { amount: 2000, currency: "USD" },
      capture: true,
      metadata: { reader_id: "tmr_1", tip_mode: "reader", description: "Order #7" },
    });
    expect(res.status).toBe("requires_action");
    expect(stripeRequest).toHaveBeenCalledTimes(1);
    const [path, body, opts] = stripeRequest.mock.calls[0]!;
    expect(path).toBe("/payment_intents");
    expect(body).toMatchObject({
      payment_method_types: ["card_present"],
      capture_method: "automatic",
      description: "Order #7",
      metadata: { payment_id: "pay-1", reader_id: "tmr_1" },
    });
    expect(body).not.toHaveProperty("confirm");
    expect(opts).toEqual({ stripeAccount: "acct_real_1", idempotencyKey: "pay-1" });
    expect(res.clientSecret).toBeUndefined();
  });

  it("platform fee: always on the pre-tip amount, in every tip mode", async () => {
    goReal();
    const fee = async (tipMode: string, tip: number) => {
      stripeRequest.mockClear();
      await stripeTerminalRail.createCharge({
        context: ctx,
        amount: { amount: 10_000, currency: "USD" },
        tip: tip ? { amount: tip, currency: "USD" } : undefined,
        capture: true,
        metadata: { tip_mode: tipMode },
      });
      return (stripeRequest.mock.calls[0]![1] as { application_fee_amount: number })
        .application_fee_amount;
    };
    expect(await fee("reader", 0)).toBe(260); // 2.5% of 10000 + 10
    expect(await fee("none", 0)).toBe(260);
    expect(await fee("pos", 2000)).toBe(260); // tips carry no platform fee
  });

  it("refund is a direct-charge refund: refund_application_fee, no reverse_transfer", async () => {
    goReal();
    stripeRequest.mockResolvedValue({ id: "re_1", status: "succeeded" });
    const res = await stripeTerminalRail.refund({
      context: { ...ctx, idempotencyKey: "refund_pay-1_r1" },
      chargeId: "pi_1",
      amount: { amount: 500, currency: "USD" },
    });
    expect(res.status).toBe("refunded");
    const [path, body, opts] = stripeRequest.mock.calls[0]!;
    expect(path).toBe("/refunds");
    expect(body).toMatchObject({ payment_intent: "pi_1", amount: 500, refund_application_fee: true });
    expect(body).not.toHaveProperty("reverse_transfer");
    expect(opts).toMatchObject({ stripeAccount: "acct_real_1", idempotencyKey: "refund_pay-1_r1" });
  });

  it("simulated: with a reader the tender waits (requires_action); without one it approves instantly", async () => {
    const withReader = await stripeTerminalRail.createCharge({
      context: ctx,
      amount: { amount: 1000, currency: "USD" },
      capture: true,
      metadata: { reader_id: "tmr_sim_x" },
    });
    expect(withReader.status).toBe("requires_action");
    expect(withReader.chargeId.startsWith("sim_")).toBe(true);
    const legacy = await stripeTerminalRail.createCharge({
      context: ctx,
      amount: { amount: 1000, currency: "USD" },
      capture: true,
    });
    expect(legacy.status).toBe("captured");
    expect(stripeRequest).not.toHaveBeenCalled();
  });
});
