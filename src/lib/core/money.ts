/**
 * Money helpers shared by the `/v1` handlers and the payment-session pipeline
 * (kept out of `v1.ts` so `payment-sessions.ts` can use them without an import
 * cycle).
 */
import type { Payment } from "@/lib/db";

/**
 * Base money (tips excluded) still held on SETTLED tenders — captured or
 * authorized, as main's settledCents — in the order's currency, net of refunds
 * beyond the tip: sum(max(0, amount - max(0, refunded - tip))).
 */
export function netSettledBaseCents(
  payments: Payment[],
  currency: string,
): number {
  const cur = currency.toUpperCase();
  return payments
    .filter(
      (p) =>
        (p.status === "captured" || p.status === "authorized") &&
        p.currency.toUpperCase() === cur,
    )
    .reduce(
      (n, p) =>
        n +
        Math.max(0, p.amount_cents - Math.max(0, p.refunded_cents - p.tip_cents)),
      0,
    );
}
