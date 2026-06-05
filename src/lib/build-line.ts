/**
 * Translate pizza-builder selections into a priced OrderItem line.
 *
 * Half-and-half model: a topping can be placed `left`, `right`, or `whole`. Each
 * placement is a distinct `OrderItemModifier`. Half placements are charged at
 * half the whole-pie modifier price (rounded up to the cent); `whole` is full
 * price. This keeps left+right of the same topping equal to a whole topping.
 */
import type {
  HalfPlacement,
  ItemSize,
  MenuItemDetail,
  Modifier,
  ModifierGroup,
  OrderItem,
  OrderItemModifier,
} from "@/lib/db";
import { withLinePricing } from "@/lib/pricing";

export interface BuilderModifierSelection {
  group: ModifierGroup;
  modifier: Modifier;
  placement: HalfPlacement;
}

export interface BuildLineInput {
  item: MenuItemDetail;
  size: ItemSize | null;
  selections: BuilderModifierSelection[];
  quantity: number;
  notes: string;
  /** Existing line id when editing; a new UUID is generated otherwise. */
  lineId?: string;
}

/** Price for a modifier given its placement (half = half price, rounded up). */
export function placementPriceCents(
  base: number,
  placement: HalfPlacement,
): number {
  if (placement === "whole") return base;
  return Math.ceil(base / 2);
}

function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  // Fallback (very old runtimes) — not cryptographically strong, fine for ids.
  return `line-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function buildLine(input: BuildLineInput): OrderItem {
  const { item, size, selections, quantity, notes, lineId } = input;

  const modifiers: OrderItemModifier[] = selections.map((sel) => ({
    group_id: sel.group.id,
    group_name: sel.group.name,
    modifier_id: sel.modifier.id,
    modifier_name: sel.modifier.name,
    price_cents: placementPriceCents(sel.modifier.price_cents, sel.placement),
    placement: sel.placement,
  }));

  const line: OrderItem = {
    id: lineId ?? newId(),
    item_id: item.id,
    item_name: item.name,
    station: item.station,
    size_id: size?.id ?? null,
    size_name: size?.name ?? null,
    base_price_cents: size?.price_cents ?? 0,
    quantity: Math.max(1, quantity),
    modifiers,
    notes: notes.trim() ? notes.trim() : null,
    voided: false,
    unit_price_cents: 0,
    line_total_cents: 0,
  };

  return withLinePricing(line);
}
