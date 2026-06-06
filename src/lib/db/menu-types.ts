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

/**
 * Opening hours for a single weekday (Phase 4 online-ordering gate). Times are
 * local "HH:MM" 24h strings in the location's timezone. `closed` shops accept
 * no orders that day. A window may wrap past midnight (open > close) — handled
 * by the scheduling helpers.
 */
export interface DayHours {
  /** 0 = Sunday … 6 = Saturday (JS getDay()). */
  weekday: number;
  open: string;
  close: string;
  closed: boolean;
}

/**
 * A delivery zone (Phase 4) defined by a list of in-range postal codes. Real
 * geo-fencing (polygons/radius) is a later concern; postal-code matching is
 * enough for the pilot + keeps the mock deterministic with no env. Fee + ETA are
 * integer cents / minutes.
 */
export interface DeliveryZone {
  id: string;
  name: string;
  /** Postal codes served by this zone (exact match, case-insensitive). */
  postal_codes: string[];
  /** Flat delivery fee for this zone, in integer cents. */
  fee_cents: number;
  /** Estimated extra delivery minutes added to the kitchen prep time. */
  eta_minutes: number;
  /** Minimum order subtotal (cents) required to deliver to this zone. */
  min_subtotal_cents: number;
}

/**
 * Per-location online-ordering / fulfillment configuration (Phase 4). Kept on
 * store settings so the storefront, scheduler, and delivery providers share one
 * source of truth. All optional so Phase 1–3 settings still satisfy the type.
 */
export interface FulfillmentSettings {
  /** Whether the location accepts online pickup orders. */
  pickup_enabled: boolean;
  /** Whether the location accepts online delivery orders. */
  delivery_enabled: boolean;
  /** Minutes the kitchen needs before an order is ready (ASAP gate). */
  prep_minutes: number;
  /** Minimum lead time (minutes) for a SCHEDULED order beyond prep. */
  scheduling_lead_minutes: number;
  /** How many days ahead a customer may schedule. */
  scheduling_horizon_days: number;
  /** Weekly opening hours used to gate ASAP + scheduled times. */
  hours: DayHours[];
  /** Delivery zones (postal-code → fee/ETA). Empty = nowhere in range. */
  delivery_zones: DeliveryZone[];
  /**
   * Delivery providers this location offers, in preference order. The first
   * available (registered) provider is used to quote/dispatch. Keys match
   * `DeliveryProviderKey` but are typed as string here to avoid a cross-import.
   */
  delivery_providers: string[];
  /** Pickup address shown to the customer / used as the delivery pickup point. */
  pickup_address?: string;
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
  /** Online-ordering / fulfillment config (Phase 4). Optional; a default applies. */
  fulfillment?: FulfillmentSettings;
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
  // Online delivery: stays on the board while out for delivery (Phase 4).
  "out_for_delivery",
] as const;

export type OrderChannel = "in_store" | "online_pickup" | "online_delivery";

/** How an online order is fulfilled (Phase 4). */
export type FulfillmentType = "pickup" | "delivery";

/**
 * Customer-supplied fulfillment details attached to an online order (Phase 4).
 * Absent on in-store orders. Kept on the order so the KDS, confirmation, and
 * tracking surfaces can render pickup-vs-delivery + the scheduled time without
 * a second lookup.
 */
export interface OrderFulfillment {
  type: FulfillmentType;
  /** "asap" or an ISO timestamp the customer scheduled the order for. */
  scheduled_for: "asap" | string;
  /** Promised-ready ISO timestamp (now + prep, or the scheduled time). */
  promised_at: string;
  /** Delivery address (delivery only). */
  address?: DeliveryAddress;
  /** Resolved delivery zone id (delivery only). */
  zone_id?: string;
  /** Delivery fee in cents, already folded into the order subtotal (delivery only). */
  delivery_fee_cents?: number;
  /** Customer-facing delivery instructions (delivery only). */
  delivery_notes?: string;
}

/** A structured delivery address (Phase 4). */
export interface DeliveryAddress {
  line1: string;
  line2?: string;
  city: string;
  region: string;
  postal_code: string;
  country: string;
}

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
  /** Online-order customer id (Phase 4); null for in-store / guest-less orders. */
  customer_id?: string | null;
  /**
   * Attributed staff member (the active terminal staff via PIN quick-switch);
   * null for online / unattributed orders. Real-auth (Phase 7) sets this from
   * the PIN-verified active staff so orders/shifts tie to the person at the till.
   */
  staff_id?: string | null;
  /** Online-order fulfillment details (Phase 4); absent on in-store orders. */
  fulfillment?: OrderFulfillment;
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
  /** Online-order customer id (Phase 4). */
  customer_id?: string | null;
  /** Attributed staff member (PIN quick-switch active staff); null if none. */
  staff_id?: string | null;
  /** Online-order fulfillment details (Phase 4). */
  fulfillment?: OrderFulfillment;
}
