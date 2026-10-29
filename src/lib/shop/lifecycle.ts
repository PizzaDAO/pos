/**
 * Online-order lifecycle beyond payment: expiry, cancellation and the sweeper.
 *
 *   awaiting_payment --(settled)--> paid           (finalizeOnlinePayment)
 *   awaiting_payment --(expired / cancelled)--> abandoned   (this module)
 *
 * `finalizeOnlinePayment` (shared with the terminal plan) lives in `./finalize`
 * so `payments/service` can import it without a cycle; this module imports the
 * payment service, never the other way round.
 *
 * Abandoning an order is ALWAYS preceded by closing its open tenders on the
 * provider: a card PaymentIntent is canceled (or, if Stripe says it already
 * succeeded, the order is finalized instead), so an order can never be abandoned
 * while its money is still on the way.
 */
import { getPosDriver } from "@/lib/db";
import type { Order, Payment } from "@/lib/db";
import { tenderFreesSlot } from "@/lib/db/payment-types";
import { captureError } from "@/lib/observability";
import {
  applyRailStatus,
  cancelOpenOnlineIntents,
  refreshPaymentStatus,
} from "@/lib/payments/service";
import {
  cardRailsSimulated,
  isStripeLiveKey,
  onlineCheckoutWindowMs,
  type CheckoutWindowKind,
} from "@/lib/payments/env";

/** Which expiry window applies to a tender's rail. */
export function checkoutWindowKind(rail: Payment["rail"]): CheckoutWindowKind {
  switch (rail) {
    case "crypto_coinbase":
      return "coinbase";
    case "crypto_onchain_usdc":
      return "usdc";
    default:
      return "card";
  }
}

/**
 * When an `awaiting_payment` order expires: `created_at` + the window of the rail
 * of its live tender (the most recently created tender that is not canceled or
 * failed), or the card window when no tender exists yet.
 */
export function orderExpiresAt(order: Order, payments: Payment[]): Date {
  const live = payments
    .filter((p) => !tenderFreesSlot(p.status))
    .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  const kind = live ? checkoutWindowKind(live.rail) : "card";
  return new Date(
    new Date(order.created_at).getTime() + onlineCheckoutWindowMs(kind),
  );
}

export type CloseOutcome =
  /** Every open tender is closed; safe to abandon. */
  | "closed"
  /** The order was paid after all (a settled tender was found). */
  | "paid"
  /** Money is in flight or already captured; do NOT abandon. */
  | "in_flight";

/**
 * Close an `awaiting_payment` order's open tenders on their providers.
 *
 *  - Real, not-yet-final tenders are re-checked first (a card that actually
 *    succeeded finalizes the order via `applyRailStatus`).
 *  - Open card intents are canceled (Stripe refusing because it already
 *    succeeded/processing re-syncs the tender instead).
 *  - A card still `processing`, or any settled tender that does not cover the
 *    order, blocks abandonment ("in_flight").
 *  - A still-pending crypto tender is canceled after the last check when
 *    `cancelPendingCrypto` (expiry), and blocks a customer-driven cancel.
 */
export async function closeOpenTenders(
  orderId: string,
  opts: { cancelPendingCrypto: boolean },
): Promise<CloseOutcome> {
  const driver = getPosDriver();
  const open = (await driver.listPaymentsForOrder(orderId)).filter(
    (p) => p.status === "requires_action" || p.status === "pending",
  );
  // Last look at anything real, so a payment that landed is not abandoned.
  for (const p of open) {
    if (p.simulated) continue;
    await refreshPaymentStatus(p.id).catch((err) =>
      captureError(err, { scope: "closeOpenTenders.refresh", orderId }),
    );
  }
  if ((await driver.getOrder(orderId))?.status !== "awaiting_payment") {
    return "paid";
  }

  await cancelOpenOnlineIntents(orderId);
  if ((await driver.getOrder(orderId))?.status !== "awaiting_payment") {
    return "paid";
  }

  const after = await driver.listPaymentsForOrder(orderId);
  // Settled money that did not finalize the order (an underpay) or a card the
  // provider is still processing: leave it for a human / the next sweep.
  if (after.some((p) => p.status === "authorized" || p.status === "captured")) {
    return "in_flight";
  }
  for (const p of after) {
    if (p.status !== "pending") continue;
    if (p.rail === "stripe_online" && !p.simulated) return "in_flight";
    if (!p.simulated && !opts.cancelPendingCrypto) return "in_flight";
    await applyRailStatus(p.id, "canceled");
  }
  return (await driver.getOrder(orderId))?.status === "awaiting_payment"
    ? "closed"
    : "paid";
}

export type CancelResult =
  | { ok: true; order: Order }
  | { ok: false; reason: "not_found" | "not_awaiting" | "has_payment" };

/**
 * Cancel an unpaid online checkout (the customer cancelled, or declined a
 * repriced total): close its open tenders, then compare-and-set to `abandoned`.
 * Idempotent: an already-abandoned order returns ok.
 */
export async function cancelOnlineCheckout(
  orderId: string,
): Promise<CancelResult> {
  const driver = getPosDriver();
  const order = await driver.getOrder(orderId);
  if (!order || order.channel === "in_store") {
    return { ok: false, reason: "not_found" };
  }
  if (order.status === "abandoned") return { ok: true, order };
  if (order.status !== "awaiting_payment") {
    return { ok: false, reason: "not_awaiting" };
  }
  const outcome = await closeOpenTenders(orderId, { cancelPendingCrypto: false });
  if (outcome !== "closed") return { ok: false, reason: "has_payment" };
  const abandoned = await driver.transitionOrderStatus(
    orderId,
    ["awaiting_payment"],
    "abandoned",
  );
  if (!abandoned) {
    // Lost a race: it was paid (or abandoned) meanwhile.
    const now = await driver.getOrder(orderId);
    return now?.status === "abandoned"
      ? { ok: true, order: now }
      : { ok: false, reason: "has_payment" };
  }
  return { ok: true, order: abandoned };
}

export interface ExpireSummary {
  checked: number;
  abandoned: number;
  /** Found paid at the last look (finalized instead of abandoned). */
  finalized: number;
  skipped: number;
  errors: number;
}

/**
 * True when this deployment must not touch the order's tenders: a real (non
 * simulated) card tender whose Stripe mode (`raw.livemode`) does not match this
 * deployment's key, or any real tender when this deployment simulates cards.
 * Prod and staging share a database, and Vercel crons run only on production.
 */
function foreignMode(payments: Payment[]): boolean {
  for (const p of payments) {
    if (p.simulated || p.rail !== "stripe_online") continue;
    if (cardRailsSimulated()) return true;
    const livemode = (p.raw as { livemode?: unknown } | null)?.livemode;
    if (typeof livemode === "boolean" && livemode !== isStripeLiveKey()) {
      return true;
    }
  }
  return false;
}

/**
 * The abandonment sweeper (Vercel cron every 5 min): every `awaiting_payment`
 * order past its expiry is closed on its provider and moved to `abandoned`, or
 * finalized if its payment turned out to have landed.
 */
export async function expireOnlineOrders(
  now: Date = new Date(),
): Promise<ExpireSummary> {
  const driver = getPosDriver();
  const summary: ExpireSummary = {
    checked: 0,
    abandoned: 0,
    finalized: 0,
    skipped: 0,
    errors: 0,
  };
  const shortest = Math.min(
    onlineCheckoutWindowMs("card"),
    onlineCheckoutWindowMs("coinbase"),
    onlineCheckoutWindowMs("usdc"),
  );
  const candidates = await driver.listAwaitingPaymentOrders(
    new Date(now.getTime() - shortest).toISOString(),
  );
  for (const order of candidates) {
    try {
      const payments = await driver.listPaymentsForOrder(order.id);
      if (orderExpiresAt(order, payments).getTime() > now.getTime()) continue;
      summary.checked += 1;
      if (foreignMode(payments)) {
        summary.skipped += 1;
        continue;
      }
      const outcome = await closeOpenTenders(order.id, {
        cancelPendingCrypto: true,
      });
      if (outcome === "paid") {
        summary.finalized += 1;
      } else if (outcome === "in_flight") {
        summary.skipped += 1;
      } else if (
        await driver.transitionOrderStatus(
          order.id,
          ["awaiting_payment"],
          "abandoned",
        )
      ) {
        summary.abandoned += 1;
      } else {
        summary.finalized += 1; // paid between the last look and the move
      }
    } catch (err) {
      summary.errors += 1;
      captureError(err, { scope: "expireOnlineOrders", orderId: order.id });
    }
  }
  return summary;
}
