/**
 * Refunds, voids, comps and discounts on an order (types only, DB-agnostic).
 *
 * Two layers:
 *  - `OrderAdjustment` (on the order, `orders.adjustments`): the comps and
 *    discounts CURRENTLY applied. Σ amount_cents == order.totals.discount_cents
 *    (clamped to the subtotal). Mirrors core's `OrderAdjustment`.
 *  - `AdjustmentRecord` (the `order_adjustments` ledger): one append-only row per
 *    staff action (refund, line void, order void, comp, discount) with who did
 *    it, who approved it, why, and what money moved. The ledger is the audit
 *    trail and the source for item-refund quantities (two tills can never
 *    refund the same unit twice: see `PosDriver.beginOrderRefund`).
 *
 * All money is integer cents.
 */

/** What a staff action did to an order. */
export type AdjustmentKind =
  | "refund"
  | "void_line"
  | "void_order"
  | "comp"
  | "discount";

/** A comp or discount currently applied to an order (core `OrderAdjustment`). */
export interface OrderAdjustment {
  /** Stable id (the ledger record id that applied it). */
  id: string;
  type: "comp" | "discount";
  /** Who/what applied it, e.g. "pos.manual". */
  source: string;
  label: string;
  /** Percent discounts keep their rate (recomputed when lines change). */
  percent_bps: number | null;
  amount_cents: number;
  /** Comp: the line(s) it applies to. Discount: null (whole order). */
  line_ids: string[] | null;
  /** Comp: units of the line comped (null = the whole line). */
  quantity?: number | null;
  reason_code: string;
  reason_text: string | null;
  staff_id: string | null;
  approved_by: string | null;
  created_at: string;
}

/** One selected line for an item refund / void. */
export interface AdjustmentLineSel {
  line_id: string;
  quantity: number;
  /** Money attributed to these units (refund: base food money incl. tax). */
  amount_cents: number;
}

/** Money a refund moved on one tender. */
export interface RefundAllocation {
  payment_id: string;
  rail: string;
  /** Base (food) part refunded on this tender. */
  base_cents: number;
  /** Gratuity part refunded on this tender (flagged: tip refunds are separate). */
  tip_cents: number;
  /** Provider refund id (Stripe re_...), when the rail returned one. */
  processor_ref: string | null;
  /** Crypto rails only record the refund: staff must send it by hand. */
  manual: boolean;
  /** Cash refunds: the drawer cash-out event, or why none was recorded. */
  drawer_event_id?: string | null;
  drawer_note?: string | null;
}

export type AdjustmentStatus = "pending" | "completed" | "partial" | "failed";

/** A row of the `order_adjustments` ledger. */
export interface AdjustmentRecord {
  /** Client-minted request id (idempotency key): a retry lands on the same row. */
  id: string;
  tenant_id: string;
  location_id: string;
  order_id: string;
  kind: AdjustmentKind;
  status: AdjustmentStatus;
  /** Base (non-tip) money the action is worth (refunded / voided / comped). */
  amount_cents: number;
  /** Refunds: the gratuity part (kept separate and flagged). */
  tip_cents: number;
  /** Item refunds / voids / comps: which units. */
  lines: AdjustmentLineSel[];
  /** Refunds: what each tender returned. */
  allocations: RefundAllocation[];
  reason_code: string;
  reason_text: string | null;
  /** Active (PIN-switched) staff member, when known. */
  staff_id: string | null;
  /** The device login that made the request. */
  actor_user_id: string;
  /** Manager who approved it by PIN (above the location threshold). */
  approved_by: string | null;
  /** Free-form extras (percent_bps, error text, ...). */
  meta: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

/** Per-location approval thresholds (`store_settings.adjustment_policy`). */
export interface AdjustmentPolicy {
  /**
   * A refund worth MORE than this (base + tip, cents) needs an owner/manager:
   * either the active staff member or a manager PIN. 0 = every refund.
   */
  refund_approval_cents: number;
  /** Same for a comp or discount (its amount). 0 = every comp/discount. */
  comp_approval_cents: number;
  /** Same for voiding a line or order that was already sent to the kitchen. */
  void_approval_cents: number;
}

/** Defaults keep today's rule: only an owner/manager refunds or discounts. */
export const DEFAULT_ADJUSTMENT_POLICY: AdjustmentPolicy = {
  refund_approval_cents: 0,
  comp_approval_cents: 0,
  void_approval_cents: 0,
};

/** Outcome of the atomic item-refund reservation. */
export type BeginRefundResult =
  | { outcome: "ok"; record: AdjustmentRecord }
  /** This request id already exists: a retry (the caller returns it). */
  | { outcome: "duplicate"; record: AdjustmentRecord }
  | { outcome: "not_found" }
  /** A line is voided, unknown, or would be refunded past its quantity. */
  | { outcome: "exceeds"; line_id: string; available: number };

/** What `applyOrderEdit` writes (computed by `src/lib/adjustments/order-edit.ts`). */
export interface OrderEditWrite {
  orderId: string;
  tenantId: string;
  /** The order version the edit was computed from (compare-and-set). */
  expectVersion: number;
  /** Lines to void whole. */
  voidLineIds: string[];
  /**
   * Partial voids: keep `keep_quantity` units on `line_id` (repriced), and add
   * a voided copy `new_line_id` holding the voided units.
   */
  splits: { line_id: string; new_line_id: string; keep_quantity: number; void_quantity: number }[];
  totals: import("./menu-types").OrderTotals;
  discountCents: number;
  adjustments: OrderAdjustment[];
  /** Move the order to `voided` (void_order). */
  voidOrder: boolean;
  /** The ledger row to insert in the same transaction. */
  record: AdjustmentRecord;
}

export type OrderEditResult =
  | { outcome: "ok"; order: import("./menu-types").Order; record: AdjustmentRecord }
  | { outcome: "duplicate"; record: AdjustmentRecord }
  | { outcome: "not_found" }
  /** The order changed since it was read (version moved): re-read and retry. */
  | { outcome: "stale" }
  /** Settled money no longer fits the new amount due, or the status forbids it. */
  | { outcome: "invalid_state"; reason: string };
