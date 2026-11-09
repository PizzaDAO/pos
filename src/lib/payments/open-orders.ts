/**
 * Pure rules for the till's "Open orders" list and the refunded state.
 * No I/O: the route loads orders + tenders and hands them here.
 */
import type { AdjustmentRecord, Order, Payment } from "@/lib/db";
import { isAcceptFailed } from "@/lib/marketplace/service";
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
  /**
   * Set on marketplace orders (DoorDash / Uber Eats / Grubhub): paid by the
   * marketplace (balanceCents is always 0), shown with a provider badge and, while
   * `acceptance` is pending, accept / reject controls.
   */
  marketplace?: {
    provider: string;
    display_id: string | null;
    acceptance: "pending" | "accepted" | "rejected";
    /** The accept callback failed at the provider: still pending, retry. */
    accept_failed?: boolean;
    /** The provider cancelled an order the kitchen already started. */
    cancel_requested?: boolean;
  };
}

/** Marketplace orders still live on the till: pending acceptance up to ready. */
const MARKETPLACE_LIVE_STATUSES = new Set(["placed", "paid", "in_kitchen", "ready", "recall"]);

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
    const mk = order.fulfillment?.marketplace;
    if (order.channel === "marketplace") {
      // Already paid: listed so staff can accept it and see it, never to be paid.
      if (mk && MARKETPLACE_LIVE_STATUSES.has(order.status)) {
        rows.push({
          id: order.id,
          order_number: order.order_number,
          status: order.status,
          currency: order.currency,
          balanceCents: 0,
          marketplace: {
            provider: mk.provider,
            display_id: mk.display_id,
            acceptance: mk.acceptance,
            accept_failed: isAcceptFailed(mk),
            cancel_requested: !!mk.cancel_requested,
          },
        });
        if (rows.length >= limit) break;
      }
      continue;
    }
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
  /** Refund requests that did not finish (pending / partial / failed item refunds). */
  unfinishedRefunds: number;
  created_at: string;
}

/** Recent in-store orders with their money state, newest first. */
export function selectRecentOrders(
  orders: Order[],
  paymentsByOrder: Map<string, Payment[]>,
  limit = 50,
  adjustments: readonly AdjustmentRecord[] = [],
): RecentOrderRow[] {
  const unfinished = new Map<string, number>();
  for (const r of adjustments) {
    if (r.kind !== "refund" || r.status === "completed") continue;
    if (r.status === "failed" && r.lines.length === 0) continue; // nothing reserved
    unfinished.set(r.order_id, (unfinished.get(r.order_id) ?? 0) + 1);
  }
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
      unfinishedRefunds: unfinished.get(order.id) ?? 0,
      created_at: order.created_at,
    });
    if (rows.length >= limit) break;
  }
  return rows;
}
