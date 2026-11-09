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

type RefundFields = Pick<Payment, "refunded_cents" | "tip_cents" | "tip_refunded_cents">;

/**
 * The gratuity part of a tender's refunds. Recorded explicitly since tip refunds
 * are tracked separately; a row without it (older database / older refunds)
 * follows the legacy rule: refunds came off the tip FIRST.
 */
export function tipRefundedCents(p: RefundFields): number {
  if (typeof p.tip_refunded_cents === "number") {
    return Math.max(0, Math.min(p.tip_refunded_cents, p.tip_cents, p.refunded_cents));
  }
  return Math.max(0, Math.min(p.refunded_cents, p.tip_cents));
}

/** The base (food) part of a tender's refunds. */
export function baseRefundedCents(p: RefundFields): number {
  return Math.max(0, p.refunded_cents - tipRefundedCents(p));
}

/** What can still be refunded on a tender, split into base and tip. */
export function refundableParts(
  p: Pick<Payment, "amount_cents" | "status"> & RefundFields,
): { baseCents: number; tipCents: number } {
  if (p.status !== "captured" && p.status !== "authorized") {
    return { baseCents: 0, tipCents: 0 };
  }
  return {
    baseCents: Math.max(0, p.amount_cents - baseRefundedCents(p)),
    tipCents: Math.max(0, p.tip_cents - tipRefundedCents(p)),
  };
}

/** Σ refunded (base + tip) over live tenders, and the tip part of it. */
export function orderRefundTotals(payments: Payment[]): {
  refundedCents: number;
  tipRefundedCents: number;
} {
  let refundedCents = 0;
  let tip = 0;
  for (const p of liveTenders(payments)) {
    refundedCents += p.refunded_cents;
    tip += tipRefundedCents(p);
  }
  return { refundedCents, tipRefundedCents: tip };
}
