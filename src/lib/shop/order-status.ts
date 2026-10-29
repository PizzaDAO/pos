/**
 * Order-status helpers shared by the storefront and its tests.
 */
import type { OrderStatus } from "@/lib/db";

/** Statuses past payment: an existing order in one of these needs no payment. */
export const PROGRESSED_STATUSES: readonly OrderStatus[] = [
  "paid",
  "in_kitchen",
  "ready",
  "recall",
  "out_for_delivery",
  "completed",
] as const;

/**
 * True when an order returned for a retried checkout has already been paid and
 * moved on (a lost response, a reload): confirm it instead of paying again.
 * `awaiting_payment`, legacy unpaid `placed`, and `abandoned` are NOT progressed.
 */
export function hasProgressedPastPayment(status: OrderStatus): boolean {
  return (PROGRESSED_STATUSES as readonly string[]).includes(status);
}
