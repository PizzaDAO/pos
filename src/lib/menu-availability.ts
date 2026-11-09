/**
 * Per-location "86" (sold out) state for the till. Pure and client-safe.
 *
 * The till's menu keeps 86'd items, sizes and modifiers (so they can show as
 * "Sold out" instead of silently vanishing, and be un-86'd from the till); this
 * module turns the location's availability overrides into lookups the menu
 * tiles and the builder use to disable them. The server still refuses an 86'd
 * line at Place order (lib/reprice.ts), so this is the cashier-facing half.
 */
import type { LocationMenuOverride, MenuItemDetail } from "@/lib/db";

/** Ids that are 86'd at this location (wire shape on /api/menu). */
export interface MenuAvailability {
  itemIds: string[];
  sizeIds: string[];
  modifierIds: string[];
}

export const NOTHING_86D: MenuAvailability = {
  itemIds: [],
  sizeIds: [],
  modifierIds: [],
};

export function availabilityFromOverrides(
  overrides: readonly Pick<
    LocationMenuOverride,
    "target_type" | "target_id" | "available"
  >[],
): MenuAvailability {
  const out: MenuAvailability = { itemIds: [], sizeIds: [], modifierIds: [] };
  for (const o of overrides) {
    if (o.available !== false) continue;
    if (o.target_type === "item") out.itemIds.push(o.target_id);
    else if (o.target_type === "size") out.sizeIds.push(o.target_id);
    else if (o.target_type === "modifier") out.modifierIds.push(o.target_id);
  }
  return out;
}

export interface SoldOut {
  items: ReadonlySet<string>;
  sizes: ReadonlySet<string>;
  modifiers: ReadonlySet<string>;
}

export function soldOutSets(av: MenuAvailability | undefined | null): SoldOut {
  const a = av ?? NOTHING_86D;
  return {
    items: new Set(a.itemIds),
    sizes: new Set(a.sizeIds),
    modifiers: new Set(a.modifierIds),
  };
}

/** An item can't be sold: it is 86'd, or every one of its sizes is. */
export function isItemSoldOut(item: MenuItemDetail, soldOut: SoldOut): boolean {
  if (soldOut.items.has(item.id)) return true;
  return item.sizes.length > 0 && item.sizes.every((s) => soldOut.sizes.has(s.id));
}

/** Whether the item itself (not just its sizes) is 86'd: what the till toggles. */
export function isItem86d(itemId: string, soldOut: SoldOut): boolean {
  return soldOut.items.has(itemId);
}
