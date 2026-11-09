/**
 * Order type + customer name taken at the till, and one display format for order
 * numbers. Stored on the order's `core_ext` (callout_name + metadata.order_type),
 * so no schema change; the orders route re-validates both server-side.
 */
import type { Order, OrderCoreExt } from "@/lib/db";

export const TILL_ORDER_TYPES = ["dine_in", "pickup", "delivery"] as const;
export type TillOrderType = (typeof TILL_ORDER_TYPES)[number];

export const ORDER_TYPE_LABELS: Record<TillOrderType, string> = {
  dine_in: "Dine-in",
  pickup: "Pickup",
  delivery: "Delivery",
};

export const MAX_CUSTOMER_NAME = 40;

export function isTillOrderType(v: unknown): v is TillOrderType {
  return typeof v === "string" && (TILL_ORDER_TYPES as readonly string[]).includes(v);
}

/** Trim, collapse whitespace and cap the name; null when empty. */
export function cleanCustomerName(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.replace(/\s+/g, " ").trim().slice(0, MAX_CUSTOMER_NAME);
  return s || null;
}

/** The `core_ext` a till order carries (null when there is nothing to record). */
export function buildTillCoreExt(
  orderType: TillOrderType | null,
  customerName: string | null,
): OrderCoreExt | null {
  const name = cleanCustomerName(customerName);
  if (!orderType && !name) return null;
  return {
    ...(name ? { callout_name: name } : {}),
    ...(orderType ? { metadata: { order_type: orderType } } : {}),
  };
}

/**
 * Server side: keep ONLY the order type and customer name from whatever core_ext
 * a till client sent (everything else in core_ext is for the /v1 API).
 */
export function sanitizeTillCoreExt(raw: unknown): OrderCoreExt | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { callout_name?: unknown; metadata?: unknown };
  const meta = r.metadata && typeof r.metadata === "object" ? (r.metadata as Record<string, unknown>) : {};
  return buildTillCoreExt(
    isTillOrderType(meta.order_type) ? meta.order_type : null,
    cleanCustomerName(r.callout_name),
  );
}

export function orderTypeOf(order: Pick<Order, "core_ext">): TillOrderType | null {
  const t = order.core_ext?.metadata?.order_type;
  return isTillOrderType(t) ? t : null;
}

/** "Dine-in", "Pickup", "Delivery" for a till order, else null. */
export function orderTypeLabel(order: Pick<Order, "core_ext">): string | null {
  const t = orderTypeOf(order);
  return t ? ORDER_TYPE_LABELS[t] : null;
}

/**
 * One display format for order numbers across the till, KDS and receipt:
 * "#406". The stored value stays as generated ("1526-406", "A-0003", "K-103");
 * this shows its trailing number so a board never mixes three styles.
 */
export function displayOrderNumber(orderNumber: string): string {
  const m = /(\d+)\D*$/.exec(orderNumber);
  if (!m) return orderNumber;
  return `#${m[1]!.replace(/^0+(?=\d)/, "")}`;
}
