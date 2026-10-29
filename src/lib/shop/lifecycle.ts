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
  cancelOpenOnlineIntents,
  cancelPendingTender,
  refreshPaymentStatus,
} from "@/lib/payments/service";
import { runPostPaymentSteps } from "./finalize";
import {
  cardRailsSimulated,
  deploymentCheckoutMode,
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
 * When an `awaiting_payment` order expires: `created_at` + the EARLIEST window
 * among its live tenders' rails (tenders that are not canceled/failed), or the
 * window of `requestedRail` (default card) when it has none. The sweeper and the
 * `/api/payments` gate both call this, so they can never disagree about whether
 * an order is expired; only the gate passes `requestedRail`, and it only matters
 * for an order that has no live tender yet.
 */
export function orderExpiresAt(
  order: Order,
  payments: Payment[],
  requestedRail?: Payment["rail"],
): Date {
  const live = payments.filter((p) => !tenderFreesSlot(p.status));
  const kinds: CheckoutWindowKind[] =
    live.length > 0
      ? live.map((p) => checkoutWindowKind(p.rail))
      : [requestedRail ? checkoutWindowKind(requestedRail) : "card"];
  const window = Math.min(...kinds.map((k) => onlineCheckoutWindowMs(k)));
  return new Date(new Date(order.created_at).getTime() + window);
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
  // provider is still processing: leave it for a human / the next sweep, and
  // alert -- an expired order holding customer money needs attention.
  const settledMoney = after.filter(
    (p) => p.status === "authorized" || p.status === "captured",
  );
  if (settledMoney.length > 0) {
    captureError(
      new Error("expired online order holds settled money that does not cover it"),
      {
        scope: "checkout.in_flight",
        orderId,
        settledCents: settledMoney.reduce(
          (n, p) => n + p.amount_cents + p.tip_cents,
          0,
        ),
      },
    );
    return "in_flight";
  }
  for (const p of after) {
    if (p.status !== "pending") continue;
    if (p.rail === "stripe_online" && !p.simulated) return "in_flight";
    if (!p.simulated && !opts.cancelPendingCrypto) return "in_flight";
    // Coinbase: cancel the charge with the provider (best effort, logged), then
    // the local row. USDC has nothing held at a provider: local only.
    await cancelPendingTender(p);
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
  /** Paid orders whose post-payment steps were re-run (crash recovery). */
  recovered: number;
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

const PAGE_SIZE = 100;
/** Hard cap per run (PAGE_SIZE x MAX_PAGES orders); the next run continues. */
const MAX_PAGES = 20;
/** A paid order is only recovered once this old, so a live finalize is not raced. */
const RECOVERY_GRACE_MS = 2 * 60_000;

/**
 * Crash recovery: paid online orders whose post-payment steps (inventory,
 * dispatch) never completed -- the process died after the `awaiting_payment ->
 * paid` compare-and-set -- re-run them. The steps are idempotent. Only orders of
 * this deployment's mode are touched.
 */
export async function recoverUnfinalizedOrders(
  now: Date = new Date(),
): Promise<number> {
  const driver = getPosDriver();
  const mode = deploymentCheckoutMode();
  const stuck = await driver.listUnfinalizedPaidOrders(
    new Date(now.getTime() - RECOVERY_GRACE_MS).toISOString(),
    PAGE_SIZE,
  );
  let recovered = 0;
  for (const order of stuck) {
    const m = order.fulfillment?.checkout_mode;
    if (m !== undefined && m !== mode) continue;
    try {
      if (await runPostPaymentSteps(order)) recovered += 1;
    } catch (err) {
      captureError(err, { scope: "recoverUnfinalizedOrders", orderId: order.id });
    }
  }
  return recovered;
}

/**
 * The abandonment sweeper (Vercel cron every 5 min): every `awaiting_payment`
 * order past its expiry window is closed on its provider and moved to
 * `abandoned`, or finalized if its payment landed. Orders are read in keyset
 * pages (a long-lived skipped order cannot starve newer ones) and filtered in the
 * query to this deployment's mode (staging/test orders in a shared DB are never
 * scanned). Then paid-but-unfinalized orders are recovered.
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
    recovered: 0,
  };
  const shortest = Math.min(
    onlineCheckoutWindowMs("card"),
    onlineCheckoutWindowMs("coinbase"),
    onlineCheckoutWindowMs("usdc"),
  );
  const cutoff = new Date(now.getTime() - shortest).toISOString();
  const mode = deploymentCheckoutMode();
  let after: { created_at: string; id: string } | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const batch = await driver.listAwaitingPaymentOrders(cutoff, {
      limit: PAGE_SIZE,
      after,
      checkoutMode: mode,
    });
    if (batch.length === 0) break;
    for (const order of batch) await sweepOne(order, now, summary);
    const last = batch[batch.length - 1]!;
    after = { created_at: last.created_at, id: last.id };
    if (batch.length < PAGE_SIZE) break;
  }
  summary.recovered = await recoverUnfinalizedOrders(now);
  return summary;
}

async function sweepOne(
  order: Order,
  now: Date,
  summary: ExpireSummary,
): Promise<void> {
  const driver = getPosDriver();
  try {
    const payments = await driver.listPaymentsForOrder(order.id);
    if (orderExpiresAt(order, payments).getTime() > now.getTime()) return;
    summary.checked += 1;
    if (foreignMode(payments)) {
      summary.skipped += 1;
      return;
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
