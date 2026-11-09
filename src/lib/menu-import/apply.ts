/**
 * Plan + what the tenant already has -> the exact change set to apply.
 *
 * Pure (ids come from `newId`), so preview and apply share one code path and
 * the matching rules are unit-tested without a database. Matching is by
 * case-insensitive name: category; item within category; size within item;
 * modifier group; option within group.
 *
 *   "add"     only INSERTS. Existing categories/groups are reused, an item that
 *             already exists in its category is SKIPPED (never duplicated or
 *             overwritten), existing groups only gain options they lack, and
 *             new items link to existing groups by name. Re-importing creates
 *             nothing.
 *   "replace" makes the menu match the file but keeps identity: matched rows are
 *             UPDATED IN PLACE (same ids, so open carts, offline-queued orders,
 *             /v1 carts, inventory recipes, allergen rows and per-location
 *             overrides keep working), unmatched file rows are inserted, and
 *             only rows ABSENT from the file are deleted (and reported).
 *             If the file defines no modifier groups at all (Square / Clover
 *             item exports), existing modifier groups and links are left alone.
 */
import type { MenuTemplate } from "@/lib/saas/menu-template";
import type { Station } from "@/lib/db/menu-types";
import type { ImportWarning, MenuImportPlan, MenuSnapshot } from "./types";

export type ImportMode = "add" | "replace";

export interface ImportUpdates {
  categories: { id: string; name: string; sort_order: number }[];
  items: {
    id: string;
    category_id: string;
    name: string;
    description: string | null;
    is_half_and_half_capable: boolean;
    station: Station;
  }[];
  sizes: { id: string; name: string; price_cents: number; sort_order: number }[];
  modifierGroups: {
    id: string;
    name: string;
    min_select: number;
    max_select: number;
    supports_half: boolean;
  }[];
  modifiers: { id: string; name: string; price_cents: number; sort_order: number }[];
  itemModifierGroups: { item_id: string; group_id: string; sort_order: number }[];
}

export interface ImportDeletes {
  categories: string[];
  items: string[];
  sizes: string[];
  modifierGroups: string[];
  modifiers: string[];
  itemModifierGroups: { item_id: string; group_id: string }[];
}

/** What `driver.applyMenuImport` applies in ONE transaction. */
export interface ImportChanges {
  insert: MenuTemplate;
  update: ImportUpdates;
  delete: ImportDeletes;
}

export interface ImportSummary {
  /** Created. */
  categories: number;
  items: number;
  sizes: number;
  modifierGroups: number;
  modifiers: number;
  /** Add mode: items left alone because the name already exists in the category. */
  skippedItems: number;
  /** Replace mode: items updated in place (ids kept). */
  updatedItems: number;
  /** Replace mode: rows absent from the file that will be deleted. */
  removed: {
    categories: number;
    items: number;
    sizes: number;
    modifierGroups: number;
    modifiers: number;
    itemsWithRecipes: number;
    itemsWithAllergens: number;
    /** Names of removed items (first 50) for the preview. */
    itemNames: string[];
  };
}

export interface ImportRows {
  changes: ImportChanges;
  summary: ImportSummary;
  /** Warnings that depend on the existing menu (unresolved modifier groups). */
  warnings: ImportWarning[];
}

export function emptySnapshot(): MenuSnapshot {
  return {
    categories: [],
    items: [],
    sizes: [],
    modifierGroups: [],
    modifiers: [],
    links: [],
    inventoryLinkSourceIds: [],
    allergenTargetIds: [],
  };
}

const key = (s: string) => s.trim().toLowerCase();

export function emptyChanges(): ImportChanges {
  return {
    insert: {
      categories: [],
      items: [],
      sizes: [],
      modifierGroups: [],
      modifiers: [],
      itemModifierGroups: [],
    },
    update: {
      categories: [],
      items: [],
      sizes: [],
      modifierGroups: [],
      modifiers: [],
      itemModifierGroups: [],
    },
    delete: {
      categories: [],
      items: [],
      sizes: [],
      modifierGroups: [],
      modifiers: [],
      itemModifierGroups: [],
    },
  };
}

export function buildImportRows(
  tenantId: string,
  snapshot: MenuSnapshot,
  plan: MenuImportPlan,
  mode: ImportMode,
  newId: () => string = () => crypto.randomUUID(),
): ImportRows {
  const replace = mode === "replace";
  const ch = emptyChanges();
  const { insert, update, delete: del } = ch;
  const warnings: ImportWarning[] = [];
  let skippedItems = 0;
  let updatedItems = 0;

  // ---------------- modifier groups (first, so items can link) --------------
  const groupId = new Map<string, string>();
  for (const g of snapshot.modifierGroups) {
    if (!groupId.has(key(g.name))) groupId.set(key(g.name), g.id);
  }
  const managedGroups = replace && plan.modifierGroups.length > 0;
  const keptGroupIds = new Set<string>();
  let createdGroups = 0;
  for (const g of plan.modifierGroups) {
    let id = groupId.get(key(g.name));
    const existingMods = new Map<string, MenuSnapshot["modifiers"][number]>();
    let order = 0;
    if (id) {
      const gid = id;
      keptGroupIds.add(gid);
      for (const m of snapshot.modifiers.filter((m) => m.group_id === gid)) {
        if (!existingMods.has(key(m.name))) existingMods.set(key(m.name), m);
        order = Math.max(order, m.sort_order);
      }
      if (replace) {
        update.modifierGroups.push({
          id: gid,
          name: g.name,
          min_select: g.min_select,
          max_select: g.max_select,
          supports_half: g.supports_half,
        });
      }
    } else {
      id = newId();
      groupId.set(key(g.name), id);
      keptGroupIds.add(id);
      createdGroups++;
      insert.modifierGroups.push({
        id,
        tenant_id: tenantId,
        name: g.name,
        min_select: g.min_select,
        max_select: g.max_select,
        supports_half: g.supports_half,
      });
    }
    const seenMods = new Set<string>();
    g.modifiers.forEach((m, i) => {
      const have = existingMods.get(key(m.name));
      seenMods.add(key(m.name));
      if (have) {
        if (replace) {
          update.modifiers.push({ id: have.id, name: m.name, price_cents: m.price_cents, sort_order: i + 1 });
        }
        return;
      }
      insert.modifiers.push({
        id: newId(),
        group_id: id as string,
        name: m.name,
        price_cents: m.price_cents,
        sort_order: replace ? i + 1 : ++order,
      });
    });
    if (replace) {
      for (const [k, m] of existingMods) {
        if (!seenMods.has(k)) del.modifiers.push(m.id);
      }
    }
  }
  if (managedGroups) {
    for (const g of snapshot.modifierGroups) {
      if (!keptGroupIds.has(g.id)) {
        del.modifierGroups.push(g.id);
        for (const m of snapshot.modifiers) if (m.group_id === g.id) del.modifiers.push(m.id);
      }
    }
  }

  // ---------------- categories + items ---------------------------------------
  const categoryId = new Map<string, string>();
  for (const c of snapshot.categories) {
    if (!categoryId.has(key(c.name))) categoryId.set(key(c.name), c.id);
  }
  let nextCategoryOrder = snapshot.categories.reduce((n, c) => Math.max(n, c.sort_order), 0);
  const itemsByCatName = new Map<string, MenuSnapshot["items"][number]>();
  for (const i of snapshot.items) {
    const k = `${i.category_id}\u0000${key(i.name)}`;
    if (!itemsByCatName.has(k)) itemsByCatName.set(k, i);
  }
  const keptCategoryIds = new Set<string>();
  const keptItemIds = new Set<string>();
  const unresolved = new Map<string, { name: string; items: number }>();
  const linksManaged =
    replace &&
    (plan.modifierGroups.length > 0 ||
      plan.categories.some((c) => c.items.some((i) => i.modifier_groups.length > 0)));

  const resolveGroups = (names: string[]): string[] => {
    const ids: string[] = [];
    for (const n of names) {
      const gid = groupId.get(key(n));
      if (gid) {
        if (!ids.includes(gid)) ids.push(gid);
      } else {
        const ref = unresolved.get(key(n)) ?? { name: n, items: 0 };
        ref.items++;
        unresolved.set(key(n), ref);
      }
    }
    return ids;
  };

  plan.categories.forEach((c, ci) => {
    let cid = categoryId.get(key(c.name));
    if (cid) {
      keptCategoryIds.add(cid);
      if (replace) update.categories.push({ id: cid, name: c.name, sort_order: ci + 1 });
    }
    for (const item of c.items) {
      const existing = cid ? itemsByCatName.get(`${cid}\u0000${key(item.name)}`) : undefined;
      if (existing && !replace) {
        skippedItems++;
        continue;
      }
      if (!cid) {
        cid = newId();
        categoryId.set(key(c.name), cid);
        keptCategoryIds.add(cid);
        insert.categories.push({
          id: cid,
          tenant_id: tenantId,
          name: c.name,
          sort_order: replace ? ci + 1 : ++nextCategoryOrder,
        });
      }
      const wantGroups = resolveGroups(item.modifier_groups);

      if (existing) {
        // replace: update in place, keep the id.
        keptItemIds.add(existing.id);
        updatedItems++;
        update.items.push({
          id: existing.id,
          category_id: cid,
          name: item.name,
          description: item.description,
          is_half_and_half_capable: item.half_and_half,
          station: item.station,
        });
        const haveSizes = new Map<string, MenuSnapshot["sizes"][number]>();
        for (const s of snapshot.sizes) {
          if (s.item_id === existing.id && !haveSizes.has(key(s.name))) haveSizes.set(key(s.name), s);
        }
        const seen = new Set<string>();
        item.sizes.forEach((s, i) => {
          seen.add(key(s.name));
          const have = haveSizes.get(key(s.name));
          if (have) {
            update.sizes.push({ id: have.id, name: s.name, price_cents: s.price_cents, sort_order: i + 1 });
          } else {
            insert.sizes.push({ id: newId(), item_id: existing.id, name: s.name, price_cents: s.price_cents, sort_order: i + 1 });
          }
        });
        for (const s of snapshot.sizes) {
          if (s.item_id === existing.id && !seen.has(key(s.name))) del.sizes.push(s.id);
        }
        if (linksManaged) {
          const haveLinks = snapshot.links.filter((l) => l.item_id === existing.id);
          wantGroups.forEach((gid, i) => {
            if (haveLinks.some((l) => l.group_id === gid)) {
              update.itemModifierGroups.push({ item_id: existing.id, group_id: gid, sort_order: i + 1 });
            } else {
              insert.itemModifierGroups.push({ item_id: existing.id, group_id: gid, sort_order: i + 1 });
            }
          });
          for (const l of haveLinks) {
            if (!wantGroups.includes(l.group_id) && !del.modifierGroups.includes(l.group_id)) {
              del.itemModifierGroups.push({ item_id: l.item_id, group_id: l.group_id });
            }
          }
        }
        continue;
      }

      const itemId = newId();
      insert.items.push({
        id: itemId,
        tenant_id: tenantId,
        category_id: cid,
        name: item.name,
        description: item.description,
        is_half_and_half_capable: item.half_and_half,
        station: item.station,
      });
      item.sizes.forEach((s, i) =>
        insert.sizes.push({ id: newId(), item_id: itemId, name: s.name, price_cents: s.price_cents, sort_order: i + 1 }),
      );
      wantGroups.forEach((gid, i) =>
        insert.itemModifierGroups.push({ item_id: itemId, group_id: gid, sort_order: i + 1 }),
      );
    }
  });

  for (const ref of unresolved.values()) {
    warnings.push({
      code: "modifiers_without_options",
      message: `Modifier group "${ref.name}" is used by ${ref.items} item${ref.items === 1 ? "" : "s"} but is not in this file or on your menu, so it was not linked. Add the group in Menu manager after importing.`,
    });
  }

  // ---------------- replace: what is absent from the file --------------------
  const removed = {
    categories: 0,
    items: 0,
    sizes: 0,
    modifierGroups: managedGroups ? del.modifierGroups.length : 0,
    modifiers: 0,
    itemsWithRecipes: 0,
    itemsWithAllergens: 0,
    itemNames: [] as string[],
  };
  if (replace) {
    for (const c of snapshot.categories) {
      if (!keptCategoryIds.has(c.id)) del.categories.push(c.id);
    }
    for (const i of snapshot.items) {
      if (keptItemIds.has(i.id)) continue;
      del.items.push(i.id);
      for (const s of snapshot.sizes) {
        if (s.item_id === i.id) {
          del.sizes.push(s.id);
        }
      }
    }
    const recipe = new Set(snapshot.inventoryLinkSourceIds);
    const allergen = new Set(snapshot.allergenTargetIds);
    for (const id of del.items) {
      const item = snapshot.items.find((i) => i.id === id);
      if (removed.itemNames.length < 50 && item) removed.itemNames.push(item.name);
      if (recipe.has(id)) removed.itemsWithRecipes++;
      if (allergen.has(id)) removed.itemsWithAllergens++;
    }
    removed.categories = del.categories.length;
    removed.items = del.items.length;
    removed.sizes = del.sizes.length;
    removed.modifiers = del.modifiers.length;
  }

  return {
    changes: ch,
    warnings,
    summary: {
      categories: insert.categories.length,
      items: insert.items.length,
      sizes: insert.sizes.length,
      modifierGroups: createdGroups,
      modifiers: insert.modifiers.length,
      skippedItems,
      updatedItems,
      removed,
    },
  };
}
