/**
 * Pure rules for the till's "Open orders" list and the refunded state.
 * No I/O: the route loads orders + tenders and hands them here.
 */
import type { Order, Payment } from "@/lib/db";
import { isFullyRefunded, liveTenders } from "./refund-state";
import { orderBalanceFromPayments } from "./service";

/** Statuses a till order can still owe money in. */
const OWING_STATUSES = new Set([
  "placed",
  "paid",
  "in_kitchen",
  "ready",
  "recall",
  "out_for_delivery",
  "completed",
]);

export interface OpenOrderRow {
  id: string;
  order_number: string;
  status: Order["status"];
  currency: string;
  balanceCents: number;
}

/**
 * In-store orders that still owe money, newest first. The balance filter runs
 * BEFORE the cap so an old unpaid order is never hidden by newer paid ones.
 */
export function selectOpenOrders(
  orders: Order[],
  paymentsByOrder: Map<string, Payment[]>,
  limit = 50,
): OpenOrderRow[] {
  const rows: OpenOrderRow[] = [];
  for (const order of orders) {
    if (order.channel !== "in_store" || !OWING_STATUSES.has(order.status)) {
      continue;
    }
    const payments = paymentsByOrder.get(order.id) ?? [];
    if (isFullyRefunded(order, payments)) continue;
    const balanceCents = orderBalanceFromPayments(order, payments);
    if (balanceCents <= 0) continue;
    rows.push({
      id: order.id,
      order_number: order.order_number,
      status: order.status,
      currency: order.currency,
      balanceCents,
    });
    if (rows.length >= limit) break;
  }
  return rows;
}

/** One row of the till's "Recent orders" (order history) list. */
export interface RecentOrderRow {
  id: string;
  order_number: string;
  status: Order["status"];
  currency: string;
  totalCents: number;
  balanceCents: number;
  /** Refunded back on the order's tenders (base + tip). */
  refundedCents: number;
  /** paid | partially_refunded | refunded | voided | unpaid. */
  money: "paid" | "partially_refunded" | "refunded" | "voided" | "unpaid";
  /** Comps + discounts applied. */
  discountCents: number;
  created_at: string;
}

/** Recent in-store orders with their money state, newest first. */
export function selectRecentOrders(
  orders: Order[],
  paymentsByOrder: Map<string, Payment[]>,
  limit = 50,
): RecentOrderRow[] {
  const rows: RecentOrderRow[] = [];
  const newestFirst = [...orders].sort(
    (a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id),
  );
  for (const order of newestFirst) {
    if (order.channel !== "in_store" || order.status === "draft") continue;
    const payments = paymentsByOrder.get(order.id) ?? [];
    const refundedCents = liveTenders(payments).reduce((n, p) => n + p.refunded_cents, 0);
    const balanceCents = orderBalanceFromPayments(order, payments);
    const money: RecentOrderRow["money"] =
      order.status === "voided"
        ? "voided"
        : isFullyRefunded(order, payments)
          ? "refunded"
          : refundedCents > 0
            ? "partially_refunded"
            : balanceCents > 0
              ? "unpaid"
              : "paid";
    rows.push({
      id: order.id,
      order_number: order.order_number,
      status: order.status,
      currency: order.currency,
      totalCents: order.totals.total_cents,
      balanceCents,
      refundedCents,
      money,
      discountCents: order.totals.discount_cents,
      created_at: order.created_at,
    });
    if (rows.length >= limit) break;
  }
  return rows;
}
