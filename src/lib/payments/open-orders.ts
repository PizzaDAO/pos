/**
 * Pure rules for the till's "Open orders" list and the refunded state.
 * No I/O: the route loads orders + tenders and hands them here.
 */
import type { Order, Payment } from "@/lib/db";
import { isFullyRefunded } from "./refund-state";
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
