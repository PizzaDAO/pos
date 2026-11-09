import { describe, expect, it } from "vitest";
import { applyMovement, isUnredeemed, redeemableCents, signedAmount, verifyLedger } from "./ledger";
import type { LedgerEntry, LedgerKind } from "./types";

let n = 0;
function row(kind: LedgerKind, amount: number, after: number): LedgerEntry {
  n += 1;
  return {
    id: `e${n}`,
    account_id: "a",
    tenant_id: "t",
    location_id: null,
    kind,
    amount_cents: amount,
    balance_after_cents: after,
    order_id: null,
    payment_id: null,
    idempotency_key: `k${n}`,
    reason: null,
    actor_id: null,
    approved_by: null,
    created_at: new Date(2026, 0, 1, 0, 0, n).toISOString(),
  };
}

describe("applyMovement", () => {
  it("credits and debits with the right sign", () => {
    expect(signedAmount("issue", 500)).toBe(500);
    expect(signedAmount("refund", 500)).toBe(500);
    expect(signedAmount("redeem", 500)).toBe(-500);
    expect(signedAmount("void", 500)).toBe(-500);
    expect(applyMovement(1000, "redeem", 400)).toEqual({ ok: true, balanceAfter: 600 });
    expect(applyMovement(1000, "load", 400)).toEqual({ ok: true, balanceAfter: 1400 });
  });
  it("never goes below zero", () => {
    expect(applyMovement(1000, "redeem", 1000)).toEqual({ ok: true, balanceAfter: 0 });
    expect(applyMovement(1000, "redeem", 1001)).toEqual({ ok: false, reason: "insufficient" });
    expect(applyMovement(0, "reverse", 1)).toEqual({ ok: false, reason: "insufficient" });
  });
  it("caps credits at the max balance when given", () => {
    expect(applyMovement(90_000, "load", 10_000, 100_000)).toEqual({ ok: true, balanceAfter: 100_000 });
    expect(applyMovement(90_000, "load", 10_001, 100_000)).toEqual({ ok: false, reason: "exceeds_max" });
    expect(applyMovement(90_000, "refund", 20_000, null)).toEqual({ ok: true, balanceAfter: 110_000 });
  });
  it("rejects zero, negative and fractional amounts", () => {
    for (const a of [0, -5, 1.5, Number.NaN]) {
      expect(applyMovement(1000, "redeem", a)).toEqual({ ok: false, reason: "bad_amount" });
    }
  });
});

describe("verifyLedger", () => {
  it("re-derives the balance and checks the cache", () => {
    const rows = [row("issue", 5000, 5000), row("redeem", -2000, 3000), row("refund", 500, 3500)];
    expect(verifyLedger(rows)).toEqual({ ok: true, balanceCents: 3500 });
    expect(verifyLedger(rows, { balance_cents: 3500 }).ok).toBe(true);
    expect(verifyLedger(rows, { balance_cents: 3499 })).toMatchObject({ ok: false, error: "cached balance mismatch" });
  });
  it("catches a tampered balance_after, a wrong sign and a negative running balance", () => {
    expect(verifyLedger([row("issue", 5000, 5000), row("redeem", -2000, 3100)])).toMatchObject({ ok: false, error: "balance_after mismatch" });
    expect(verifyLedger([row("issue", 5000, 5000), row("redeem", 2000, 7000)])).toMatchObject({ ok: false, error: "wrong sign" });
    expect(verifyLedger([row("redeem", -1, -1)])).toMatchObject({ ok: false, error: "negative balance" });
  });
});

describe("void eligibility + redeemable amount", () => {
  it("only issue/load credits count as unredeemed", () => {
    expect(isUnredeemed([row("issue", 5000, 5000), row("load", 100, 5100)])).toBe(true);
    expect(isUnredeemed([row("issue", 5000, 5000), row("redeem", -1, 4999), row("refund", 1, 5000)])).toBe(false);
    expect(isUnredeemed([])).toBe(true);
  });
  it("takes the smaller of balance, amount due and the request", () => {
    expect(redeemableCents(5000, 3000)).toBe(3000);
    expect(redeemableCents(2000, 3000)).toBe(2000);
    expect(redeemableCents(5000, 3000, 1000)).toBe(1000);
    expect(redeemableCents(5000, 3000, 9000)).toBe(3000);
    expect(redeemableCents(5000, 0)).toBe(0);
    expect(redeemableCents(0, 3000)).toBe(0);
  });
});
