/**
 * Server-side repricing for customer-placed (online) orders.
 *
 * The browser builds the cart, but NEVER gets to name a price: every line is
 * rebuilt here from the location's menu (per-location price + 86 overrides
 * already folded in by `driver.getMenu`). Client-sent names, stations and
 * prices are ignored; only the line id, notes, quantity and the *selection*
 * (item / size / modifier ids + placements) are honoured, and each selection is
 * validated against the menu graph. Line ids are minted HERE (server-side UUIDs):
 * `order_items.id` is a global primary key, so client-chosen ids could collide
 * with (or probe) another order's lines.
 */
import type {
  HalfPlacement,
  ItemSize,
  Menu,
  MenuItemDetail,
  OrderItem,
  OrderItemModifier,
} from "@/lib/db";
import { placementPriceCents } from "@/lib/build-line";
import { withLinePricing } from "@/lib/pricing";

export const MAX_LINE_QUANTITY = 50;
export const MAX_LINE_NOTES = 200;

/** A cart line the menu cannot honour (maps to HTTP 422). */
export class RepriceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepriceError";
  }
}

function findItem(menu: Menu, itemId: string): MenuItemDetail | null {
  for (const c of menu.categories) {
    const hit = c.items.find((i) => i.id === itemId);
    if (hit) return hit;
  }
  return null;
}

const PLACEMENTS: readonly HalfPlacement[] = ["whole", "left", "right"];

function repriceLine(menu: Menu, raw: OrderItem): OrderItem {
  const item =
    typeof raw?.item_id === "string" ? findItem(menu, raw.item_id) : null;
  if (!item) {
    throw new RepriceError("An item in your cart is no longer available.");
  }

  const qty = raw.quantity;
  if (!Number.isInteger(qty) || qty < 1 || qty > MAX_LINE_QUANTITY) {
    throw new RepriceError(
      `Quantity for ${item.name} must be between 1 and ${MAX_LINE_QUANTITY}.`,
    );
  }

  // Size: required when the item has sizes; must belong to the item.
  let size: ItemSize | null = null;
  if (item.sizes.length > 0) {
    size = item.sizes.find((s) => s.id === raw.size_id) ?? null;
    if (!size) {
      throw new RepriceError(`Pick a valid size for ${item.name}.`);
    }
  } else if (raw.size_id) {
    throw new RepriceError(`${item.name} has no sizes.`);
  }

  const rawMods = Array.isArray(raw.modifiers) ? raw.modifiers : [];
  const modifiers: OrderItemModifier[] = [];
  // group id -> modifier id -> placements chosen
  const picked = new Map<string, Map<string, Set<HalfPlacement>>>();

  for (const m of rawMods) {
    const group = item.modifierGroups.find((g) => g.id === m?.group_id);
    const mod = group?.modifiers.find((x) => x.id === m?.modifier_id);
    if (!group || !mod) {
      throw new RepriceError(
        `A modifier on ${item.name} is no longer available.`,
      );
    }
    const placement = m.placement;
    if (!PLACEMENTS.includes(placement)) {
      throw new RepriceError(`Invalid placement for ${mod.name}.`);
    }
    if (
      placement !== "whole" &&
      !(group.supports_half && item.is_half_and_half_capable)
    ) {
      throw new RepriceError(`${mod.name} cannot be placed on a half.`);
    }

    const byMod = picked.get(group.id) ?? new Map<string, Set<HalfPlacement>>();
    const placements = byMod.get(mod.id) ?? new Set<HalfPlacement>();
    // No duplicates, and a whole topping can't also be split.
    if (
      placements.has(placement) ||
      (placement === "whole" && placements.size > 0) ||
      (placement !== "whole" && placements.has("whole"))
    ) {
      throw new RepriceError(`${mod.name} was selected more than once.`);
    }
    placements.add(placement);
    byMod.set(mod.id, placements);
    picked.set(group.id, byMod);

    modifiers.push({
      group_id: group.id,
      group_name: group.name,
      modifier_id: mod.id,
      modifier_name: mod.name,
      price_cents: placementPriceCents(mod.price_cents, placement),
      placement,
    });
  }

  for (const group of item.modifierGroups) {
    const n = picked.get(group.id)?.size ?? 0;
    if (n < group.min_select) {
      throw new RepriceError(
        `Choose at least ${group.min_select} ${group.name} for ${item.name}.`,
      );
    }
    if (n > group.max_select) {
      throw new RepriceError(
        `Choose at most ${group.max_select} ${group.name} for ${item.name}.`,
      );
    }
  }

  const notes =
    typeof raw.notes === "string" && raw.notes.trim()
      ? raw.notes.trim().slice(0, MAX_LINE_NOTES)
      : null;

  return withLinePricing({
    id: crypto.randomUUID(),
    item_id: item.id,
    item_name: item.name,
    station: item.station,
    size_id: size?.id ?? null,
    size_name: size?.name ?? null,
    base_price_cents: size?.price_cents ?? 0,
    quantity: qty,
    modifiers,
    notes,
    voided: false,
    unit_price_cents: 0,
    line_total_cents: 0,
  });
}

/**
 * Rebuild every non-voided line from the menu with fresh server-minted ids.
 * Voided lines are dropped (a
 * customer cart has no use for them). Throws `RepriceError` on the first line
 * the menu cannot honour.
 */
export function repriceItems(menu: Menu, items: OrderItem[]): OrderItem[] {
  return items.filter((i) => !i?.voided).map((i) => repriceLine(menu, i));
}
