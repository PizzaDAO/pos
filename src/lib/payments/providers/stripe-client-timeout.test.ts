/**
 * Every Stripe call is bounded (STRIPE_TIMEOUT_MS) and a timeout is an UNKNOWN
 * outcome, never a definite failure.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  STRIPE_TIMEOUT_MS,
  StripeError,
  StripeTimeoutError,
  stripeDelete,
  stripeGet,
  stripeRequest,
} from "./stripe-client";
import { isDefiniteRefundFailure } from "../service";

/** A fetch that never answers until its signal aborts it. */
function hangingFetch() {
  return vi.fn((_url: string, init?: RequestInit) => {
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return; // would hang forever: the test fails on its timeout
      signal.addEventListener("abort", () => reject(signal.reason));
    });
  });
}

beforeEach(() => {
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_timeout");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Stripe fetch timeout", () => {
  it("defaults to 25s, under every route's 60s maxDuration", () => {
    expect(STRIPE_TIMEOUT_MS).toBe(25_000);
  });

  it("aborts a hanging POST / GET / DELETE with a StripeTimeoutError", async () => {
    const f = hangingFetch();
    vi.stubGlobal("fetch", f);
    await expect(stripeRequest("/refunds", { amount: 1 }, { timeoutMs: 20 })).rejects.toBeInstanceOf(
      StripeTimeoutError,
    );
    await expect(stripeGet("/refunds/re_1", { timeoutMs: 20 })).rejects.toBeInstanceOf(StripeTimeoutError);
    await expect(stripeDelete("/terminal/readers/tmr_1", { timeoutMs: 20 })).rejects.toBeInstanceOf(
      StripeTimeoutError,
    );
    // Every call carried a signal.
    for (const call of f.mock.calls) expect(call[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("a body that stalls after the headers times out too", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => ({
        ok: true,
        status: 200,
        json: () =>
          new Promise((_r, reject) => init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason))),
      })),
    );
    await expect(stripeGet("/refunds/re_2", { timeoutMs: 20 })).rejects.toBeInstanceOf(StripeTimeoutError);
  });

  it("a timeout is never a definite refund failure (the refund stays pending)", () => {
    const t = new StripeTimeoutError("/refunds", 25_000);
    expect(t).not.toBeInstanceOf(StripeError);
    expect(isDefiniteRefundFailure(t)).toBe(false);
    // A real 4xx refusal still is.
    expect(isDefiniteRefundFailure(new StripeError("charge disputed", 400, null))).toBe(true);
  });

  it("answers in time pass through unchanged", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ id: "re_ok" }) })),
    );
    await expect(stripeGet("/refunds/re_ok")).resolves.toEqual({ id: "re_ok" });
  });
});
