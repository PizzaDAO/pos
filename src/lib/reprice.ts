/**
 * Server-side order repricing (pure; no I/O).
 *
 * The browser builds priced `OrderItem` lines for a live preview, but NOTHING
 * it sends about money is trusted: every line is re-resolved against the
 * location's menu graph (`getMenu`, which already folds per-location price
 * overrides and drops 86'd items/modifiers) and re-priced from scratch:
 *
 *   unit = size.price_cents (or 0 for size-less items)
 *        + Σ placementPriceCents(modifier.price_cents, placement)
 *
 * using the same half-and-half rule as the builder (half = ceil(price / 2),
 * whole = full price; half placements only in groups that support halves).
 * Names/stations come from the menu too. Unknown, unavailable or 86'd items /
 * sizes / modifiers, and malformed lines, raise {@link RepriceError} (→ 422).
 */
import type {
  HalfPlacement,
  Menu,
  MenuItemDetail,
  OrderItem,
  OrderItemModifier,
} from "@/lib/db";
import { placementPriceCents } from "@/lib/build-line";
import { withLinePricing } from "@/lib/pricing";

export class RepriceError extends Error {
  readonly status = 422;
}

export const MAX_ORDER_LINES = 100;
export const MAX_LINE_QUANTITY = 99;
const MAX_MODIFIERS_PER_LINE = 50;
const MAX_NOTE_LENGTH = 500;
const PLACEMENTS: HalfPlacement[] = ["whole", "left", "right"];

export interface RepriceOptions {
  /** Size ids 86'd at this location (size availability overrides). */
  unavailableSizeIds?: ReadonlySet<string>;
  /**
   * How to treat voided lines (kept on terminal orders for audit, excluded
   * from totals): "drop" removes them; "keep" re-prices them when they still
   * resolve and otherwise keeps them with zeroed prices (never money-bearing).
   */
  voided?: "drop" | "keep";
}

function indexMenu(menu: Menu): Map<string, MenuItemDetail> {
  const byId = new Map<string, MenuItemDetail>();
  for (const cat of menu.categories) {
    for (const item of cat.items) byId.set(item.id, item);
  }
  return byId;
}

function str(v: unknown, max = 200): string | null {
  return typeof v === "string" && v.length > 0 && v.length <= max ? v : null;
}

/** Re-price one non-voided line strictly; throws RepriceError if invalid. */
function repriceLine(
  raw: Record<string, unknown>,
  item: MenuItemDetail | undefined,
  unavailableSizeIds: ReadonlySet<string>,
): OrderItem {
  const lineId = str(raw.id);
  if (!lineId) throw new RepriceError("Each line needs an id.");
  if (!item) {
    throw new RepriceError(
      "An item in your order is no longer available. Please review your cart.",
    );
  }

  const quantity = raw.quantity;
  if (
    typeof quantity !== "number" ||
    !Number.isInteger(quantity) ||
    quantity < 1 ||
    quantity > MAX_LINE_QUANTITY
  ) {
    throw new RepriceError(`Invalid quantity for ${item.name}.`);
  }

  // ---- size → base price ----------------------------------------------------
  let sizeId: string | null = null;
  let sizeName: string | null = null;
  let base = 0;
  if (item.sizes.length > 0) {
    const size = item.sizes.find((s) => s.id === raw.size_id);
    if (!size || unavailableSizeIds.has(size.id)) {
      throw new RepriceError(`That size of ${item.name} is unavailable.`);
    }
    sizeId = size.id;
    sizeName = size.name;
    base = size.price_cents;
  } else if (raw.size_id != null) {
    throw new RepriceError(`${item.name} has no sizes.`);
  }

  // ---- modifiers (incl. half-and-half) ----------------------------------------
  const rawMods = raw.modifiers ?? [];
  if (!Array.isArray(rawMods) || rawMods.length > MAX_MODIFIERS_PER_LINE) {
    throw new RepriceError(`Invalid options for ${item.name}.`);
  }
  const seen = new Set<string>();
  const modifiers: OrderItemModifier[] = rawMods.map((m: unknown) => {
    const rm = (m ?? {}) as Record<string, unknown>;
    const group = item.modifierGroups.find((g) => g.id === rm.group_id);
    const mod = group?.modifiers.find((x) => x.id === rm.modifier_id);
    if (!group || !mod) {
      throw new RepriceError(
        `An option on ${item.name} is no longer available.`,
      );
    }
    const placement = (rm.placement ?? "whole") as HalfPlacement;
    if (!PLACEMENTS.includes(placement)) {
      throw new RepriceError(`Invalid placement for ${mod.name}.`);
    }
    if (placement !== "whole" && !group.supports_half) {
      throw new RepriceError(`${mod.name} can't be placed on half a pizza.`);
    }
    if (seen.has(mod.id)) {
      throw new RepriceError(`${mod.name} was selected twice.`);
    }
    seen.add(mod.id);
    return {
      group_id: group.id,
      group_name: group.name,
      modifier_id: mod.id,
      modifier_name: mod.name,
      price_cents: placementPriceCents(mod.price_cents, placement),
      placement,
    };
  });

  const notes =
    typeof raw.notes === "string" && raw.notes.trim()
      ? raw.notes.trim().slice(0, MAX_NOTE_LENGTH)
      : null;

  return withLinePricing({
    id: lineId,
    item_id: item.id,
    item_name: item.name,
    station: item.station,
    size_id: sizeId,
    size_name: sizeName,
    base_price_cents: base,
    quantity,
    modifiers,
    notes,
    voided: false,
    unit_price_cents: 0,
    line_total_cents: 0,
  });
}

/**
 * Re-price client-supplied order lines against the location menu. Returns
 * server-priced lines; throws {@link RepriceError} on any invalid line.
 */
export function repriceOrderItems(
  menu: Menu,
  rawItems: unknown,
  opts: RepriceOptions = {},
): OrderItem[] {
  if (!Array.isArray(rawItems)) throw new RepriceError("items must be a list.");
  if (rawItems.length > MAX_ORDER_LINES) {
    throw new RepriceError("Too many lines in this order.");
  }
  const byId = indexMenu(menu);
  const unavailable = opts.unavailableSizeIds ?? new Set<string>();
  const voidedMode = opts.voided ?? "drop";

  const out: OrderItem[] = [];
  const lineIds = new Set<string>();
  for (const entry of rawItems) {
    if (!entry || typeof entry !== "object") {
      throw new RepriceError("Malformed order line.");
    }
    const raw = entry as Record<string, unknown>;
    const item = typeof raw.item_id === "string" ? byId.get(raw.item_id) : undefined;

    let line: OrderItem;
    if (raw.voided === true) {
      if (voidedMode === "drop") continue;
      // Audit-only line: re-price if it still resolves, else zero it out.
      try {
        line = { ...repriceLine(raw, item, unavailable), voided: true };
      } catch {
        const lineId = str(raw.id);
        if (!lineId) throw new RepriceError("Each line needs an id.");
        line = {
          id: lineId,
          item_id: typeof raw.item_id === "string" ? raw.item_id : "",
          item_name: item?.name ?? str(raw.item_name) ?? "Unknown item",
          station: item?.station,
          size_id: null,
          size_name: null,
          base_price_cents: 0,
          quantity: 1,
          modifiers: [],
          notes: null,
          voided: true,
          unit_price_cents: 0,
          line_total_cents: 0,
        };
      }
      line = withLinePricing(line);
    } else {
      line = repriceLine(raw, item, unavailable);
    }

    if (lineIds.has(line.id)) throw new RepriceError("Duplicate line id.");
    lineIds.add(line.id);
    out.push(line);
  }
  return out;
}

/**
 * Upper bound for a voluntary tip: the greater of 100% of the pre-tip total
 * or $20 (in the order's minor units). Keeps typos / abuse bounded without
 * blocking generous tips on small orders.
 */
export function maxTipCents(preTipTotalCents: number): number {
  return Math.max(preTipTotalCents, 2_000);
}
