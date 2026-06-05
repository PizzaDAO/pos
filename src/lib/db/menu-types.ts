/**
 * Menu + order domain row types (Phase 1).
 *
 * These mirror the intended Supabase schema described in `supabase/seed.sql`
 * (menu_categories, menu_items, item_sizes, modifier_groups, modifiers,
 * item_modifier_groups) and the `orders` family. They are kept DB-agnostic so
 * the in-memory mock driver and a future Supabase driver share the same shapes.
 *
 * Money is always stored as integer cents to avoid floating-point drift.
 */

export interface MenuCategory {
  id: string;
  tenant_id: string;
  name: string;
  sort_order: number;
}

/**
 * Kitchen station an item is prepared at. Used by the KDS (Phase 3) to route
 * line items so each station only sees its own work. `none` means the item
 * needs no kitchen prep (e.g. a canned drink) and is hidden from station views.
 */
export type Station = "oven" | "cold" | "fryer" | "expo" | "none";

export interface MenuItem {
  id: string;
  tenant_id: string;
  category_id: string;
  name: string;
  description: string | null;
  /** Whether this item can be built as a half-and-half pizza. */
  is_half_and_half_capable: boolean;
  /** Kitchen station this item is prepared at (Phase 3 KDS routing). */
  station: Station;
}

export interface ItemSize {
  id: string;
  item_id: string;
  name: string;
  /** Base price for the item at this size, in integer cents. */
  price_cents: number;
  sort_order: number;
}

export interface ModifierGroup {
  id: string;
  tenant_id: string;
  name: string;
  min_select: number;
  max_select: number;
  /** Whether modifiers in this group can be placed on left/right halves. */
  supports_half: boolean;
}

export interface Modifier {
  id: string;
  group_id: string;
  name: string;
  /** Up-charge for selecting this modifier (whole-pie), in integer cents. */
  price_cents: number;
  sort_order: number;
}

export interface ItemModifierGroup {
  item_id: string;
  group_id: string;
  sort_order: number;
}

/**
 * Denormalized menu graph for a single location, ready for the terminal UI.
 * Built by the driver so call sites never assemble joins themselves.
 */
export interface MenuModifierGroup extends ModifierGroup {
  modifiers: Modifier[];
}

export interface MenuItemDetail extends MenuItem {
  sizes: ItemSize[];
  modifierGroups: MenuModifierGroup[];
}

export interface MenuCategoryWithItems extends MenuCategory {
  items: MenuItemDetail[];
}

export interface Menu {
  tenantId: string;
  locationId: string;
  categories: MenuCategoryWithItems[];
}

/**
 * KDS age-coloring thresholds (Phase 3), in seconds since an order was placed.
 * A ticket renders green below `warn_seconds`, yellow at/after it, and red at/
 * after `urgent_seconds`. Pulled from store settings so each location can tune
 * its own "this order is getting old" cadence.
 */
export interface KdsThresholds {
  warn_seconds: number;
  urgent_seconds: number;
}

/** Per-location store settings (tax, rounding, currency) — mocked in Phase 1. */
export interface StoreSettings {
  tenant_id: string;
  location_id: string;
  currency: string;
  /** Tax rate in basis points (e.g. 825 = 8.25%). Integer to avoid float drift. */
  tax_rate_bps: number;
  /** Default tip percentage suggestions (Phase 2 wires real tipping). */
  tip_presets_bps: number[];
  /** KDS age-coloring thresholds (Phase 3). Optional; a default is applied. */
  kds_thresholds?: KdsThresholds;
}

// ----------------------------------------------------------------------------
// Orders
// ----------------------------------------------------------------------------

export type OrderStatus =
  | "draft"
  | "placed"
  | "paid"
  | "in_kitchen"
  | "ready"
  | "recall"
  | "out_for_delivery"
  | "completed"
  | "voided"
  | "refunded";

/**
 * KDS status flow (Phase 3). A bumpable order moves forward through this set;
 * `recall` pulls a bumped (`ready`/`completed`) order back onto the board.
 *
 *   placed → in_kitchen → ready → completed
 *                  ▲          │
 *                  └── recall ─┘  (recall re-opens a bumped ticket)
 *
 * `paid` is treated as an active kitchen state (paid-at-counter, awaiting prep)
 * so paying for an order surfaces it on the board.
 */
export const KDS_ACTIVE_STATUSES: readonly OrderStatus[] = [
  "placed",
  "paid",
  "in_kitchen",
  "ready",
  "recall",
] as const;

export type OrderChannel = "in_store" | "online_pickup" | "online_delivery";

/** Which half of a pizza a topping is placed on. */
export type HalfPlacement = "left" | "right" | "whole";

export interface OrderItemModifier {
  group_id: string;
  group_name: string;
  modifier_id: string;
  modifier_name: string;
  /** Effective price for this modifier on this line, in cents. */
  price_cents: number;
  placement: HalfPlacement;
}

export interface OrderItem {
  /** Stable client-generated id for this cart/order line. */
  id: string;
  item_id: string;
  item_name: string;
  /**
   * Kitchen station this line routes to (Phase 3 KDS). Optional on the wire so
   * older/queued orders without it still parse; the KDS resolves a fallback
   * from the menu when absent.
   */
  station?: Station;
  size_id: string | null;
  size_name: string | null;
  /** Per-unit base price (size price), in cents. */
  base_price_cents: number;
  quantity: number;
  modifiers: OrderItemModifier[];
  notes: string | null;
  /** Whether the line has been voided (kept for audit, excluded from totals). */
  voided: boolean;
  /** Per-unit total = base + sum(modifiers). Convenience, recomputed on write. */
  unit_price_cents: number;
  /** line total = unit_price_cents * quantity (0 when voided). */
  line_total_cents: number;
}

export interface OrderTotals {
  subtotal_cents: number;
  discount_cents: number;
  taxable_cents: number;
  tax_cents: number;
  tip_cents: number;
  total_cents: number;
}

export interface Order {
  /** Client-side UUID — also the idempotency key for upsert-by-UUID. */
  id: string;
  tenant_id: string;
  location_id: string;
  status: OrderStatus;
  channel: OrderChannel;
  currency: string;
  items: OrderItem[];
  /** Order-level discount in cents (already applied to totals). */
  discount_cents: number;
  totals: OrderTotals;
  notes: string | null;
  /** Human-friendly sequential order number, assigned at placement. */
  order_number: string;
  created_at: string;
  updated_at: string;
}

/** Payload accepted by `createOrder` — driver assigns number/timestamps. */
export interface CreateOrderInput {
  id: string;
  tenant_id: string;
  location_id: string;
  channel: OrderChannel;
  currency: string;
  items: OrderItem[];
  discount_cents: number;
  totals: OrderTotals;
  notes: string | null;
  /** Optional pre-assigned order number (e.g. queued offline). */
  order_number?: string;
  /** Optional status override; defaults to "placed". */
  status?: OrderStatus;
}
