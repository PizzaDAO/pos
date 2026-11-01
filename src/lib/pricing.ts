/**
 * Pure pricing helpers — single source of truth for line prices and order
 * totals. Everything is integer cents; rounding happens once, at tax.
 *
 * Used by the pizza builder (live preview), the cart store (line + running
 * subtotal), and the totals panel (subtotal → discount → tax → total).
 */
import type {
  OrderFeeLine,
  OrderItem,
  OrderItemModifier,
  OrderTotals,
} from "@/lib/db";

/** Per-unit price of a line: base size price + sum of (non-voided) modifiers. */
export function computeUnitPriceCents(
  basePriceCents: number,
  modifiers: OrderItemModifier[],
): number {
  const mods = modifiers.reduce((sum, m) => sum + m.price_cents, 0);
  return basePriceCents + mods;
}

/** Recompute the derived price fields on a line (unit + line total). */
export function withLinePricing(item: OrderItem): OrderItem {
  const unit = computeUnitPriceCents(item.base_price_cents, item.modifiers);
  const lineTotal = item.voided ? 0 : unit * item.quantity;
  return {
    ...item,
    unit_price_cents: unit,
    line_total_cents: lineTotal,
  };
}

/** Sum of all non-voided line totals. */
export function computeSubtotalCents(items: OrderItem[]): number {
  return items.reduce(
    (sum, i) => sum + (i.voided ? 0 : i.unit_price_cents * i.quantity),
    0,
  );
}

/**
 * Round half-up to the nearest cent. (Tax is computed on integer cents, so this
 * only matters for the basis-point multiply — kept explicit for auditability.)
 */
export function roundHalfUp(value: number): number {
  return Math.floor(value + 0.5);
}

export interface ComputeTotalsInput {
  items: OrderItem[];
  /** Order-level discount in cents (clamped to subtotal). */
  discountCents: number;
  /** Tax rate in basis points (825 = 8.25%). */
  taxRateBps: number;
  /** Tip in cents (Phase 1: always 0 placeholder; wired in Phase 2). */
  tipCents?: number;
  /**
   * Custom fee / gratuity lines (already priced: `amount_cents` is final). They
   * add to the total; the `taxable` ones also add to the tax base.
   */
  fees?: readonly OrderFeeLine[];
  /** Tax-exempt order: tax 0 and a zero taxable base (like core's `priceCart`). */
  taxExempt?: boolean;
}

/**
 * Compute order totals: subtotal → discount → taxable → tax → total.
 * Discount applies before tax (tax is on the discounted, taxable amount).
 */
export function computeOrderTotals(input: ComputeTotalsInput): OrderTotals {
  const subtotal = computeSubtotalCents(input.items);
  const discount = Math.max(0, Math.min(input.discountCents, subtotal));
  const afterDiscount = subtotal - discount;
  const fees = input.fees ?? [];
  const feesTotal = fees.reduce((sum, f) => sum + f.amount_cents, 0);
  const feesTaxable = fees.reduce((sum, f) => sum + (f.taxable ? f.amount_cents : 0), 0);
  const taxable = input.taxExempt ? 0 : afterDiscount + feesTaxable;
  const tax = roundHalfUp((taxable * input.taxRateBps) / 10_000);
  const tip = Math.max(0, input.tipCents ?? 0);
  const total = afterDiscount + feesTotal + tax + tip;

  return {
    subtotal_cents: subtotal,
    discount_cents: discount,
    taxable_cents: taxable,
    tax_cents: tax,
    tip_cents: tip,
    total_cents: total,
    // Only with fee lines, so every fee-less order keeps its exact shape.
    ...(fees.length ? { fees_cents: feesTotal } : {}),
  };
}

/** Format integer cents as a localized currency string (default USD). */
export function formatMoney(cents: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
  }).format(cents / 100);
}
