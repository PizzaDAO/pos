import { describe, expect, it } from "vitest";
import type { Order, OrderItem, Payment } from "@/lib/db";
import type { AdjustmentRecord, OrderAdjustment } from "@/lib/db/adjustment-types";
import {
  allocateCents,
  currentAdjustments,
  foodDueCents,
  lineRefundAmounts,
  normalizeAdjustments,
  planLineVoid,
  planRefundAllocation,
  recomputeTotals,
  refundableTotals,
  refundedQuantities,
  unitShares,
} from "./math";
import { needsApproval, parsePolicy, resolvePolicy } from "./policy";
import { validateReason } from "./reasons";

const line = (o: Partial<OrderItem> & { id: string; unit: number; qty: number }): OrderItem =>
  ({
    item_id: `item-${o.id}`,
    item_name: o.item_name ?? `Item ${o.id}`,
    size_id: null,
    size_name: null,
    base_price_cents: o.unit,
    modifiers: [],
    notes: null,
    voided: false,
    unit_price_cents: o.unit,
    quantity: o.qty,
    line_total_cents: o.unit * o.qty,
    fired_at: null,
    ...o,
  }) as OrderItem;

function order(items: OrderItem[], over: Partial<Order> = {}, taxBps = 0): Order {
  const subtotal = items.filter((i) => !i.voided).reduce((n, i) => n + i.unit_price_cents * i.quantity, 0);
  const discount = over.totals?.discount_cents ?? 0;
  const taxable = subtotal - discount;
  const tax = Math.floor((taxable * taxBps) / 10_000 + 0.5);
  return {
    id: "o1",
    tenant_id: "t",
    location_id: "l",
    status: "placed",
    channel: "in_store",
    currency: "USD",
    items,
    discount_cents: discount,
    totals: {
      subtotal_cents: subtotal,
      discount_cents: discount,
      taxable_cents: taxable,
      tax_cents: tax,
      tip_cents: 0,
      total_cents: taxable + tax,
    },
    notes: null,
    order_number: "A-1",
    version: 1,
    created_at: "2026-11-09T12:00:00.000Z",
    updated_at: "2026-11-09T12:00:00.000Z",
    ...over,
  } as Order;
}

const pay = (o: Partial<Payment> & { id: string }): Payment =>
  ({
    order_id: "o1",
    tenant_id: "t",
    location_id: "l",
    rail: "cash",
    status: "captured",
    amount_cents: 1000,
    tip_cents: 0,
    refunded_cents: 0,
    application_fee_cents: 0,
    currency: "USD",
    charge_id: null,
    connect_account_id: null,
    crypto_tx_hash: null,
    crypto_chain: null,
    cash_tendered_cents: null,
    cash_change_cents: null,
    simulated: false,
    raw: null,
    created_at: "2026-11-09T12:00:00.000Z",
    updated_at: "2026-11-09T12:00:00.000Z",
    ...o,
  }) as Payment;

describe("allocateCents", () => {
  it("always sums to the total (largest remainder, ties to the earlier index)", () => {
    expect(allocateCents(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(allocateCents(0, [5, 5])).toEqual([0, 0]);
    expect(allocateCents(7, [0, 0])).toEqual([4, 3]);
    for (const total of [1, 99, 1001, 12345]) {
      const parts = allocateCents(total, [3, 7, 11, 0, 2]);
      expect(parts.reduce((a, b) => a + b, 0)).toBe(total);
    }
  });
});

describe("unitShares / lineRefundAmounts", () => {
  // $10 x2 + $7.99 x3, 10% off, 8.25% tax.
  const items = [line({ id: "a", unit: 1000, qty: 2 }), line({ id: "b", unit: 799, qty: 3 })];
  const base = order(items, {}, 825);
  const subtotal = 2000 + 2397;
  const o = order(items, {
    totals: {
      subtotal_cents: subtotal,
      discount_cents: 440,
      taxable_cents: subtotal - 440,
      tax_cents: Math.floor(((subtotal - 440) * 825) / 10_000 + 0.5),
      tip_cents: 0,
      total_cents: subtotal - 440 + Math.floor(((subtotal - 440) * 825) / 10_000 + 0.5),
    },
  });

  it("every unit of every line sums to exactly the amount due", () => {
    for (const ord of [base, o]) {
      const shares = unitShares(ord);
      const sum = [...shares.values()].flat().reduce((a, b) => a + b, 0);
      expect(sum).toBe(foodDueCents(ord));
    }
  });

  it("refunding a line in two halves returns what refunding it at once would", () => {
    const whole = lineRefundAmounts(o, [{ line_id: "b", quantity: 3 }], new Map())[0]!.amount_cents;
    const first = lineRefundAmounts(o, [{ line_id: "b", quantity: 1 }], new Map())[0]!.amount_cents;
    const rest = lineRefundAmounts(o, [{ line_id: "b", quantity: 2 }], new Map([["b", 1]]))[0]!
      .amount_cents;
    expect(first + rest).toBe(whole);
  });

  it("refuses more units than are left, unknown and voided lines, and duplicates", () => {
    expect(() => lineRefundAmounts(o, [{ line_id: "a", quantity: 3 }], new Map())).toThrow(/Only 2/);
    expect(() => lineRefundAmounts(o, [{ line_id: "a", quantity: 1 }], new Map([["a", 2]]))).toThrow(
      /Only 0/,
    );
    expect(() => lineRefundAmounts(o, [{ line_id: "zz", quantity: 1 }], new Map())).toThrow();
    const voided = order([line({ id: "a", unit: 1000, qty: 1, voided: true }), line({ id: "c", unit: 500, qty: 1 })]);
    expect(() => lineRefundAmounts(voided, [{ line_id: "a", quantity: 1 }], new Map())).toThrow();
    expect(() =>
      lineRefundAmounts(o, [
        { line_id: "a", quantity: 1 },
        { line_id: "a", quantity: 1 },
      ], new Map()),
    ).toThrow(/twice/);
  });

  it("a comped line is worth only what is left of it", () => {
    const comp: OrderAdjustment = {
      id: "c1",
      type: "comp",
      source: "pos.manual",
      label: "Comp",
      percent_bps: null,
      amount_cents: 1000,
      line_ids: ["a"],
      quantity: 1,
      reason_code: "quality",
      reason_text: null,
      staff_id: null,
      approved_by: null,
      created_at: "",
    };
    const withComp = order([line({ id: "a", unit: 1000, qty: 2 }), line({ id: "b", unit: 1000, qty: 1 })], {
      adjustments: [comp],
      totals: {
        subtotal_cents: 3000,
        discount_cents: 1000,
        taxable_cents: 2000,
        tax_cents: 0,
        tip_cents: 0,
        total_cents: 2000,
      },
    });
    const a = lineRefundAmounts(withComp, [{ line_id: "a", quantity: 2 }], new Map())[0]!.amount_cents;
    const b = lineRefundAmounts(withComp, [{ line_id: "b", quantity: 1 }], new Map())[0]!.amount_cents;
    expect(a).toBe(1000);
    expect(b).toBe(1000);
  });

  it("refundedQuantities ignores failed refunds and non-refund rows", () => {
    const rec = (o: Partial<AdjustmentRecord>) =>
      ({ kind: "refund", status: "completed", lines: [], ...o }) as AdjustmentRecord;
    const q = refundedQuantities([
      rec({ lines: [{ line_id: "a", quantity: 1, amount_cents: 1 }] }),
      rec({ status: "failed", lines: [{ line_id: "a", quantity: 5, amount_cents: 1 }] }),
      rec({ status: "partial", lines: [{ line_id: "a", quantity: 1, amount_cents: 1 }] }),
      rec({ kind: "void_line", lines: [{ line_id: "a", quantity: 9, amount_cents: 1 }] }),
    ]);
    expect(q.get("a")).toBe(2);
  });
});

describe("planRefundAllocation", () => {
  const card = pay({ id: "card", rail: "stripe_terminal", amount_cents: 1500, tip_cents: 300, created_at: "2026-11-09T12:01:00Z" });
  const cash = pay({ id: "cash", rail: "cash", amount_cents: 1000, created_at: "2026-11-09T12:02:00Z" });

  it("takes card first, then cash, base and tip kept apart", () => {
    const plan = planRefundAllocation([cash, card], 2000, 200)!;
    expect(plan.map((p) => [p.payment.id, p.baseCents, p.tipCents])).toEqual([
      ["card", 1500, 200],
      ["cash", 500, 0],
    ]);
  });

  it("never plans past what is left (base and tip separately)", () => {
    expect(planRefundAllocation([cash, card], 2501, 0)).toBeNull();
    expect(planRefundAllocation([cash, card], 0, 301)).toBeNull();
    const partly = pay({ ...card, refunded_cents: 500, tip_refunded_cents: 300 });
    expect(refundableTotals([partly])).toEqual({ baseCents: 1300, tipCents: 0 });
    expect(planRefundAllocation([partly], 0, 1)).toBeNull();
  });

  it("legacy rows (no tip_refunded_cents) count refunds off the tip first", () => {
    const legacy = pay({ ...card, refunded_cents: 400 });
    expect(refundableTotals([legacy])).toEqual({ baseCents: 1400, tipCents: 0 });
  });

  it("honours onlyPaymentId / preferPaymentId and skips external, failed and refunded tenders", () => {
    expect(planRefundAllocation([cash, card], 500, 0, { onlyPaymentId: "cash" })![0]!.payment.id).toBe("cash");
    expect(planRefundAllocation([cash, card], 1600, 0, { onlyPaymentId: "card" })).toBeNull();
    expect(planRefundAllocation([cash, card], 500, 0, { preferPaymentId: "cash" })![0]!.payment.id).toBe("cash");
    const ext = pay({ id: "ext", rail: "external" });
    const failed = pay({ id: "f", rail: "stripe_terminal", status: "failed" });
    const done = pay({ id: "d", status: "refunded", refunded_cents: 1000 });
    expect(planRefundAllocation([ext, failed, done], 1, 0)).toBeNull();
  });
});

describe("voids, comps, discounts", () => {
  it("a partial void splits the line and keeps the voided units for the kitchen", () => {
    const o = order([line({ id: "a", unit: 1000, qty: 3, fired_at: "2026-11-09T12:00:01Z" })]);
    const plan = planLineVoid(o, [{ line_id: "a", quantity: 1 }], () => "new");
    expect(plan.splits).toEqual([{ line_id: "a", new_line_id: "new", keep_quantity: 2, void_quantity: 1 }]);
    expect(plan.items.map((i) => [i.id, i.quantity, i.voided])).toEqual([
      ["a", 2, false],
      ["new", 1, true],
    ]);
    expect(plan.voidedCents).toBe(1000);
    expect(plan.fired).toBe(true);
    const whole = planLineVoid(o, [{ line_id: "a" }], () => "x");
    expect(whole.voidLineIds).toEqual(["a"]);
    expect(whole.fired).toBe(true);
    expect(() => planLineVoid(o, [{ line_id: "a", quantity: 4 }], () => "x")).toThrow();
  });

  it("normalizeAdjustments drops comps of voided lines, re-takes % and clamps fixed discounts", () => {
    const items = [line({ id: "a", unit: 1000, qty: 1 }), line({ id: "b", unit: 500, qty: 2, voided: true })];
    const adj = (o: Partial<OrderAdjustment>): OrderAdjustment =>
      ({ source: "pos.manual", label: "x", percent_bps: null, line_ids: null, reason_code: "promotion", reason_text: null, staff_id: null, approved_by: null, created_at: "", ...o }) as OrderAdjustment;
    const out = normalizeAdjustments(items, [
      adj({ id: "c", type: "comp", amount_cents: 1000, line_ids: ["b"] }),
      adj({ id: "p", type: "discount", percent_bps: 1000, amount_cents: 300 }),
      adj({ id: "f", type: "discount", amount_cents: 5000 }),
    ]);
    expect(out.map((a) => [a.id, a.amount_cents])).toEqual([
      ["p", 100],
      ["f", 900],
    ]);
    expect(out.reduce((n, a) => n + a.amount_cents, 0)).toBeLessThanOrEqual(1000);
  });

  it("recomputeTotals re-taxes at the location rate, or the order's own rate when that differs", () => {
    const items = [line({ id: "a", unit: 1000, qty: 2 })];
    const o = order(items, {}, 825); // tax 165 on 2000
    expect(o.totals.tax_cents).toBe(165);
    const after = [line({ id: "a", unit: 1000, qty: 1 })];
    expect(recomputeTotals(o, after, [], 825)).toMatchObject({ subtotal_cents: 1000, tax_cents: 83, total_cents: 1083 });
    // The location rate changed since the sale: keep the order's effective rate.
    expect(recomputeTotals(o, after, [], 1000)).toMatchObject({ tax_cents: 83, total_cents: 1083 });
    // Tax-exempt orders stay at zero.
    const exempt = { ...o, core_ext: { tax_exempt: true } } as Order;
    expect(recomputeTotals(exempt, after, [], 825).tax_cents).toBe(0);
  });

  it("currentAdjustments synthesizes a legacy discount", () => {
    const o = order([line({ id: "a", unit: 1000, qty: 1 })], {
      totals: { subtotal_cents: 1000, discount_cents: 200, taxable_cents: 800, tax_cents: 0, tip_cents: 0, total_cents: 800 },
    });
    expect(currentAdjustments(o)).toMatchObject([{ id: "adj_discount", type: "discount", amount_cents: 200 }]);
  });
});

describe("policy + reasons", () => {
  const policy = resolvePolicy({ refund_approval_cents: 2000, comp_approval_cents: 500, void_approval_cents: 1000 });
  it("managers never need approval; cashiers above the threshold do; unfired voids never", () => {
    expect(needsApproval({ policy, kind: "refund", amountCents: 99999, role: "manager" })).toBe(false);
    expect(needsApproval({ policy, kind: "refund", amountCents: 2000, role: "cashier" })).toBe(false);
    expect(needsApproval({ policy, kind: "refund", amountCents: 2001, role: "cashier" })).toBe(true);
    expect(needsApproval({ policy, kind: "comp", amountCents: 501, role: "cashier" })).toBe(true);
    expect(needsApproval({ policy, kind: "void_line", amountCents: 5000, role: "cashier", fired: false })).toBe(false);
    expect(needsApproval({ policy, kind: "void_line", amountCents: 5000, role: "cashier", fired: true })).toBe(true);
  });
  it("defaults to 0 (every refund needs a manager) and rejects bad input", () => {
    expect(resolvePolicy(undefined)).toEqual({ refund_approval_cents: 0, comp_approval_cents: 0, void_approval_cents: 0 });
    expect(resolvePolicy({ refund_approval_cents: -5 } as never).refund_approval_cents).toBe(0);
    expect(parsePolicy({ refund_approval_cents: 1.5, comp_approval_cents: 0, void_approval_cents: 0 })).toBeNull();
    expect(parsePolicy({ refund_approval_cents: 100, comp_approval_cents: 0, void_approval_cents: 0 })).not.toBeNull();
  });
  it("a reason is required; Other needs text", () => {
    expect(validateReason("refund", undefined, undefined).ok).toBe(false);
    expect(validateReason("refund", "made_up", undefined).ok).toBe(false);
    expect(validateReason("refund", "other", "  ").ok).toBe(false);
    expect(validateReason("refund", "other", "burnt crust")).toEqual({ ok: true, code: "other", text: "burnt crust" });
    expect(validateReason("void_line", "entry_error", null)).toEqual({ ok: true, code: "entry_error", text: null });
  });
});
