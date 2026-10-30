import { describe, expect, it } from "vitest";
import {
  DEMO_LOCATION_DOWNTOWN_ID,
  DEMO_LOCATION_UPTOWN_ID,
  DEMO_TENANT_ID,
  getPosDriver,
} from "@/lib/db";
import { priceOrder } from "./order-pricing";
import { repriceOrderItems, RepriceError } from "./reprice";

/**
 * Server repricing ignores every client-supplied price and rebuilds each line
 * from the location's menu (size base + modifier prices with the half-and-half
 * rule). Seed: Pepperoni Large = 2099; Mushrooms/Onions = 150 whole (75 half);
 * Deep dish crust = 200; Toppings group supports halves, Crust does not.
 */
const PEPPERONI = "30000000-0000-0000-0000-000000000002";
const PEPPERONI_LARGE = "40000000-0000-0000-0000-000000000013";
const MARGHERITA_SMALL = "40000000-0000-0000-0000-000000000001";
const CRUST = "50000000-0000-0000-0000-000000000001";
const DEEP_DISH = "60000000-0000-0000-0000-000000000003";
const TOPPINGS = "50000000-0000-0000-0000-000000000003";
const MUSHROOMS = "60000000-0000-0000-0000-000000000021";
const ONIONS = "60000000-0000-0000-0000-000000000022";
const GARLIC_KNOTS = "30000000-0000-0000-0000-000000000030";

/** A Pepperoni Large half-mushroom / half-onion with a deep-dish crust. */
function tamperedLine(overrides: Record<string, unknown> = {}) {
  return {
    id: "line-1",
    item_id: PEPPERONI,
    item_name: "Free Pizza",
    size_id: PEPPERONI_LARGE,
    size_name: "Large",
    base_price_cents: 1, // tampered
    quantity: 2,
    modifiers: [
      {
        group_id: CRUST,
        group_name: "x",
        modifier_id: DEEP_DISH,
        modifier_name: "x",
        price_cents: 0, // tampered
        placement: "whole",
      },
      {
        group_id: TOPPINGS,
        group_name: "x",
        modifier_id: MUSHROOMS,
        modifier_name: "x",
        price_cents: -500, // tampered
        placement: "left",
      },
      {
        group_id: TOPPINGS,
        group_name: "x",
        modifier_id: ONIONS,
        modifier_name: "x",
        price_cents: 0,
        placement: "right",
      },
    ],
    notes: null,
    voided: false,
    unit_price_cents: 1, // tampered
    line_total_cents: 2, // tampered
    ...overrides,
  };
}

async function demoMenu() {
  return getPosDriver().getMenu(DEMO_TENANT_ID, DEMO_LOCATION_DOWNTOWN_ID);
}

describe("repriceOrderItems", () => {
  it("ignores tampered client prices and re-prices from the menu", async () => {
    const [line] = repriceOrderItems(await demoMenu(), [tamperedLine()]);
    expect(line).toBeDefined();
    // 2099 base + 200 deep dish + 75 (half mushrooms) + 75 (half onions)
    expect(line!.base_price_cents).toBe(2099);
    expect(line!.unit_price_cents).toBe(2099 + 200 + 75 + 75);
    expect(line!.line_total_cents).toBe((2099 + 200 + 75 + 75) * 2);
    expect(line!.item_name).toBe("Pepperoni");
    expect(line!.modifiers.map((m) => m.price_cents)).toEqual([200, 75, 75]);
    expect(line!.modifiers[0]!.modifier_name).toBe("Deep dish");
  });

  it("rejects an unknown item, a size from another item, and a foreign modifier", async () => {
    const menu = await demoMenu();
    expect(() =>
      repriceOrderItems(menu, [tamperedLine({ item_id: "not-a-menu-item" })]),
    ).toThrow(RepriceError);
    expect(() =>
      repriceOrderItems(menu, [tamperedLine({ size_id: MARGHERITA_SMALL })]),
    ).toThrow(RepriceError);
    expect(() =>
      repriceOrderItems(menu, [
        tamperedLine({
          modifiers: [
            {
              group_id: TOPPINGS,
              modifier_id: "60000000-0000-0000-0000-999999999999",
              price_cents: 0,
              placement: "whole",
            },
          ],
        }),
      ]),
    ).toThrow(RepriceError);
  });

  it("enforces half-and-half rules and quantity bounds", async () => {
    const menu = await demoMenu();
    // Crust does not support halves.
    expect(() =>
      repriceOrderItems(menu, [
        tamperedLine({
          modifiers: [
            { group_id: CRUST, modifier_id: DEEP_DISH, placement: "left" },
          ],
        }),
      ]),
    ).toThrow(/half/);
    for (const quantity of [0, -1, 1.5, 1000]) {
      expect(() =>
        repriceOrderItems(menu, [tamperedLine({ quantity })]),
      ).toThrow(RepriceError);
    }
  });

  it("drops or zero-prices voided lines but never bills them", async () => {
    const menu = await demoMenu();
    const voided = tamperedLine({ id: "v1", voided: true, item_id: "gone" });
    expect(repriceOrderItems(menu, [voided], { voided: "drop" })).toEqual([]);
    const [kept] = repriceOrderItems(menu, [voided], { voided: "keep" });
    expect(kept!.voided).toBe(true);
    expect(kept!.line_total_cents).toBe(0);
    expect(kept!.unit_price_cents).toBe(0);
  });
});

describe("priceOrder (driver-backed)", () => {
  it("recomputes totals server-side and rejects 86'd items + sizes", async () => {
    const driver = getPosDriver();
    const priced = await priceOrder({
      tenantId: DEMO_TENANT_ID,
      locationId: DEMO_LOCATION_UPTOWN_ID,
      items: [tamperedLine()],
    });
    expect(priced.totals.subtotal_cents).toBe((2099 + 200 + 75 + 75) * 2);
    expect(priced.totals.total_cents).toBeGreaterThan(
      priced.totals.subtotal_cents - 1,
    );

    // 86 the item at Uptown → rejected there.
    await driver.upsertOverride({
      tenant_id: DEMO_TENANT_ID,
      location_id: DEMO_LOCATION_UPTOWN_ID,
      target_type: "item",
      target_id: GARLIC_KNOTS,
      available: false,
    });
    await expect(
      priceOrder({
        tenantId: DEMO_TENANT_ID,
        locationId: DEMO_LOCATION_UPTOWN_ID,
        items: [
          {
            id: "k1",
            item_id: GARLIC_KNOTS,
            size_id: "40000000-0000-0000-0000-000000000041",
            quantity: 1,
            modifiers: [],
          },
        ],
      }),
    ).rejects.toBeInstanceOf(RepriceError);

    // 86 a size at Uptown → that size is rejected there.
    await driver.upsertOverride({
      tenant_id: DEMO_TENANT_ID,
      location_id: DEMO_LOCATION_UPTOWN_ID,
      target_type: "size",
      target_id: PEPPERONI_LARGE,
      available: false,
    });
    await expect(
      priceOrder({
        tenantId: DEMO_TENANT_ID,
        locationId: DEMO_LOCATION_UPTOWN_ID,
        items: [tamperedLine()],
      }),
    ).rejects.toThrow(/size/);

    await driver.clearOverride(
      DEMO_TENANT_ID,
      DEMO_LOCATION_UPTOWN_ID,
      "item",
      GARLIC_KNOTS,
    );
    await driver.clearOverride(
      DEMO_TENANT_ID,
      DEMO_LOCATION_UPTOWN_ID,
      "size",
      PEPPERONI_LARGE,
    );
  });

  it("does not resolve another tenant's items", async () => {
    const { tenant } = await getPosDriver().createTenant({
      businessName: "Reprice Other Tenant",
      ownerEmail: "reprice-other@example.com",
    });
    const loc = await getPosDriver().createLocation({
      tenant_id: tenant.id,
      name: "Somewhere",
    });
    await expect(
      priceOrder({
        tenantId: tenant.id,
        locationId: loc.id,
        items: [tamperedLine()],
      }),
    ).rejects.toBeInstanceOf(RepriceError);
  });
});
