import { beforeEach, describe, expect, it } from "vitest";
import { DEMO_LOCATION_DOWNTOWN_ID, DEMO_TENANT_ID, getPosDriver } from "@/lib/db";
import { buildImportRows, emptySnapshot, parseMenuImport, GENERIC_TEMPLATE_CSV } from "./index";

const driver = getPosDriver();
const plan = () => parseMenuImport(new TextEncoder().encode(GENERIC_TEMPLATE_CSV));

async function rival() {
  const { tenant } = await driver.createTenant({
    businessName: `Rival ${Math.random().toString(36).slice(2, 7)}`,
    ownerEmail: `o-${Math.random().toString(36).slice(2, 7)}@rival.example`,
  });
  return tenant.id;
}

async function names(tenantId: string) {
  const s = await driver.getMenuSnapshot(tenantId);
  return {
    categories: s.categories.map((c) => c.name).sort(),
    items: s.items.map((i) => i.name).sort(),
    groups: s.modifierGroups.map((g) => g.name).sort(),
    mods: s.modifiers.length,
  };
}

describe("buildImportRows", () => {
  it("creates the whole plan on an empty menu", () => {
    const { rows, summary } = buildImportRows("t1", emptySnapshot(), plan(), "add");
    expect(summary).toEqual({ categories: 3, items: 4, sizes: 5, modifierGroups: 2, modifiers: 4, skippedItems: 0 });
    expect(rows.categories.map((c) => c.sort_order)).toEqual([1, 2, 3]);
    expect(rows.itemModifierGroups).toHaveLength(4);
    expect(new Set(rows.items.map((i) => i.tenant_id))).toEqual(new Set(["t1"]));
  });

  it("add mode reuses existing categories/groups and skips existing items", () => {
    const snap = {
      categories: [{ id: "c-pizzas", name: "PIZZAS", sort_order: 7 }],
      items: [{ id: "i-m", category_id: "c-pizzas", name: "margherita" }],
      modifierGroups: [{ id: "g-crust", name: "crust" }],
      modifiers: [{ id: "m-thin", group_id: "g-crust", name: "THIN", sort_order: 3 }],
    };
    const { rows, summary } = buildImportRows("t1", snap, plan(), "add");
    expect(summary.skippedItems).toBe(1);
    expect(rows.categories.map((c) => c.name)).toEqual(["Drinks", "Sides"]);
    expect(rows.categories.map((c) => c.sort_order)).toEqual([8, 9]);
    expect(rows.items.map((i) => i.name)).toEqual(["Pepperoni", "Cola", "Garlic Knots"]);
    // Pepperoni lands in the EXISTING Pizzas category and links the existing Crust group.
    expect(rows.items[0]?.category_id).toBe("c-pizzas");
    expect(rows.itemModifierGroups.some((l) => l.group_id === "g-crust")).toBe(true);
    // Existing group only gains the option it lacks, after its highest sort_order.
    const crustMods = rows.modifiers.filter((m) => m.group_id === "g-crust");
    expect(crustMods.map((m) => [m.name, m.sort_order])).toEqual([["Thick", 4]]);
  });

  it("replace mode ignores what exists", () => {
    const snap = {
      categories: [{ id: "c", name: "Pizzas", sort_order: 1 }],
      items: [{ id: "i", category_id: "c", name: "Margherita" }],
      modifierGroups: [],
      modifiers: [],
    };
    const { rows, summary } = buildImportRows("t1", snap, plan(), "replace");
    expect(summary.items).toBe(4);
    expect(summary.skippedItems).toBe(0);
    expect(rows.categories.map((c) => c.id)).not.toContain("c");
  });
});

describe("applyMenuImport (mock driver)", () => {
  let tenantId: string;
  beforeEach(async () => {
    tenantId = await rival();
  });

  it("add mode is idempotent: a second run creates nothing", async () => {
    const run = async () => {
      const snap = await driver.getMenuSnapshot(tenantId);
      const { rows, summary } = buildImportRows(tenantId, snap, plan(), "add");
      await driver.applyMenuImport(tenantId, rows, false);
      return summary;
    };
    const first = await run();
    expect(first.items).toBe(4);
    const after = await names(tenantId);
    const second = await run();
    expect(second).toMatchObject({ categories: 0, items: 0, sizes: 0, modifierGroups: 0, modifiers: 0, skippedItems: 4 });
    expect(await names(tenantId)).toEqual(after);
  });

  it("replace swaps the menu and removes stale overrides, twice over", async () => {
    await driver.importStarterMenu(tenantId);
    const before = await driver.getMenuSnapshot(tenantId);
    expect(before.items.length).toBeGreaterThan(0);
    const loc = await driver.createLocation({ tenant_id: tenantId, name: "Main" });
    await driver.upsertOverride({
      tenant_id: tenantId,
      location_id: loc.id,
      target_type: "item",
      target_id: before.items[0]!.id,
      price_cents: 1,
      available: false,
    });
    expect(await driver.listOverrides(tenantId, loc.id)).toHaveLength(1);
    for (let n = 0; n < 2; n++) {
      const snap = await driver.getMenuSnapshot(tenantId);
      const { rows } = buildImportRows(tenantId, snap, plan(), "replace");
      await driver.applyMenuImport(tenantId, rows, true);
      const got = await names(tenantId);
      expect(got.items).toEqual(["Cola", "Garlic Knots", "Margherita", "Pepperoni"]);
      expect(got.categories).toEqual(["Drinks", "Pizzas", "Sides"]);
      expect(got.mods).toBe(4);
      expect(await driver.listOverrides(tenantId, loc.id)).toHaveLength(0);
    }
  });

  it("rolls back everything when a later row is invalid", async () => {
    await driver.importStarterMenu(tenantId);
    const before = await names(tenantId);
    const { rows } = buildImportRows(tenantId, await driver.getMenuSnapshot(tenantId), plan(), "replace");
    // Valid categories/items/groups, then a size pointing at a non-existent item.
    rows.sizes.push({ id: crypto.randomUUID(), item_id: "nope", name: "Bad", price_cents: 1, sort_order: 1 });
    await expect(driver.applyMenuImport(tenantId, rows, true)).rejects.toThrow(/Unknown item_id/);
    expect(await names(tenantId)).toEqual(before);
  });

  it("refuses rows owned by another tenant and changes nothing", async () => {
    const before = await names(DEMO_TENANT_ID);
    const { rows } = buildImportRows("someone-else", emptySnapshot(), plan(), "add");
    await expect(driver.applyMenuImport(DEMO_TENANT_ID, rows, true)).rejects.toThrow(/another tenant/);
    expect(await names(DEMO_TENANT_ID)).toEqual(before);
  });

  it("replace never touches another tenant's menu", async () => {
    const other = await rival();
    await driver.importStarterMenu(other);
    const otherBefore = await names(other);
    const { rows } = buildImportRows(tenantId, emptySnapshot(), plan(), "replace");
    await driver.applyMenuImport(tenantId, rows, true);
    expect(await names(other)).toEqual(otherBefore);
  });

  it("leaves historical orders readable after a replace", async () => {
    const snapBefore = await driver.getMenuSnapshot(DEMO_TENANT_ID);
    const item = snapBefore.items[0]!;
    const order = await driver.createOrder({
      id: crypto.randomUUID(),
      tenant_id: DEMO_TENANT_ID,
      location_id: DEMO_LOCATION_DOWNTOWN_ID,
      channel: "in_store",
      currency: "USD",
      items: [
        {
          id: "line-1",
          item_id: item.id,
          item_name: item.name,
          size_id: null,
          size_name: "Regular",
          base_price_cents: 1000,
          quantity: 1,
          modifiers: [],
          notes: null,
          voided: false,
          unit_price_cents: 1000,
          line_total_cents: 1000,
        },
      ],
      discount_cents: 0,
      totals: { subtotal_cents: 1000, discount_cents: 0, taxable_cents: 1000, tax_cents: 0, tip_cents: 0, total_cents: 1000 },
      notes: null,
      status: "paid",
    });
    const { rows } = buildImportRows(DEMO_TENANT_ID, snapBefore, plan(), "replace");
    await driver.applyMenuImport(DEMO_TENANT_ID, rows, true);
    const kept = await driver.getOrder(order.id);
    expect(kept?.items[0]?.item_name).toBe(item.name);
    expect(kept?.totals.total_cents).toBe(1000);
  });
});
