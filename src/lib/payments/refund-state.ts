/**
 * Pure refunded-state rule shared by the receipt, the payment screen and the
 * open-orders list. No imports beyond types (safe in client bundles).
 */
import type { Order, Payment } from "@/lib/db";

/** Tenders that never took money (a declined/abandoned attempt). */
export function liveTenders(payments: Payment[]): Payment[] {
  return payments.filter((p) => p.status !== "failed" && p.status !== "canceled");
}

/**
 * Every live tender was refunded (or the order itself is `refunded`). Failed and
 * canceled attempts are ignored; with no live tender the order is NOT refunded.
 */
export function isFullyRefunded(
  order: Pick<Order, "status"> | null | undefined,
  payments: Payment[],
): boolean {
  if (order?.status === "refunded") return true;
  const live = liveTenders(payments);
  return live.length > 0 && live.every((p) => p.status === "refunded");
}
