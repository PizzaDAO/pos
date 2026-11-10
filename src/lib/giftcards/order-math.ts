/**
 * The order-balance rules the stored-value writers enforce, as pure functions.
 * Same rules as src/lib/payments/service.ts (`orderDueCents`, covering and
 * settled tenders) and the SQL in 20261113000910_stored_value.sql; kept here so
 * the writers do not import the payment service (which imports them).
 */
import type { Order, Payment } from "@/lib/db";

/** Order statuses a stored-value tender can never be added to. */
export const UNPAYABLE_ORDER_STATUSES: readonly string[] = [
  "voided",
  "abandoned",
  "refunded",
];

export function dueCents(order: Pick<Order, "totals">): number {
  return Math.max(0, order.totals.total_cents - (order.totals.tip_cents ?? 0));
}

function sameCurrency(order: Pick<Order, "currency">, p: Pick<Payment, "currency">) {
  return p.currency.toUpperCase() === order.currency.toUpperCase();
}

/** Base cents of tenders that cover the balance (pending/authorized/captured). */
export function coveredCents(
  order: Pick<Order, "currency">,
  payments: readonly Payment[],
): number {
  return payments
    .filter(
      (p) =>
        sameCurrency(order, p) &&
        (p.status === "pending" || p.status === "authorized" || p.status === "captured"),
    )
    .reduce((n, p) => n + p.amount_cents, 0);
}

/** What the order still owes (never negative). */
export function remainingCents(
  order: Pick<Order, "currency" | "totals">,
  payments: readonly Payment[],
): number {
  return Math.max(0, dueCents(order) - coveredCents(order, payments));
}

/**
 * The base money a settled tender still HOLDS: its amount less what was
 * refunded or is held by a pending refund (the tip absorbs a refund first, as
 * the tip / base caps do). SQL: sv_order_settled_cents.
 */
export function heldBaseCents(
  p: Pick<Payment, "amount_cents" | "tip_cents" | "refunded_cents" | "refund_reserved_cents">,
): number {
  const left = p.amount_cents + p.tip_cents - p.refunded_cents - (p.refund_reserved_cents ?? 0);
  return Math.max(0, Math.min(p.amount_cents, left));
}

/**
 * Settled (captured/authorized) base cents, NET of refunds, cover the amount
 * due. A partially refunded sale tender counts only what it still holds, so a
 * part-refunded, not-yet-settled sale never activates the card for the full
 * amount. (What the order still OWES, `remainingCents`, is not netted.)
 */
export function isSettled(
  order: Pick<Order, "currency" | "totals">,
  payments: readonly Payment[],
): boolean {
  const settled = payments
    .filter(
      (p) =>
        sameCurrency(order, p) && (p.status === "captured" || p.status === "authorized"),
    )
    .reduce((n, p) => n + heldBaseCents(p), 0);
  return settled >= dueCents(order);
}
