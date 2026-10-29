import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getPosDriver } from "@/lib/db";

const stripeRequest = vi.fn();
vi.mock("@/lib/payments/providers/stripe-client", async (orig) => ({
  ...(await orig<typeof import("@/lib/payments/providers/stripe-client")>()),
  stripeRequest: (...a: unknown[]) => stripeRequest(...a),
}));

import { stripeOnlineRail } from "@/lib/payments/rails/stripe-online";
import { stripeTerminalRail } from "@/lib/payments/rails/stripe-terminal";
import { cardRailsSimulated } from "@/lib/payments/env";
import { railIsSimulated } from "@/lib/payments/service";
import { GET as readyGET } from "@/app/api/ready/route";

const ctx = {
  tenantId: "t1",
  locationId: "l1",
  connectAccountId: "acct_real_1",
  idempotencyKey: "k1",
};
const charge = {
  context: ctx,
  amount: { amount: 1000, currency: "USD" },
  capture: true,
};

function goLive() {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://localhost:54321");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service-key");
}

beforeEach(() => {
  stripeRequest.mockReset();
  stripeRequest.mockResolvedValue({
    id: "pi_real",
    status: "succeeded",
    client_secret: "pi_real_secret",
  });
  vi.unstubAllEnvs();
  getPosDriver(); // memoize the mock; env below only changes the rail decision
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("S10: training mode never makes a real charge", () => {
  for (const key of ["sk_live_x", "sk_test_x"]) {
    it(`TRAINING_MODE=1 + ${key}: both card rails simulate`, async () => {
      goLive();
      vi.stubEnv("STRIPE_SECRET_KEY", key);
      vi.stubEnv("TRAINING_MODE", "1");
      expect(cardRailsSimulated()).toBe(true);
      expect(railIsSimulated("stripe_online")).toBe(true);
      const a = await stripeOnlineRail.createCharge(charge);
      const b = await stripeTerminalRail.createCharge(charge);
      expect(a.chargeId.startsWith("sim_")).toBe(true);
      expect(b.chargeId.startsWith("sim_")).toBe(true);
      await stripeOnlineRail.refund({ context: ctx, chargeId: "pi_x" });
      await stripeTerminalRail.refund({ context: ctx, chargeId: "pi_x" });
      expect(stripeRequest).not.toHaveBeenCalled();
    });
  }

  it("mock driver + a live key: simulated, no Stripe call", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_live_x");
    expect(cardRailsSimulated()).toBe(true);
    const r = await stripeOnlineRail.createCharge(charge);
    expect(r.chargeId.startsWith("sim_")).toBe(true);
    expect(stripeRequest).not.toHaveBeenCalled();
  });

  it("stripe-test (sk_test_, live driver, no flag): card rails DO call Stripe", async () => {
    goLive();
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
    expect(cardRailsSimulated()).toBe(false);
    const r = await stripeOnlineRail.createCharge(charge);
    expect(r.chargeId).toBe("pi_real");
    expect(r.clientSecret).toBe("pi_real_secret");
    expect(JSON.stringify(r.raw)).not.toContain("secret");
    expect(stripeRequest).toHaveBeenCalledTimes(1);
  });

  it("no Stripe key: simulated (zero-env behaviour)", () => {
    goLive();
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    expect(cardRailsSimulated()).toBe(true);
  });
});

describe("/api/ready reports the training reason", () => {
  it("includes trainingReason", async () => {
    const res = await readyGET(new Request("http://localhost/api/ready"));
    const body = await res.json();
    expect(body.trainingMode).toBe(true);
    expect(body.trainingReason).toBe("mock");
  });
});
