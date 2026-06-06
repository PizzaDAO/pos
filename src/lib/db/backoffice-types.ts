/**
 * Back-office domain row types (Phase 5).
 *
 * Mirrors the intended Supabase tables described in PLAN.md:
 *   - `location_menu_overrides` (per-location price/availability)
 *   - `inventory_items`, `inventory_movements`, `item_inventory_links`
 *   - `staff`, `shifts`, `shift_cash_events`
 *   - `business_day_closes` (idempotent Z-report close-out)
 *
 * Kept DB-agnostic so the in-memory mock driver and a future Supabase driver
 * share the same shapes. All money is integer minor units (cents) — never floats.
 */
import type { MembershipRole } from "./types";

// ----------------------------------------------------------------------------
// Menu management — CRUD input payloads
// ----------------------------------------------------------------------------

/** Create/update payload for a menu category. */
export interface CategoryInput {
  id?: string;
  tenant_id: string;
  name: string;
  sort_order?: number;
}

/** Create/update payload for a menu item (tenant-level definition). */
export interface ItemInput {
  id?: string;
  tenant_id: string;
  category_id: string;
  name: string;
  description?: string | null;
  is_half_and_half_capable?: boolean;
  station?: import("./menu-types").Station;
}

/** Create/update payload for an item size (base price at a size). */
export interface SizeInput {
  id?: string;
  item_id: string;
  name: string;
  price_cents: number;
  sort_order?: number;
}

/** Create/update payload for a modifier group. */
export interface ModifierGroupInput {
  id?: string;
  tenant_id: string;
  name: string;
  min_select?: number;
  max_select?: number;
  /** Half-and-half flag (modifiers placeable left/right). */
  supports_half?: boolean;
}

/** Create/update payload for a single modifier. */
export interface ModifierInput {
  id?: string;
  group_id: string;
  name: string;
  price_cents: number;
  sort_order?: number;
}

// ----------------------------------------------------------------------------
// Per-location menu overrides (Phase 0 `location_menu_overrides` concept)
// ----------------------------------------------------------------------------

/**
 * A per-location override of a menu element's price and/or availability. The
 * override target is either an item (86 the whole item at this location), a
 * specific size (override its base price), or a modifier (override its
 * up-charge). The mock driver folds these into `getMenu` so terminal/shop reads
 * reflect them without any call-site change.
 */
export type OverrideTargetType = "item" | "size" | "modifier";

export interface LocationMenuOverride {
  id: string;
  tenant_id: string;
  location_id: string;
  target_type: OverrideTargetType;
  /** id of the item/size/modifier being overridden. */
  target_id: string;
  /** Override price in cents (size/modifier). null = inherit tenant price. */
  price_cents: number | null;
  /** Availability override. false = 86'd at this location. null = inherit. */
  available: boolean | null;
  updated_at: string;
}

/** Upsert payload for a per-location override. */
export interface OverrideInput {
  tenant_id: string;
  location_id: string;
  target_type: OverrideTargetType;
  target_id: string;
  price_cents?: number | null;
  available?: boolean | null;
}

// ----------------------------------------------------------------------------
// Inventory (per location)
// ----------------------------------------------------------------------------

/** A unit of measure for an inventory item. Free-form for the pilot. */
export type InventoryUnit = "each" | "g" | "kg" | "oz" | "lb" | "ml" | "l";

/**
 * A stock-keeping item held at a single location. Quantity is tracked in
 * `unit` and stored as an integer in the smallest tracked granularity
 * (e.g. grams). `low_threshold` triggers a low-stock alert when on-hand drops
 * to/below it.
 */
export interface InventoryItem {
  id: string;
  tenant_id: string;
  location_id: string;
  name: string;
  unit: InventoryUnit;
  /** Current on-hand quantity (integer in `unit`). */
  on_hand: number;
  /** Low-stock alert threshold (integer in `unit`). */
  low_threshold: number;
  created_at: string;
  updated_at: string;
}

/** Why an inventory level changed. */
export type MovementReason =
  | "depletion" // sold — auto-decrement on order placement
  | "restock" // received stock
  | "adjustment" // manual count correction
  | "waste"; // spoilage / comp

/** An audit-trail entry for every change to an inventory level. */
export interface InventoryMovement {
  id: string;
  tenant_id: string;
  location_id: string;
  inventory_item_id: string;
  reason: MovementReason;
  /** Signed delta applied to on-hand (negative for depletion/waste). */
  delta: number;
  /** Resulting on-hand after this movement (for a readable ledger). */
  resulting_on_hand: number;
  /** Linked order id when reason = depletion. */
  order_id: string | null;
  note: string | null;
  created_at: string;
}

/**
 * Links a menu element (item or modifier) to an inventory item, with the qty
 * consumed per unit sold. Depletion walks an order's lines + modifiers and
 * decrements each linked inventory item by qty * line quantity.
 */
export interface ItemInventoryLink {
  id: string;
  tenant_id: string;
  /** "item" links by menu item id; "modifier" links by modifier id. */
  source_type: "item" | "modifier";
  source_id: string;
  inventory_item_id: string;
  /** Quantity of the inventory item consumed per one sold (integer in unit). */
  qty_per_unit: number;
}

/** Inventory item + its derived low-stock flag (for list views). */
export interface InventoryItemView extends InventoryItem {
  low: boolean;
}

// ----------------------------------------------------------------------------
// Staff & shifts
// ----------------------------------------------------------------------------

/** A staff member of a tenant. Role reuses the tenancy membership roles. */
export interface Staff {
  id: string;
  tenant_id: string;
  name: string;
  role: MembershipRole;
  /** Whether this staff member is currently employed/active. */
  active: boolean;
  /**
   * Salted hash of the staff member's quick-switch PIN (scrypt;
   * `scrypt$<saltHex>$<hashHex>`), or null if no PIN is set. NEVER exposed to
   * the client — the terminal verifies a PIN server-side via /api/terminal/pin
   * and only ever receives the resulting active-staff id back. See
   * `src/lib/auth/pin.ts`.
   */
  pin_hash?: string | null;
  created_at: string;
}

/** Lifecycle of a shift. */
export type ShiftStatus = "open" | "closed";

/**
 * A worked shift at a location with an attached cash drawer. Opens with a float,
 * accrues cash tenders during the shift, and reconciles on close (expected vs
 * counted → over/short). Times are ISO strings.
 */
export interface Shift {
  id: string;
  tenant_id: string;
  location_id: string;
  staff_id: string;
  status: ShiftStatus;
  /** Clock-in time. */
  opened_at: string;
  /** Clock-out time (null while open). */
  closed_at: string | null;
  /** Opening drawer float, in cents. */
  opening_float_cents: number;
  /**
   * Counted drawer total at close, in cents (null while open). Set at
   * reconciliation; over/short = counted - expected.
   */
  counted_cents: number | null;
  /** Free-form reconciliation note (e.g. reason for a shortage). */
  close_note: string | null;
  created_at: string;
}

/** A discrete cash event recorded against an open shift's drawer. */
export type CashEventType = "sale" | "payout" | "paid_in" | "drop";

export interface ShiftCashEvent {
  id: string;
  shift_id: string;
  tenant_id: string;
  location_id: string;
  type: CashEventType;
  /** Signed delta to the drawer cash, in cents (negative for payout/drop). */
  amount_cents: number;
  /** Linked order id for sale events. */
  order_id: string | null;
  note: string | null;
  created_at: string;
}

/** Drawer reconciliation summary for a (closing) shift. */
export interface DrawerReconciliation {
  opening_float_cents: number;
  /** Sum of cash sale tenders during the shift, in cents. */
  cash_sales_cents: number;
  /** Sum of paid-in events, in cents. */
  paid_in_cents: number;
  /** Sum of payouts/drops (positive magnitude), in cents. */
  payouts_cents: number;
  /** Expected drawer = float + cash sales + paid-in − payouts. */
  expected_cents: number;
  /** Counted drawer at close, in cents (null until counted). */
  counted_cents: number | null;
  /** counted − expected; positive = over, negative = short (null until counted). */
  over_short_cents: number | null;
}

// ----------------------------------------------------------------------------
// Reports
// ----------------------------------------------------------------------------

/** Inclusive date range filter for reports (ISO yyyy-mm-dd in location tz). */
export interface DateRange {
  /** Inclusive start date "yyyy-mm-dd", or null for open-ended. */
  from: string | null;
  /** Inclusive end date "yyyy-mm-dd", or null for open-ended. */
  to: string | null;
}

/** Money rollup for a named bucket (item, category, channel, rail, day, …). */
export interface SalesBucket {
  key: string;
  label: string;
  /** Count of orders/units in this bucket. */
  count: number;
  /** Gross sales (line totals incl. mods) attributable to the bucket, cents. */
  gross_cents: number;
}

/** Payment-mix slice (cash / card / crypto), by rail. */
export interface PaymentMixSlice {
  rail: string;
  label: string;
  count: number;
  amount_cents: number;
  tip_cents: number;
  application_fee_cents: number;
}

/**
 * A computed sales report over a set of orders/payments, sliced multiple ways.
 * Used by both the per-location report and the tenant rollup (which aggregates
 * across locations). All money integer cents.
 */
export interface SalesReport {
  tenant_id: string;
  /** location_id when scoped to one location; null for a tenant rollup. */
  location_id: string | null;
  range: DateRange;
  /** Orders counted (non-void) in the range. */
  order_count: number;
  gross_cents: number;
  discount_cents: number;
  net_cents: number;
  tax_cents: number;
  tip_cents: number;
  /** Platform fees taken (Connect application_fee) across tenders, cents. */
  fees_cents: number;
  void_count: number;
  void_cents: number;
  refund_count: number;
  refund_cents: number;
  byDay: SalesBucket[];
  byItem: SalesBucket[];
  byCategory: SalesBucket[];
  byChannel: SalesBucket[];
  byLocation: SalesBucket[];
  paymentMix: PaymentMixSlice[];
}

// ----------------------------------------------------------------------------
// End-of-day (Z-report)
// ----------------------------------------------------------------------------

/**
 * A persisted, idempotent end-of-day close for one location + business day.
 * Re-closing the same (location, business_date) returns the stored snapshot
 * (the totals captured at first close), so a Z-report can't be double-run.
 */
export interface BusinessDayClose {
  id: string;
  tenant_id: string;
  location_id: string;
  /** Business date "yyyy-mm-dd" in the location timezone. */
  business_date: string;
  closed_at: string;
  /** Frozen report snapshot at close. */
  report: SalesReport;
  /** Drawer summary across shifts closed in the day (cents). */
  drawer: {
    opening_float_cents: number;
    cash_sales_cents: number;
    expected_cents: number;
    counted_cents: number;
    over_short_cents: number;
    shift_count: number;
  };
}
