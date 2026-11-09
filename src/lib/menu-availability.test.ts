import { describe, it, expect } from "vitest";
import type { MenuItemDetail } from "@/lib/db";
import {
  availabilityFromOverrides,
  isItem86d,
  isItemSoldOut,
  soldOutSets,
} from "./menu-availability";

const item = (id: string, sizeIds: string[]): MenuItemDetail =>
  ({
    id,
    sizes: sizeIds.map((s) => ({ id: s, item_id: id, name: s, price_cents: 1000, sort_order: 0 })),
    modifierGroups: [],
  }) as unknown as MenuItemDetail;

describe("menu availability (86) for the till", () => {
  it("collects only available:false overrides by type", () => {
    expect(
      availabilityFromOverrides([
        { target_type: "item", target_id: "pep", available: false },
        { target_type: "item", target_id: "marg", available: null },
        { target_type: "size", target_id: "xl", available: false },
        { target_type: "modifier", target_id: "anch", available: false },
        { target_type: "modifier", target_id: "olive", available: true },
      ]),
    ).toEqual({ itemIds: ["pep"], sizeIds: ["xl"], modifierIds: ["anch"] });
  });

  it("an item is sold out when 86'd or when every size is", () => {
    const so = soldOutSets({ itemIds: ["pep"], sizeIds: ["s1", "s2"], modifierIds: [] });
    expect(isItemSoldOut(item("pep", ["a"]), so)).toBe(true);
    expect(isItemSoldOut(item("marg", ["s1", "s2"]), so)).toBe(true);
    expect(isItemSoldOut(item("marg", ["s1", "s3"]), so)).toBe(false);
    expect(isItemSoldOut(item("soda", []), so)).toBe(false);
    expect(isItem86d("pep", so)).toBe(true);
    expect(isItem86d("marg", so)).toBe(false);
  });

  it("nothing is sold out without data (old cached menu)", () => {
    expect(isItemSoldOut(item("pep", ["a"]), soldOutSets(undefined))).toBe(false);
  });
});

describe("GET /api/menu marks 86'd items instead of dropping them", () => {
  it("keeps the 86'd item in the menu and lists it in `unavailable`", async () => {
    const { vi } = await import("vitest");
    vi.doMock("@/lib/auth/tenant-guard", () => ({
      requireTenantAccess: async (tenantId: string, _s: string, o?: { locationId?: string }) => ({
        ok: true,
        tenantId,
        locationId: o?.locationId ?? null,
        user: { id: "u1", email: "m@x" },
      }),
    }));
    const { getPosDriver, DEMO_TENANT_ID, DEMO_LOCATION_DOWNTOWN_ID } = await import("@/lib/db");
    const { GET } = await import("@/app/api/menu/route");
    const driver = getPosDriver();
    const menu = await driver.getMenu(DEMO_TENANT_ID, DEMO_LOCATION_DOWNTOWN_ID);
    const target = menu.categories[0]!.items[0]!;
    await driver.upsertOverride({
      tenant_id: DEMO_TENANT_ID,
      location_id: DEMO_LOCATION_DOWNTOWN_ID,
      target_type: "item",
      target_id: target.id,
      available: false,
    });
    try {
      const res = await GET(
        new Request(
          `http://x/api/menu?tenantId=${DEMO_TENANT_ID}&locationId=${DEMO_LOCATION_DOWNTOWN_ID}`,
        ),
      );
      const body = await res.json();
      expect(body.unavailable.itemIds).toContain(target.id);
      const ids = (body.menu.categories as { items: { id: string }[] }[]).flatMap((c) =>
        c.items.map((i) => i.id),
      );
      expect(ids).toContain(target.id);
      // The customer menu (Place order re-pricing) still drops it.
      const customer = await driver.getMenu(DEMO_TENANT_ID, DEMO_LOCATION_DOWNTOWN_ID);
      expect(customer.categories.flatMap((c) => c.items.map((i) => i.id))).not.toContain(target.id);
    } finally {
      await driver.clearOverride(DEMO_TENANT_ID, DEMO_LOCATION_DOWNTOWN_ID, "item", target.id);
    }
  });
});
