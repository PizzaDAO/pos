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
  cancelOpenTender,
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
    // STRICT: Coinbase is asked to cancel the charge; if it refuses (a payment
    // was detected) the charge is re-synced and, if still pending, the order is
    // NOT abandoned -- it stays awaiting_payment until the payment settles or
    // fails. USDC has nothing held at a provider: local cancel only.
    const outcome = await cancelOpenTender(p);
    if (outcome === "in_flight") return "in_flight";
    if (outcome === "settled") {
      return (await driver.getOrder(orderId))?.status === "awaiting_payment"
        ? "in_flight"
        : "paid";
    }
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
  /** Orders of another deployment mode swept after the long grace (no real tender). */
  foreignSwept: number;
  /** Orders of another deployment mode holding real tenders (alerted once, not swept). */
  foreignAlerted: number;
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
/**
 * A paid order is only recovered once this old. It must comfortably exceed the
 * cron route's `maxDuration` (60 s): a finalize that is still legitimately
 * running when the next sweep starts must not be raced.
 */
export const RECOVERY_GRACE_MS = 6 * 60_000;
/**
 * Orders stamped with ANOTHER deployment mode are left to that mode's sweeper for
 * this long; after it they are swept here if they carry no real tender (so a mode
 * flip cannot strand them) and alerted once if they do.
 */
export const FOREIGN_MODE_GRACE_MS = 24 * 60 * 60_000;
/** Recovery backoff: 5 min doubling per failed attempt, capped at 6 h. */
const RECOVERY_BACKOFF_BASE_MS = 5 * 60_000;
const RECOVERY_BACKOFF_MAX_MS = 6 * 60 * 60_000;

/** A tender that moved (or may move) real money on a provider. */
function hasRealTender(payments: Payment[]): boolean {
  return payments.some(
    (p) =>
      !p.simulated &&
      p.rail !== "cash" &&
      (p.status === "requires_action" ||
        p.status === "pending" ||
        p.status === "authorized" ||
        p.status === "captured"),
  );
}

async function backOffRecovery(order: Order, now: Date, delayMs?: number) {
  const attempts = (order.fulfillment?.recovery_attempts ?? 0) + 1;
  const delay =
    delayMs ??
    Math.min(RECOVERY_BACKOFF_BASE_MS * 2 ** attempts, RECOVERY_BACKOFF_MAX_MS);
  await getPosDriver().mergeOrderFulfillment(order.id, {
    recovery_attempts: attempts,
    recovery_next_at: new Date(now.getTime() + delay).toISOString(),
  });
}

/**
 * Crash recovery: paid online orders whose post-payment steps (inventory,
 * dispatch) never completed -- the process died after the `awaiting_payment ->
 * paid` compare-and-set -- re-run them. The steps are idempotent per item / per
 * order. A failing order backs off exponentially (so it cannot starve the rest of
 * the oldest-first batch). Orders of another deployment mode are left alone for
 * `FOREIGN_MODE_GRACE_MS`; after that they are recovered if they hold no real
 * tender and otherwise alerted and parked.
 */
export async function recoverUnfinalizedOrders(
  now: Date = new Date(),
): Promise<number> {
  const driver = getPosDriver();
  const mode = deploymentCheckoutMode();
  const stuck = await driver.listUnfinalizedPaidOrders(
    new Date(now.getTime() - RECOVERY_GRACE_MS).toISOString(),
    PAGE_SIZE,
    now.toISOString(),
  );
  let recovered = 0;
  for (const order of stuck) {
    try {
      const m = order.fulfillment?.checkout_mode;
      if (m !== undefined && m !== mode) {
        const paidAt = new Date(order.fulfillment?.paid_at ?? now).getTime();
        const payments = await driver.listPaymentsForOrder(order.id);
        const young = now.getTime() - paidAt < FOREIGN_MODE_GRACE_MS;
        if (young || hasRealTender(payments)) {
          if (!young) {
            captureError(new Error("paid order of another deployment mode never finalized"), {
              scope: "recoverUnfinalizedOrders.foreign",
              orderId: order.id,
              mode: m,
            });
          }
          await backOffRecovery(order, now, FOREIGN_MODE_GRACE_MS);
          continue;
        }
      }
      if (await runPostPaymentSteps(order)) recovered += 1;
      else await backOffRecovery(order, now);
    } catch (err) {
      captureError(err, { scope: "recoverUnfinalizedOrders", orderId: order.id });
      await backOffRecovery(order, now).catch(() => undefined);
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
    foreignSwept: 0,
    foreignAlerted: 0,
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
  await sweepForeignModeOrders(now, mode, summary);
  summary.recovered = await recoverUnfinalizedOrders(now);
  return summary;
}

/**
 * Orders stamped with a DIFFERENT deployment mode (e.g. test-mode orders seen by
 * the live sweeper, or after the deployment flipped mode) are normally left to
 * that mode's sweeper. Once they are far past any window, sweep those with no
 * real tender here, so a mode change cannot strand them forever; alert (once, via
 * `foreign_alerted_at`) on the ones that hold real tenders instead of silently
 * skipping them on every run.
 */
async function sweepForeignModeOrders(
  now: Date,
  mode: "live" | "test" | "sim",
  summary: ExpireSummary,
): Promise<void> {
  const driver = getPosDriver();
  const cutoff = new Date(now.getTime() - FOREIGN_MODE_GRACE_MS).toISOString();
  let after: { created_at: string; id: string } | undefined;
  for (let page = 0; page < 5; page += 1) {
    const batch = await driver.listAwaitingPaymentOrders(cutoff, {
      limit: PAGE_SIZE,
      after,
      foreignOf: mode,
    });
    if (batch.length === 0) break;
    for (const order of batch) {
      try {
        const payments = await driver.listPaymentsForOrder(order.id);
        if (hasRealTender(payments)) {
          captureError(new Error("unpaid order of another deployment mode holds a real tender"), {
            scope: "expireOnlineOrders.foreign",
            orderId: order.id,
            mode: order.fulfillment?.checkout_mode,
          });
          await driver.mergeOrderFulfillment(order.id, {
            foreign_alerted_at: now.toISOString(),
          });
          summary.foreignAlerted += 1;
        } else {
          const before = summary.abandoned;
          await sweepOne(order, now, summary);
          if (summary.abandoned > before) summary.foreignSwept += 1;
        }
      } catch (err) {
        summary.errors += 1;
        captureError(err, { scope: "sweepForeignModeOrders", orderId: order.id });
      }
    }
    const last = batch[batch.length - 1]!;
    after = { created_at: last.created_at, id: last.id };
    if (batch.length < PAGE_SIZE) break;
  }
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
