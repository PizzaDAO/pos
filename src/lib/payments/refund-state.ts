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

type RefundFields = Pick<
  Payment,
  "refunded_cents" | "tip_cents" | "tip_refunded_cents" | "amount_cents"
>;

/**
 * The gratuity part of a tender's (confirmed) refunds. Recorded explicitly since
 * tip refunds are tracked separately; a row without it (older database / older
 * refunds) follows the legacy rule: base first, only what was refunded beyond
 * the base is tip ("tip last", as the owner reports always read it).
 */
export function tipRefundedCents(p: RefundFields): number {
  if (typeof p.tip_refunded_cents === "number") {
    return Math.max(0, Math.min(p.tip_refunded_cents, p.tip_cents, p.refunded_cents));
  }
  return Math.max(0, Math.min(p.refunded_cents - p.amount_cents, p.tip_cents));
}

/** The base (food) part of a tender's (confirmed) refunds. */
export function baseRefundedCents(p: RefundFields): number {
  return Math.max(0, p.refunded_cents - tipRefundedCents(p));
}

/** Room held by refunds still `pending` at the provider (not refunded yet). */
export function pendingRefundParts(p: Pick<Payment, "refunds">): {
  amountCents: number;
  tipCents: number;
} {
  let amountCents = 0;
  let tipCents = 0;
  for (const r of p.refunds ?? []) {
    if (r.state !== "pending") continue;
    amountCents += r.amount_cents;
    tipCents += typeof r.tip_cents === "number" ? r.tip_cents : 0;
  }
  return { amountCents, tipCents };
}

/** What can still be refunded on a tender (pending refunds hold their room), split into base and tip. */
export function refundableParts(
  p: Pick<Payment, "amount_cents" | "status" | "refunds"> & RefundFields,
): { baseCents: number; tipCents: number } {
  if (p.status !== "captured" && p.status !== "authorized") {
    return { baseCents: 0, tipCents: 0 };
  }
  const pending = pendingRefundParts(p);
  return {
    baseCents: Math.max(
      0,
      p.amount_cents - baseRefundedCents(p) - (pending.amountCents - pending.tipCents),
    ),
    tipCents: Math.max(0, p.tip_cents - tipRefundedCents(p) - pending.tipCents),
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

/** Base money ever SETTLED on these tenders: captured / authorized, plus tenders since refunded. */
export function grossSettledBase(payments: readonly Payment[]): number {
  return payments
    .filter((p) => p.status === "captured" || p.status === "authorized" || p.status === "refunded")
    .reduce((n, p) => n + p.amount_cents, 0);
}

/**
 * Do REFUNDED tenders still count toward the amount due? Only when the order was
 * paid in full (live + refunded settled money reached the amount due): a refund
 * after the sale never re-opens the balance (no second charge). On an order that
 * was never paid in full a refunded tender is money given back, not money owed:
 * it does not count (split $100: A $30 refunded, B $30 live => $70 due).
 */
export function refundedTendersCover(payments: readonly Payment[], dueCents: number): boolean {
  return grossSettledBase(payments) >= dueCents;
}

/**
 * Base money covering the amount due: pending (crypto confirming), authorized,
 * captured, and refunded tenders when `refundedTendersCover`. Shared by the
 * balance, the receipt and the paid check, so they always agree.
 */
export function coveringBaseCents(payments: readonly Payment[], dueCents: number): number {
  const withRefunded = refundedTendersCover(payments, dueCents);
  return payments
    .filter(
      (p) =>
        p.status === "pending" ||
        p.status === "authorized" ||
        p.status === "captured" ||
        (withRefunded && p.status === "refunded"),
    )
    .reduce((n, p) => n + p.amount_cents, 0);
}

/** Settled base money (pending excluded) under the same rule: the "paid" check. */
export function settledBaseCents(payments: readonly Payment[], dueCents: number): number {
  const withRefunded = refundedTendersCover(payments, dueCents);
  return payments
    .filter(
      (p) =>
        p.status === "authorized" ||
        p.status === "captured" ||
        (withRefunded && p.status === "refunded"),
    )
    .reduce((n, p) => n + p.amount_cents, 0);
}
