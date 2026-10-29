import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyStripeWebhook } from "./providers/stripe-client";

function sign(secret: string, t: number, body: string): string {
  return createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
}

describe("verifyStripeWebhook", () => {
  const secret = "whsec_test_secret";
  const body = JSON.stringify({ id: "evt_1", type: "invoice.paid" });
  const now = 1_800_000_000;

  it("accepts a fresh, correctly signed event", () => {
    const header = `t=${now},v1=${sign(secret, now, body)}`;
    expect(verifyStripeWebhook(body, header, secret, now)).toBe(true);
  });

  it("accepts any v1 signature (secret rotation)", () => {
    const header = `t=${now},v1=${"0".repeat(64)},v1=${sign(secret, now, body)}`;
    expect(verifyStripeWebhook(body, header, secret, now)).toBe(true);
  });

  it("rejects replays outside the tolerance window", () => {
    const old = now - 3600;
    const header = `t=${old},v1=${sign(secret, old, body)}`;
    expect(verifyStripeWebhook(body, header, secret, now)).toBe(false);
  });

  it("rejects a wrong secret, a tampered body, and a missing secret", () => {
    const header = `t=${now},v1=${sign(secret, now, body)}`;
    expect(verifyStripeWebhook(body, header, "whsec_other", now)).toBe(false);
    expect(verifyStripeWebhook(`${body} `, header, secret, now)).toBe(false);
    expect(verifyStripeWebhook(body, header, null, now)).toBe(false);
    expect(verifyStripeWebhook(body, null, secret, now)).toBe(false);
  });
});
