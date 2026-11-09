import { describe, expect, it } from "vitest";
import { DEMO_LOCATION_DOWNTOWN_ID, DEMO_TENANT_ID, getPosDriver } from "@/lib/db";
import {
  GENERIC_TEMPLATE_CSV,
  buildImportRows,
  emptySnapshot,
  parseMenuImport,
  type ImportMode,
  type MenuSnapshot,
} from "./index";

const driver = getPosDriver();
const parse = (csv: string) => parseMenuImport(new TextEncoder().encode(csv));
const plan = () => parse(GENERIC_TEMPLATE_CSV);

async function rival() {
  const { tenant } = await driver.createTenant({
    businessName: `Rival ${Math.random().toString(36).slice(2, 7)}`,
    ownerEmail: `o-${Math.random().toString(36).slice(2, 7)}@rival.example`,
  });
  return tenant.id;
}

async function run(tenantId: string, csv: string, mode: ImportMode) {
  const built = buildImportRows(tenantId, await driver.getMenuSnapshot(tenantId), parse(csv), mode);
  await driver.applyMenuImport(tenantId, built.changes);
  return built;
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
    const { changes, summary } = buildImportRows("t1", emptySnapshot(), plan(), "add");
    expect(summary).toMatchObject({ categories: 3, items: 4, sizes: 5, modifierGroups: 2, modifiers: 4, skippedItems: 0 });
    expect(changes.insert.categories.map((c) => c.sort_order)).toEqual([1, 2, 3]);
    expect(changes.insert.itemModifierGroups).toHaveLength(4);
    expect(new Set(changes.insert.items.map((i) => i.tenant_id))).toEqual(new Set(["t1"]));
    expect(changes.update.items).toEqual([]);
    expect(changes.delete.items).toEqual([]);
  });

  const existing = (): MenuSnapshot => ({
    ...emptySnapshot(),
    categories: [{ id: "c-pizzas", name: "PIZZAS", sort_order: 7 }],
    items: [{ id: "i-m", category_id: "c-pizzas", name: "margherita", description: null, is_half_and_half_capable: false, station: "oven" }],
    modifierGroups: [{ id: "g-crust", name: "crust", min_select: 0, max_select: 1, supports_half: false }],
    modifiers: [{ id: "m-thin", group_id: "g-crust", name: "THIN", price_cents: 0, sort_order: 3 }],
  });

  it("add mode reuses existing categories/groups and skips existing items", () => {
    const { changes, summary } = buildImportRows("t1", existing(), plan(), "add");
    expect(summary.skippedItems).toBe(1);
    expect(changes.insert.categories.map((c) => [c.name, c.sort_order])).toEqual([["Drinks", 8], ["Sides", 9]]);
    expect(changes.insert.items.map((i) => i.name)).toEqual(["Pepperoni", "Cola", "Garlic Knots"]);
    expect(changes.insert.items[0]?.category_id).toBe("c-pizzas");
    expect(changes.insert.itemModifierGroups.some((l) => l.group_id === "g-crust")).toBe(true);
    expect(changes.insert.modifiers.filter((m) => m.group_id === "g-crust").map((m) => [m.name, m.sort_order])).toEqual([["Thick", 4]]);
    expect(changes.update.items).toEqual([]);
    expect(changes.delete.categories).toEqual([]);
  });

  it("add mode links new items to existing groups the file does not define", () => {
    const p = parse("category,item,price,modifier_groups\nPizzas,Calzone,9,Crust\nPizzas,Stromboli,9,Nope\n");
    const { changes, warnings } = buildImportRows("t1", existing(), p, "add");
    expect(changes.insert.itemModifierGroups).toEqual([
      { item_id: changes.insert.items[0]?.id, group_id: "g-crust", sort_order: 1 },
    ]);
    expect(warnings.map((w) => w.message).join(" ")).toMatch(/"Nope"/);
    expect(warnings.map((w) => w.message).join(" ")).not.toMatch(/"Crust"/);
  });

  it("replace updates matches in place and deletes only what the file lacks", () => {
    const snap: MenuSnapshot = {
      ...existing(),
      categories: [...existing().categories, { id: "c-old", name: "Old", sort_order: 9 }],
      items: [
        ...existing().items,
        { id: "i-old", category_id: "c-old", name: "Gone", description: null, is_half_and_half_capable: false, station: "oven" },
        { id: "i-extra", category_id: "c-pizzas", name: "Extra", description: null, is_half_and_half_capable: false, station: "oven" },
      ],
      sizes: [
        { id: "s-small", item_id: "i-m", name: "small", price_cents: 1, sort_order: 1 },
        { id: "s-med", item_id: "i-m", name: "Medium", price_cents: 1, sort_order: 2 },
        { id: "s-old", item_id: "i-old", name: "Regular", price_cents: 1, sort_order: 1 },
      ],
      inventoryLinkSourceIds: ["i-old"],
      allergenTargetIds: ["i-old", "i-extra"],
    };
    const { changes, summary } = buildImportRows("t1", snap, plan(), "replace");
    expect(changes.update.items.map((i) => i.id)).toEqual(["i-m"]);
    expect(changes.update.categories).toEqual([{ id: "c-pizzas", name: "Pizzas", sort_order: 1 }]);
    expect(changes.update.sizes.map((s) => [s.id, s.price_cents])).toEqual([["s-small", 1200]]);
    expect(changes.insert.sizes.some((s) => s.item_id === "i-m" && s.name === "Large")).toBe(true);
    expect(changes.delete.sizes.sort()).toEqual(["s-med", "s-old"]);
    expect(changes.delete.items.sort()).toEqual(["i-extra", "i-old"]);
    expect(changes.delete.categories).toEqual(["c-old"]);
    expect(summary.updatedItems).toBe(1);
    expect(summary.removed).toMatchObject({ items: 2, categories: 1, itemsWithRecipes: 1, itemsWithAllergens: 2 });
    expect(summary.removed.itemNames.sort()).toEqual(["Extra", "Gone"]);
  });

  it("replace keeps the id of an item moved to another or renamed category", () => {
    const snap: MenuSnapshot = {
      ...existing(),
      items: [
        ...existing().items,
        { id: "i-cola", category_id: "c-pizzas", name: "Cola", description: null, is_half_and_half_capable: false, station: "oven" },
      ],
    };
    const { changes, summary } = buildImportRows("t1", snap, plan(), "replace");
    const moved = changes.update.items.find((i) => i.id === "i-cola");
    expect(moved?.category_id).toBe(changes.insert.categories.find((c) => c.name === "Drinks")?.id);
    expect(changes.insert.items.some((i) => i.name === "Cola")).toBe(false);
    expect(changes.delete.items).not.toContain("i-cola");
    expect(summary.updatedItems).toBe(2);
  });

  it("replace leaves modifier groups and links alone when the file has none", () => {
    const snap: MenuSnapshot = {
      ...existing(),
      links: [{ item_id: "i-m", group_id: "g-crust", sort_order: 1 }],
    };
    const { changes } = buildImportRows("t1", snap, parse("category,item,price\nPizzas,Margherita,12\n"), "replace");
    expect(changes.delete.modifierGroups).toEqual([]);
    expect(changes.delete.itemModifierGroups).toEqual([]);
  });
});

describe("applyMenuImport (mock driver)", () => {
  it("add mode is idempotent: a second run creates nothing", async () => {
    const t = await rival();
    expect((await run(t, GENERIC_TEMPLATE_CSV, "add")).summary.items).toBe(4);
    const after = await names(t);
    const second = (await run(t, GENERIC_TEMPLATE_CSV, "add")).summary;
    expect(second).toMatchObject({ categories: 0, items: 0, sizes: 0, modifierGroups: 0, modifiers: 0, skippedItems: 4 });
    expect(await names(t)).toEqual(after);
  });

  it("replace twice keeps ids stable and converges", async () => {
    const t = await rival();
    await run(t, GENERIC_TEMPLATE_CSV, "add");
    const ids = (await driver.getMenuSnapshot(t)).items.map((i) => i.id).sort();
    for (let n = 0; n < 2; n++) {
      const built = await run(t, GENERIC_TEMPLATE_CSV, "replace");
      expect(built.summary.items).toBe(0);
      expect(built.summary.updatedItems).toBe(4);
      expect((await driver.getMenuSnapshot(t)).items.map((i) => i.id).sort()).toEqual(ids);
    }
  });

  it("replace edits prices in place and removes only absent rows", async () => {
    const t = await rival();
    await run(t, GENERIC_TEMPLATE_CSV, "add");
    const before = await driver.getMenuSnapshot(t);
    const loc = await driver.createLocation({ tenant_id: t, name: "Main" });
    const cola = before.items.find((i) => i.name === "Cola")!;
    const margherita = before.items.find((i) => i.name === "Margherita")!;
    const knots = before.items.find((i) => i.name === "Garlic Knots")!;
    for (const id of [cola.id, knots.id]) {
      await driver.upsertOverride({ tenant_id: t, location_id: loc.id, target_type: "item", target_id: id, price_cents: null, available: false });
    }
    const csv = "category,item,size,price\nPizzas,Margherita,Small,13.00\nPizzas,Margherita,Large,18.00\nDrinks,Cola,Can,3.00\nPizzas,Calzone,Regular,9.00\n";
    const built = await run(t, csv, "replace");
    expect(built.summary.removed.items).toBe(2); // Pepperoni + Garlic Knots
    const after = await driver.getMenuSnapshot(t);
    expect(after.items.map((i) => i.name).sort()).toEqual(["Calzone", "Cola", "Margherita"]);
    expect(after.items.find((i) => i.name === "Margherita")?.id).toBe(margherita.id);
    expect(after.items.find((i) => i.name === "Cola")?.id).toBe(cola.id);
    expect(after.sizes.find((s) => s.item_id === margherita.id && s.name === "Small")?.price_cents).toBe(1300);
    expect(after.categories.map((c) => c.name).sort()).toEqual(["Drinks", "Pizzas"]);
    // Groups untouched (file has none).
    expect(after.modifierGroups.map((g) => g.name).sort()).toEqual(["Crust", "Toppings"]);
    // The kept item's override survives; the removed item's is gone.
    const ov = (await driver.listOverrides(t, loc.id)).map((o) => o.target_id);
    expect(ov).toEqual([cola.id]);
  });

  it("deletes recipes + allergen rows of removed items only (demo tenant), and orders survive", async () => {
    const snap = await driver.getMenuSnapshot(DEMO_TENANT_ID);
    expect(snap.inventoryLinkSourceIds.length).toBeGreaterThan(0);
    const keep = snap.items[0]!;
    const drop = snap.items[1]!;
    const pub = await driver.publishAllergens(DEMO_TENANT_ID, {
      version: "v1",
      payload_hash: "h",
      location_ids: null,
      published_by: null,
      rows: [keep, drop].map((i) => ({ target_type: "item" as const, target_id: i.id, contains: ["milk"], may_contain: [], tags: [] })),
    });
    expect(pub.outcome).toBe("ok");
    const order = await driver.createOrder({
      id: crypto.randomUUID(),
      tenant_id: DEMO_TENANT_ID,
      location_id: DEMO_LOCATION_DOWNTOWN_ID,
      channel: "in_store",
      currency: "USD",
      items: [
        {
          id: "line-1", item_id: drop.id, item_name: drop.name, size_id: null, size_name: "Regular",
          base_price_cents: 1000, quantity: 1, modifiers: [], notes: null, voided: false,
          unit_price_cents: 1000, line_total_cents: 1000,
        },
      ],
      discount_cents: 0,
      totals: { subtotal_cents: 1000, discount_cents: 0, taxable_cents: 1000, tax_cents: 0, tip_cents: 0, total_cents: 1000 },
      notes: null,
      status: "paid",
    });
    const cat = snap.categories.find((c) => c.id === keep.category_id)!;
    await run(DEMO_TENANT_ID, `category,item,price\n${cat.name},${keep.name},5\n`, "replace");
    const after = await driver.getMenuSnapshot(DEMO_TENANT_ID);
    expect(after.items.map((i) => i.id)).toEqual([keep.id]);
    expect(after.allergenTargetIds).toEqual([keep.id]);
    const removedItems = new Set(snap.items.filter((i) => i.id !== keep.id).map((i) => i.id));
    expect(after.inventoryLinkSourceIds.some((id) => removedItems.has(id))).toBe(false);
    expect(after.inventoryLinkSourceIds.length).toBeLessThan(snap.inventoryLinkSourceIds.length);
    const kept = await driver.getOrder(order.id);
    expect(kept?.items[0]?.item_name).toBe(drop.name);
    expect(kept?.totals.total_cents).toBe(1000);
  });

  it("rolls back everything when a later row is invalid", async () => {
    const t = await rival();
    await driver.importStarterMenu(t);
    const before = await names(t);
    const { changes } = buildImportRows(t, await driver.getMenuSnapshot(t), plan(), "replace");
    changes.insert.sizes.push({ id: crypto.randomUUID(), item_id: "nope", name: "Bad", price_cents: 1, sort_order: 1 });
    await expect(driver.applyMenuImport(t, changes)).rejects.toThrow(/Unknown item_id/);
    expect(await names(t)).toEqual(before);
  });

  it("refuses rows or ids owned by another tenant and changes nothing", async () => {
    const before = await names(DEMO_TENANT_ID);
    const foreign = buildImportRows("someone-else", emptySnapshot(), plan(), "add");
    await expect(driver.applyMenuImport(DEMO_TENANT_ID, foreign.changes)).rejects.toThrow(/another tenant/);
    const other = await rival();
    await driver.importStarterMenu(other);
    const otherSnap = await driver.getMenuSnapshot(other);
    const attack = buildImportRows(DEMO_TENANT_ID, emptySnapshot(), plan(), "add").changes;
    attack.delete.items.push(otherSnap.items[0]!.id);
    await expect(driver.applyMenuImport(DEMO_TENANT_ID, attack)).rejects.toThrow(/not found/);
    expect(await names(DEMO_TENANT_ID)).toEqual(before);
    expect((await driver.getMenuSnapshot(other)).items.length).toBe(otherSnap.items.length);
  });

  it("a stale duplicate apply fails instead of duplicating", async () => {
    const t = await rival();
    const built = buildImportRows(t, await driver.getMenuSnapshot(t), plan(), "add");
    await driver.applyMenuImport(t, built.changes);
    const again = structuredClone(built.changes);
    await expect(driver.applyMenuImport(t, again)).rejects.toThrow(/menu changed/);
    expect((await driver.getMenuSnapshot(t)).items).toHaveLength(4);
  });

  it("replace never touches another tenant's menu", async () => {
    const t = await rival();
    const other = await rival();
    await driver.importStarterMenu(other);
    const otherBefore = await names(other);
    await run(t, GENERIC_TEMPLATE_CSV, "replace");
    expect(await names(other)).toEqual(otherBefore);
  });
});
