import { describe, it, expect } from "vitest";
import {
  computeOrderTotals,
  computeSubtotalCents,
  computeUnitPriceCents,
  roundHalfUp,
  withLinePricing,
} from "@/lib/pricing";
import { buildLine, placementPriceCents } from "@/lib/build-line";
import type {
  ItemSize,
  MenuItemDetail,
  Modifier,
  ModifierGroup,
  OrderItem,
  OrderItemModifier,
} from "@/lib/db";

/** Integer-minor-unit invariant: every money field is a safe integer. */
function expectIntegerCents(...values: number[]): void {
  for (const v of values) {
    expect(Number.isInteger(v), `expected integer cents, got ${v}`).toBe(true);
  }
}

const mod = (
  price: number,
  placement: OrderItemModifier["placement"],
): OrderItemModifier => ({
  group_id: "g1",
  group_name: "Toppings",
  modifier_id: `m-${price}-${placement}`,
  modifier_name: "Topping",
  price_cents: price,
  placement,
});

const line = (over: Partial<OrderItem> = {}): OrderItem =>
  withLinePricing({
    id: "l1",
    item_id: "i1",
    item_name: "Pizza",
    size_id: "s1",
    size_name: "L",
    base_price_cents: 1800,
    quantity: 1,
    modifiers: [],
    notes: null,
    voided: false,
    unit_price_cents: 0,
    line_total_cents: 0,
    ...over,
  });

describe("computeUnitPriceCents", () => {
  it("sums base price and all modifier prices", () => {
    const unit = computeUnitPriceCents(1800, [
      mod(200, "whole"),
      mod(150, "whole"),
    ]);
    expect(unit).toBe(2150);
    expectIntegerCents(unit);
  });

  it("is base price with no modifiers", () => {
    expect(computeUnitPriceCents(1500, [])).toBe(1500);
  });
});

describe("half-and-half charging", () => {
  it("charges a half topping at ceil(half) the whole price", () => {
    // $3.00 whole topping → $1.50 per half.
    expect(placementPriceCents(300, "left")).toBe(150);
    expect(placementPriceCents(300, "right")).toBe(150);
    expect(placementPriceCents(300, "whole")).toBe(300);
  });

  it("rounds an odd half price UP to the cent", () => {
    // $2.75 whole → 137.5 → ceil → 138 per half.
    expect(placementPriceCents(275, "left")).toBe(138);
  });

  it("left + right of the SAME topping equals (or exceeds by ≤1¢) a whole", () => {
    for (const whole of [100, 101, 199, 200, 275, 333, 999]) {
      const halves =
        placementPriceCents(whole, "left") +
        placementPriceCents(whole, "right");
      // Half is rounded up, so two halves are within 1¢ of a whole and never
      // CHEAPER than the whole (no revenue leak from splitting).
      expect(halves).toBeGreaterThanOrEqual(whole);
      expect(halves - whole).toBeLessThanOrEqual(1);
    }
  });

  it("prices a half-and-half pizza line via buildLine (left + right toppings)", () => {
    const size: ItemSize = {
      id: "s-l",
      item_id: "i-marg",
      name: "Large",
      price_cents: 1800,
      sort_order: 1,
    };
    const group: ModifierGroup = {
      id: "g-top",
      tenant_id: "t1",
      name: "Toppings",
      min_select: 0,
      max_select: 10,
      supports_half: true,
    };
    const pepperoni: Modifier = {
      id: "mod-pep",
      group_id: "g-top",
      name: "Pepperoni",
      price_cents: 300,
      sort_order: 1,
    };
    const mushroom: Modifier = {
      id: "mod-mush",
      group_id: "g-top",
      name: "Mushroom",
      price_cents: 250,
      sort_order: 2,
    };
    const item = {
      id: "i-marg",
      name: "Build-your-own",
      station: "oven",
    } as unknown as MenuItemDetail;

    const built = buildLine({
      item,
      size,
      quantity: 1,
      notes: "",
      selections: [
        { group, modifier: pepperoni, placement: "left" }, // 150
        { group, modifier: mushroom, placement: "right" }, // 125
      ],
    });

    // 1800 base + 150 (½ pepperoni) + 125 (½ mushroom) = 2075
    expect(built.unit_price_cents).toBe(2075);
    expect(built.line_total_cents).toBe(2075);
    expectIntegerCents(built.unit_price_cents, built.line_total_cents);
  });
});

describe("size deltas", () => {
  it("a larger size raises the base price by exactly its price delta", () => {
    const small = line({ base_price_cents: 1200 });
    const large = line({ base_price_cents: 1800 });
    expect(large.unit_price_cents - small.unit_price_cents).toBe(600);
  });
});

describe("computeSubtotalCents + line totals", () => {
  it("multiplies unit by quantity and sums non-voided lines", () => {
    const items = [
      line({ id: "a", base_price_cents: 1000, quantity: 2 }), // 2000
      line({ id: "b", base_price_cents: 500, quantity: 3 }), // 1500
    ];
    expect(computeSubtotalCents(items)).toBe(3500);
  });

  it("excludes voided lines from subtotal and zeroes their line total", () => {
    const voided = line({
      id: "v",
      base_price_cents: 1000,
      quantity: 2,
      voided: true,
    });
    expect(voided.line_total_cents).toBe(0);
    expect(
      computeSubtotalCents([voided, line({ id: "k", base_price_cents: 800 })]),
    ).toBe(800);
  });
});

describe("computeOrderTotals", () => {
  it("applies discount before tax and never drifts off integer cents", () => {
    const items = [line({ base_price_cents: 2000, quantity: 1 })];
    const totals = computeOrderTotals({
      items,
      discountCents: 500,
      taxRateBps: 825, // 8.25%
      tipCents: 0,
    });
    // subtotal 2000, discount 500 → taxable 1500, tax = round(1500*825/10000)=124
    expect(totals.subtotal_cents).toBe(2000);
    expect(totals.discount_cents).toBe(500);
    expect(totals.taxable_cents).toBe(1500);
    expect(totals.tax_cents).toBe(124);
    expect(totals.total_cents).toBe(1624);
    expectIntegerCents(
      totals.subtotal_cents,
      totals.discount_cents,
      totals.taxable_cents,
      totals.tax_cents,
      totals.tip_cents,
      totals.total_cents,
    );
  });

  it("clamps a discount larger than the subtotal", () => {
    const items = [line({ base_price_cents: 1000 })];
    const totals = computeOrderTotals({
      items,
      discountCents: 9999,
      taxRateBps: 0,
    });
    expect(totals.discount_cents).toBe(1000);
    expect(totals.taxable_cents).toBe(0);
    expect(totals.total_cents).toBe(0);
  });

  it("adds a tip on top of taxable + tax", () => {
    const items = [line({ base_price_cents: 1000 })];
    const totals = computeOrderTotals({
      items,
      discountCents: 0,
      taxRateBps: 1000,
      tipCents: 300,
    });
    // taxable 1000, tax 100, tip 300 → 1400
    expect(totals.total_cents).toBe(1400);
  });

  it("never produces fractional tax (round-half-up at the bps multiply)", () => {
    // 1333 * 825 / 10000 = 109.97… → 110
    const totals = computeOrderTotals({
      items: [line({ base_price_cents: 1333 })],
      discountCents: 0,
      taxRateBps: 825,
    });
    expect(totals.tax_cents).toBe(110);
    expectIntegerCents(totals.tax_cents);
  });
});

describe("roundHalfUp", () => {
  it("rounds .5 up and stays integer", () => {
    expect(roundHalfUp(0.5)).toBe(1);
    expect(roundHalfUp(1.4)).toBe(1);
    expect(roundHalfUp(2.5)).toBe(3);
    expectIntegerCents(roundHalfUp(123.49), roundHalfUp(123.5));
  });
});
