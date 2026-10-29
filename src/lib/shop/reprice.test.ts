import { describe, it, expect } from "vitest";
import type { Menu, OrderItem } from "@/lib/db";
import { RepriceError, repriceItems } from "./reprice";

const T = "t1";
const menu: Menu = {
  tenantId: T,
  locationId: "l1",
  categories: [
    {
      id: "c1",
      tenant_id: T,
      name: "Pizza",
      sort_order: 1,
      items: [
        {
          id: "i-pizza",
          tenant_id: T,
          category_id: "c1",
          name: "Margherita",
          description: null,
          is_half_and_half_capable: true,
          station: "oven",
          sizes: [
            { id: "s-m", item_id: "i-pizza", name: "M", price_cents: 1400, sort_order: 1 },
          ],
          modifierGroups: [
            {
              id: "g-crust",
              tenant_id: T,
              name: "Crust",
              min_select: 1,
              max_select: 1,
              supports_half: false,
              modifiers: [
                { id: "m-thin", group_id: "g-crust", name: "Thin", price_cents: 0, sort_order: 1 },
                { id: "m-deep", group_id: "g-crust", name: "Deep", price_cents: 200, sort_order: 2 },
              ],
            },
            {
              id: "g-top",
              tenant_id: T,
              name: "Toppings",
              min_select: 0,
              max_select: 2,
              supports_half: true,
              modifiers: [
                { id: "m-mush", group_id: "g-top", name: "Mushrooms", price_cents: 151, sort_order: 1 },
                { id: "m-pep", group_id: "g-top", name: "Pepperoni", price_cents: 200, sort_order: 2 },
                { id: "m-olive", group_id: "g-top", name: "Olives", price_cents: 100, sort_order: 3 },
              ],
            },
          ],
        },
        {
          id: "i-soda",
          tenant_id: T,
          category_id: "c1",
          name: "Soda",
          description: null,
          is_half_and_half_capable: false,
          station: "none",
          sizes: [],
          modifierGroups: [
            {
              id: "g-half",
              tenant_id: T,
              name: "Flavor",
              min_select: 0,
              max_select: 1,
              supports_half: true, // group says yes, item says no
              modifiers: [
                { id: "m-cola", group_id: "g-half", name: "Cola", price_cents: 0, sort_order: 1 },
              ],
            },
          ],
        },
      ],
    },
  ],
};

function mod(
  group_id: string,
  modifier_id: string,
  placement: "whole" | "left" | "right" = "whole",
  price_cents = 0,
) {
  return {
    group_id,
    group_name: "x",
    modifier_id,
    modifier_name: "x",
    price_cents,
    placement,
  };
}

function first<T>(xs: T[]): T {
  const x = xs[0];
  if (x === undefined) throw new Error("expected at least one element");
  return x;
}

function line(over: Partial<OrderItem> = {}): OrderItem {
  return {
    id: "line-1",
    item_id: "i-pizza",
    item_name: "Margherita",
    size_id: "s-m",
    size_name: "M",
    base_price_cents: 1400,
    quantity: 1,
    modifiers: [mod("g-crust", "m-thin")],
    notes: null,
    voided: false,
    unit_price_cents: 1400,
    line_total_cents: 1400,
    ...over,
  };
}

describe("repriceItems", () => {
  it("overwrites tampered base and modifier prices, names and station", () => {
    const out = first(repriceItems(menu, [
      line({
        item_name: "Free pizza",
        base_price_cents: 1,
        station: "none",
        modifiers: [
          mod("g-crust", "m-deep", "whole", 0),
          mod("g-top", "m-pep", "whole", 0),
        ],
        unit_price_cents: 1,
        line_total_cents: 1,
      }),
    ]));
    expect(out.item_name).toBe("Margherita");
    expect(out.station).toBe("oven");
    expect(out.base_price_cents).toBe(1400);
    expect(out.modifiers.map((m) => m.price_cents)).toEqual([200, 200]);
    expect(out.unit_price_cents).toBe(1800);
    expect(out.line_total_cents).toBe(1800);
  });

  it("rejects an unknown item, an 86'd (absent) item and a bad size", () => {
    expect(() => repriceItems(menu, [line({ item_id: "gone" })])).toThrow(
      RepriceError,
    );
    expect(() => repriceItems(menu, [line({ size_id: "s-bad" })])).toThrow(
      RepriceError,
    );
  });

  it("rejects a half placement on a non-half group or item", () => {
    expect(() =>
      repriceItems(menu, [
        line({ modifiers: [mod("g-crust", "m-thin", "left")] }),
      ]),
    ).toThrow(/half/);
    expect(() =>
      repriceItems(menu, [
        line({
          item_id: "i-soda",
          size_id: null,
          modifiers: [mod("g-half", "m-cola", "left")],
        }),
      ]),
    ).toThrow(/half/);
  });

  it.each([0, -1, 1e6, 1.5, Number.NaN])("rejects quantity %s", (q) => {
    expect(() => repriceItems(menu, [line({ quantity: q })])).toThrow(
      RepriceError,
    );
  });

  it("enforces max_select and min_select", () => {
    expect(() =>
      repriceItems(menu, [
        line({
          modifiers: [
            mod("g-crust", "m-thin"),
            mod("g-top", "m-mush"),
            mod("g-top", "m-pep"),
            mod("g-top", "m-olive"),
          ],
        }),
      ]),
    ).toThrow(/at most/);
    expect(() => repriceItems(menu, [line({ modifiers: [] })])).toThrow(
      /at least/,
    );
  });

  it("rejects a modifier from a group not linked to the item", () => {
    expect(() =>
      repriceItems(menu, [
        line({
          modifiers: [mod("g-crust", "m-thin"), mod("g-half", "m-cola")],
        }),
      ]),
    ).toThrow(RepriceError);
  });

  it("charges left+right halves of one topping the same as whole", () => {
    const whole = first(repriceItems(menu, [
      line({ modifiers: [mod("g-crust", "m-thin"), mod("g-top", "m-mush")] }),
    ]));
    const halves = first(repriceItems(menu, [
      line({
        modifiers: [
          mod("g-crust", "m-thin"),
          mod("g-top", "m-mush", "left"),
          mod("g-top", "m-mush", "right"),
        ],
      }),
    ]));
    // 151 whole; halves ceil(151/2)=76 each = 152 (builder rounding, 1c apart).
    expect(whole.unit_price_cents).toBe(1551);
    expect(halves.unit_price_cents).toBe(1400 + 76 + 76);
  });

  it("rejects duplicate or mixed whole+half selections of one topping", () => {
    expect(() =>
      repriceItems(menu, [
        line({
          modifiers: [
            mod("g-crust", "m-thin"),
            mod("g-top", "m-mush", "whole"),
            mod("g-top", "m-mush", "left"),
          ],
        }),
      ]),
    ).toThrow(/more than once/);
  });

  it("drops voided lines, trims notes and keeps the client line id", () => {
    const out = repriceItems(menu, [
      line({ id: "keep", notes: `  ${"x".repeat(300)}  ` }),
      line({ id: "gone", voided: true, item_id: "bogus" }),
    ]);
    expect(out).toHaveLength(1);
    const kept = first(out);
    expect(kept.id).toBe("keep");
    expect(kept.notes).toHaveLength(200);
    expect(kept.voided).toBe(false);
  });
});
