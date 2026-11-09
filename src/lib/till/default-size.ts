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

/** The size to preselect: preferred name, then Large, then the first in stock. */
export function pickDefaultSize(
  sizes: ItemSize[],
  soldOutSizeIds: ReadonlySet<string>,
  preferredName?: string | null,
): ItemSize | null {
  const inStock = sizes.filter((s) => !soldOutSizeIds.has(s.id));
  if (inStock.length === 0) return null;
  for (const wanted of [preferredName, FALLBACK_DEFAULT_SIZE]) {
    if (!wanted) continue;
    const hit =
      inStock.find((s) => norm(s.name) === norm(wanted)) ??
      inStock.find((s) => leadWord(s.name) === leadWord(wanted));
    if (hit) return hit;
  }
  return inStock[0]!;
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

export function writeDefaultSizeName(locationId: string, name: string): void {
  try {
    window.localStorage.setItem(storageKey(locationId), name);
  } catch {
    /* private mode: the choice just doesn't persist */
  }
}
