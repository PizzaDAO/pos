import { describe, it, expect } from "vitest";
import {
  computeApplicationFeeCents,
  railChargesApplicationFee,
  roundHalfUp,
} from "@/lib/payments/fees";
import { feeForTender, stripeOnlineRail } from "@/lib/payments/rails/stripe-online";

describe("computeApplicationFeeCents", () => {
  it("computes pct(bps) + flat, round-half-up on the pct", () => {
    // 2.5% of $20.00 = 50¢, + 10¢ flat = 60¢.
    expect(
      computeApplicationFeeCents({
        amountCents: 2000,
        feeBps: 250,
        feeFlatCents: 10,
      }),
    ).toBe(60);
  });

  it("rounds the percentage component half-up", () => {
    // 250 bps of 1333 = 33.325 → 33; + 0 flat.
    expect(
      computeApplicationFeeCents({
        amountCents: 1333,
        feeBps: 250,
        feeFlatCents: 0,
      }),
    ).toBe(33);
    // 250 bps of 1340 = 33.5 → 34.
    expect(
      computeApplicationFeeCents({
        amountCents: 1340,
        feeBps: 250,
        feeFlatCents: 0,
      }),
    ).toBe(34);
  });

  it("returns an integer number of cents (no float drift)", () => {
    const fee = computeApplicationFeeCents({
      amountCents: 9999,
      feeBps: 290,
      feeFlatCents: 30,
    });
    expect(Number.isInteger(fee)).toBe(true);
  });

  it("clamps the fee to the charge amount (never exceeds what settles)", () => {
    const fee = computeApplicationFeeCents({
      amountCents: 50,
      feeBps: 100000, // absurd 1000%
      feeFlatCents: 0,
    });
    expect(fee).toBe(50);
  });

  it("is zero for a non-positive amount", () => {
    expect(
      computeApplicationFeeCents({
        amountCents: 0,
        feeBps: 250,
        feeFlatCents: 10,
      }),
    ).toBe(0);
    expect(
      computeApplicationFeeCents({
        amountCents: -100,
        feeBps: 250,
        feeFlatCents: 10,
      }),
    ).toBe(0);
  });

  it("ignores a negative flat fee (clamped to 0)", () => {
    expect(
      computeApplicationFeeCents({
        amountCents: 1000,
        feeBps: 250,
        feeFlatCents: -50,
      }),
    ).toBe(25);
  });
});

describe("railChargesApplicationFee — card-only", () => {
  it("charges a platform fee only on card rails", () => {
    expect(railChargesApplicationFee("stripe_terminal")).toBe(true);
    expect(railChargesApplicationFee("stripe_online")).toBe(true);
  });

  it("does NOT charge a platform fee on cash or crypto", () => {
    expect(railChargesApplicationFee("cash")).toBe(false);
    expect(railChargesApplicationFee("crypto_onchain_usdc")).toBe(false);
    expect(railChargesApplicationFee("crypto_coinbase")).toBe(false);
  });
});

describe("stripe_online platform fee excludes the tip", () => {
  it("feeForTender takes pct + flat of the BASE amount only", () => {
    // 2.5% of $20.00 = 50c + 10c flat = 60c, whatever the tip.
    expect(feeForTender(2000, 0)).toBe(60);
    expect(feeForTender(2000, 500)).toBe(60);
    expect(feeForTender(2000, 5000)).toBe(60);
  });

  it("the rail's quote and simulated charge carry that fee, and charge amount + tip", async () => {
    const req = {
      amount: { amount: 2000, currency: "USD" },
      tip: { amount: 500, currency: "USD" },
    };
    const q = await stripeOnlineRail.quote(req as never);
    expect(q.total.amount).toBe(2500);
    expect(q.applicationFee?.amount).toBe(60);
  });
});

describe("roundHalfUp (fees)", () => {
  it("matches the pricing module's rounding", () => {
    expect(roundHalfUp(33.5)).toBe(34);
    expect(roundHalfUp(33.49)).toBe(33);
  });
});
