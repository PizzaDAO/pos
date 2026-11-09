/**
 * Plan -> the exact rows to insert, given what the tenant already has.
 *
 * Pure (ids come from `newId`), so preview and apply share one code path and
 * the matching rules are unit-tested without a database:
 *   - "add" mode merges by case-insensitive name: existing categories and
 *     modifier groups are reused, an item that already exists in its category
 *     is SKIPPED (never duplicated or overwritten), existing groups only gain
 *     options they lack. Re-running the same import therefore creates nothing.
 *   - "replace" mode ignores what exists (the driver removes it in the same
 *     transaction) and inserts the whole plan fresh.
 */
import type { MenuTemplate } from "@/lib/saas/menu-template";
import type { MenuImportPlan, MenuSnapshot } from "./types";

export type ImportMode = "add" | "replace";

export interface ImportSummary {
  categories: number;
  items: number;
  sizes: number;
  modifierGroups: number;
  modifiers: number;
  /** Items left alone because the same name already exists in the category. */
  skippedItems: number;
}

export interface ImportRows {
  rows: MenuTemplate;
  summary: ImportSummary;
}

export function emptySnapshot(): MenuSnapshot {
  return { categories: [], items: [], modifierGroups: [], modifiers: [] };
}

const key = (s: string) => s.trim().toLowerCase();

export function buildImportRows(
  tenantId: string,
  snapshot: MenuSnapshot,
  plan: MenuImportPlan,
  mode: ImportMode,
  newId: () => string = () => crypto.randomUUID(),
): ImportRows {
  const existing = mode === "replace" ? emptySnapshot() : snapshot;
  const rows: MenuTemplate = {
    categories: [],
    items: [],
    sizes: [],
    modifierGroups: [],
    modifiers: [],
    itemModifierGroups: [],
  };
  let skippedItems = 0;

  // --- modifier groups (first, so items can link to them) ---
  const groupId = new Map<string, string>();
  for (const g of existing.modifierGroups) groupId.set(key(g.name), g.id);
  let createdGroups = 0;
  for (const g of plan.modifierGroups) {
    let id = groupId.get(key(g.name));
    const have = new Set<string>();
    let order = 0;
    if (id) {
      for (const m of existing.modifiers.filter((m) => m.group_id === id)) {
        have.add(key(m.name));
        order = Math.max(order, m.sort_order);
      }
    } else {
      id = newId();
      groupId.set(key(g.name), id);
      createdGroups++;
      rows.modifierGroups.push({
        id,
        tenant_id: tenantId,
        name: g.name,
        min_select: g.min_select,
        max_select: g.max_select,
        supports_half: g.supports_half,
      });
    }
    for (const m of g.modifiers) {
      if (have.has(key(m.name))) continue;
      rows.modifiers.push({
        id: newId(),
        group_id: id,
        name: m.name,
        price_cents: m.price_cents,
        sort_order: ++order,
      });
    }
  }

  // --- categories + items ---
  const categoryId = new Map<string, string>();
  for (const c of existing.categories) categoryId.set(key(c.name), c.id);
  let nextCategoryOrder = existing.categories.reduce(
    (n, c) => Math.max(n, c.sort_order),
    0,
  );
  const existingItem = new Set(
    existing.items.map((i) => `${i.category_id}\u0000${key(i.name)}`),
  );
  for (const c of plan.categories) {
    let cid = categoryId.get(key(c.name));
    for (const item of c.items) {
      if (cid && existingItem.has(`${cid}\u0000${key(item.name)}`)) {
        skippedItems++;
        continue;
      }
      if (!cid) {
        cid = newId();
        categoryId.set(key(c.name), cid);
        rows.categories.push({
          id: cid,
          tenant_id: tenantId,
          name: c.name,
          sort_order: ++nextCategoryOrder,
        });
      }
      const itemId = newId();
      rows.items.push({
        id: itemId,
        tenant_id: tenantId,
        category_id: cid,
        name: item.name,
        description: item.description,
        is_half_and_half_capable: item.half_and_half,
        station: item.station,
      });
      item.sizes.forEach((s, i) =>
        rows.sizes.push({
          id: newId(),
          item_id: itemId,
          name: s.name,
          price_cents: s.price_cents,
          sort_order: i + 1,
        }),
      );
      item.modifier_groups.forEach((g, i) => {
        const gid = groupId.get(key(g));
        if (gid) rows.itemModifierGroups.push({ item_id: itemId, group_id: gid, sort_order: i + 1 });
      });
    }
  }

  return {
    rows,
    summary: {
      categories: rows.categories.length,
      items: rows.items.length,
      sizes: rows.sizes.length,
      modifierGroups: createdGroups,
      modifiers: rows.modifiers.length,
      skippedItems,
    },
  };
}
