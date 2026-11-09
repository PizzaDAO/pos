/**
 * Default size for a menu item opened at the till, and the "can this be added
 * with one tap" rule — pure helpers shared by the builder and the menu grid.
 *
 * The menu has no marked default size, so the till uses a per-device,
 * per-location preference (by size NAME, since size ids differ per item) and
 * falls back to "Large", then the first in-stock size.
 */
import type { ItemSize, MenuItemDetail } from "@/lib/db";

export const FALLBACK_DEFAULT_SIZE = "Large";

const norm = (s: string) => s.trim().toLowerCase();
/** Size names often carry dimensions ('Large (16")'): match on the leading word. */
export const leadWord = (s: string) => norm(s).split(/[^a-z0-9]+/)[0] ?? "";

/**
 * The size to preselect: the preferred name (Large when unset), else the first in
 * stock. A preference that doesn't exist on this item (a stale saved size, a
 * one-size side) falls back to the item's first available size.
 */
export function pickDefaultSize(
  sizes: ItemSize[],
  soldOutSizeIds: ReadonlySet<string>,
  preferredName?: string | null,
): ItemSize | null {
  const inStock = sizes.filter((s) => !soldOutSizeIds.has(s.id));
  if (inStock.length === 0) return null;
  const wanted = preferredName || FALLBACK_DEFAULT_SIZE;
  return (
    inStock.find((s) => norm(s.name) === norm(wanted)) ??
    inStock.find((s) => leadWord(s.name) === leadWord(wanted)) ??
    inStock[0]!
  );
}

/** Default size applies to pizzas (half-capable items) only; sides and drinks take their first size. */
export function defaultSizeFor(
  item: MenuItemDetail,
  soldOutSizeIds: ReadonlySet<string>,
  preferredName?: string | null,
): ItemSize | null {
  if (!item.is_half_and_half_capable) {
    return item.sizes.find((s) => !soldOutSizeIds.has(s.id)) ?? null;
  }
  return pickDefaultSize(item.sizes, soldOutSizeIds, preferredName);
}

/** Whether a saved default size name exists on any item of the menu. */
export function isKnownSizeName(items: MenuItemDetail[], name: string): boolean {
  return items.some((i) => i.sizes.some((s) => leadWord(s.name) === leadWord(name)));
}

/** Distinct size names across the menu items, in first-seen order. */
export function sizeNamesOf(items: MenuItemDetail[]): string[] {
  const seen = new Map<string, string>();
  for (const item of items) {
    for (const s of item.sizes) {
      if (!seen.has(norm(s.name))) seen.set(norm(s.name), s.name);
    }
  }
  return [...seen.values()];
}

/**
 * An item with nothing to choose (at most one size, no required or half-and-half
 * option groups) is added to the cart on tap; long-press or the cart's Edit
 * opens the builder.
 */
export function canQuickAdd(item: MenuItemDetail): boolean {
  return (
    item.sizes.length <= 1 &&
    !item.is_half_and_half_capable &&
    item.modifierGroups.every((g) => g.min_select === 0 && !g.supports_half)
  );
}

const storageKey = (locationId: string) => `till.defaultSize.${locationId}`;

/** Device-local default size name for a location ("" when unset). */
export function readDefaultSizeName(locationId: string): string | null {
  try {
    return window.localStorage.getItem(storageKey(locationId)) || null;
  } catch {
    return null;
  }
}

export function clearDefaultSizeName(locationId: string): void {
  try {
    window.localStorage.removeItem(storageKey(locationId));
  } catch {
    /* ignore */
  }
}

export function writeDefaultSizeName(locationId: string, name: string): void {
  try {
    window.localStorage.setItem(storageKey(locationId), name);
  } catch {
    /* private mode: the choice just doesn't persist */
  }
}
