/**
 * Payment service (server-side) — the single orchestration point for taking,
 * refunding, and reconciling tenders against an order. Used by the payment API
 * routes + webhooks. Talks to rails through the registry and persists tenders
 * through the DB abstraction (mock driver today).
 *
 * IDEMPOTENCY: every tender carries a client UUID (`paymentId`) that is BOTH the
 * idempotency key forwarded to the rail AND the primary key of the persisted
 * payment row. `takePayment` first checks for an existing tender with that id
 * and returns it unchanged if found — so a retried request (offline replay,
 * double-tap, lost response) never creates a second charge.
 *
 * SPLIT PAYMENT: an order may have several tenders across rails. The order is
 * marked `paid` once SETTLED (authorized/captured) base amounts cover the amount
 * due (`orderDueCents`). `getOrderBalance` returns the remaining balance the UI
 * drives to zero; tenders still awaiting customer action don't reduce it.
 *
 * SETTLEMENT: every status change from a rail (takePayment, polling, webhooks)
 * funnels through `applyRailStatus`, which never downgrades a captured/refunded
 * tender and ALWAYS re-evaluates whether the order is now paid.
 */
import "./rails";
import { getPosDriver } from "@/lib/db";
import type { Order, Payment, PaymentStatus } from "@/lib/db";
import type { RefundReservation } from "@/lib/db/payment-types";
import { LiveTenderConflictError } from "@/lib/db/payment-types";
import { captureError } from "@/lib/observability";
import { recordAudit } from "@/lib/security/audit";
import { cancelCoinbaseCharge } from "./providers/coinbase-client";
import { finalizeOnlinePayment } from "@/lib/shop/finalize";
import { deriveTenderId } from "./ids";
import type { PaymentRailKey } from "./PaymentRail";
import { requirePaymentRail } from "./registry";
import { mapIntentStatus, stripeGet, stripeRequest } from "./providers/stripe-client";
import { cancelReaderActionForIntent } from "./providers/stripe-terminal-api";
import { railChargesApplicationFee } from "./fees";
import { CardPaymentsNotReadyError } from "./connect";
import {
  cardRailsSimulated,
  isCoinbaseConfigured,
  isOnchainConfigured,
} from "./env";

function nowIso(): string {
  return new Date().toISOString();
}

/** Whether a rail is currently running in simulated mode (no live keys). */
export function railIsSimulated(rail: PaymentRailKey | "cash"): boolean {
  switch (rail) {
    case "cash":
      return false; // cash is always real
    case "stripe_terminal":
    case "stripe_online":
      return cardRailsSimulated();
    case "crypto_onchain_usdc":
      return !isOnchainConfigured();
    case "crypto_coinbase":
      return !isCoinbaseConfigured();
    default:
      return true;
  }
}

/** A paymentId was reused for a different order (maps to HTTP 409). */
export class PaymentConflictError extends Error {
  constructor() {
    super("paymentId already used for another order.");
    this.name = "PaymentConflictError";
  }
}

export interface TakePaymentInput {
  /** Client UUID — idempotency key + payment row id. */
  paymentId: string;
  orderId: string;
  tenantId: string;
  locationId: string;
  rail: PaymentRailKey | "cash";
  /** Base amount applied to the order balance, in cents (excludes tip). */
  amountCents: number;
  /** Tip portion of this tender, in cents. */
  tipCents: number;
  currency: string;
  /** Connected-account id for card rails (resolved from Connect status). */
  connectAccountId?: string | null;
  /** Cash-only: amount the customer handed over (for change calc). */
  cashTenderedCents?: number;
  metadata?: Record<string, string>;
}

/**
 * Amount due on an order, in cents: the order total minus any tip carried on the
 * ORDER (online orders fold the customer's tip into `total_cents`; the tip rides
 * on the tender's `tip_cents`, not its base `amount_cents`). Terminal orders have
 * an order tip of 0 (the tip is added per tender), so their due == total.
 */
export function orderDueCents(order: Order): number {
  return Math.max(0, order.totals.total_cents - (order.totals.tip_cents ?? 0));
}

/**
 * Tenders that cover the balance: pending, authorized or captured — INCLUDING
 * pending crypto, so the cashier isn't asked to collect twice while it confirms.
 * `requires_action` (an intent nobody has paid yet), failed, canceled and
 * refunded tenders do NOT cover. (The order is only marked `paid` once tenders
 * SETTLE — see `settledCents`.)
 */
function coveredTenders(payments: Payment[]): Payment[] {
  return payments.filter(
    (p) =>
      p.status === "pending" ||
      p.status === "authorized" ||
      p.status === "captured",
  );
}

function coveredCents(payments: Payment[]): number {
  return coveredTenders(payments).reduce((sum, p) => sum + p.amount_cents, 0);
}

/** Sum of base amounts covered by SETTLED tenders (captured/authorized). */
function settledCents(payments: Payment[]): number {
  return payments
    .filter((p) => p.status === "captured" || p.status === "authorized")
    .reduce((sum, p) => sum + p.amount_cents, 0);
}

/**
 * Tenders for an order that are in the ORDER's currency. A tender recorded in
 * another currency can never cover or settle the order's amount due.
 */
async function listOrderCurrencyPayments(order: Order): Promise<Payment[]> {
  const all = await getPosDriver().listPaymentsForOrder(order.id);
  const cur = order.currency.toUpperCase();
  return all.filter((p) => p.currency.toUpperCase() === cur);
}

/** Remaining unpaid balance on an order, in cents (never negative). */
export async function getOrderBalance(order: Order): Promise<number> {
  const payments = await listOrderCurrencyPayments(order);
  const balance = orderDueCents(order) - coveredCents(payments);
  return Math.max(0, balance);
}

/**
 * Amount + tip to charge for an ONLINE order, derived from the order itself
 * (never the client): base = remaining due, tip = the order's tip not already
 * carried by a covering tender. `amountCents` is 0 when nothing is left to pay.
 */
export async function deriveOnlineTender(
  order: Order,
): Promise<{ amountCents: number; tipCents: number }> {
  const payments = await listOrderCurrencyPayments(order);
  const covering = coveredTenders(payments);
  const amountCents = Math.max(
    0,
    orderDueCents(order) - covering.reduce((n, p) => n + p.amount_cents, 0),
  );
  const tipCovered = covering.reduce((n, p) => n + p.tip_cents, 0);
  const tipCents = Math.max(0, (order.totals.tip_cents ?? 0) - tipCovered);
  return { amountCents, tipCents };
}

/**
 * The tender id for an ONLINE order's next attempt on `rail`: derived from the
 * order id (never client-minted), so retries, reloads and double-taps all land
 * on the same tender. Sequence 0 is used until that tender is `canceled`/`failed`
 * (a rail switch away and back, or a declined card), then the next sequence
 * number starts a fresh attempt.
 */
export async function nextOnlineTenderId(
  orderId: string,
  rail: string,
): Promise<string> {
  const driver = getPosDriver();
  for (let seq = 0; seq < 50; seq += 1) {
    const id = deriveTenderId(orderId, rail, seq);
    const existing = await driver.getPayment(id);
    if (!existing) return id;
    if (existing.status !== "canceled" && existing.status !== "failed") {
      return id;
    }
  }
  throw new Error("Too many payment attempts for this order.");
}

/**
 * Take one tender against an order. Idempotent on `paymentId`. Computes the
 * platform application fee for card rails, calls the rail, persists the tender,
 * and marks the order `paid` once the balance reaches zero.
 */
export async function takePayment(input: TakePaymentInput): Promise<Payment> {
  return (await takePaymentDetailed(input)).payment;
}

/**
 * `takePayment` plus the one-time card-form secret (Stripe `client_secret`),
 * which is returned to the caller but deliberately NEVER persisted on the
 * tender row.
 */
export async function takePaymentDetailed(
  input: TakePaymentInput,
): Promise<{ payment: Payment; clientSecret?: string }> {
  const driver = getPosDriver();

  // Idempotency guard: a tender with this id already exists → return it.
  const existing = await driver.getPayment(input.paymentId);
  if (existing) {
    if (existing.order_id !== input.orderId) throw new PaymentConflictError();
    return { payment: existing };
  }

  // Defense in depth: in real mode a card rail must always be scoped to a real
  // connected account — never fall back to the platform account.
  if (
    railChargesApplicationFee(input.rail) &&
    !cardRailsSimulated() &&
    (!input.connectAccountId || input.connectAccountId.startsWith("acct_sim_"))
  ) {
    throw new CardPaymentsNotReadyError();
  }

  const rail = requirePaymentRail(input.rail);
  const amount = { amount: input.amountCents, currency: input.currency };
  const tip =
    input.tipCents > 0
      ? { amount: input.tipCents, currency: input.currency }
      : undefined;

  // Pass the cash-tendered amount to the cash rail (for change calculation).
  const metadata: Record<string, string> = {
    ...input.metadata,
    // Server-owned correlation ids (override anything client-supplied).
    order_id: input.orderId,
    payment_id: input.paymentId,
    tenant_id: input.tenantId,
  };
  if (input.rail === "cash" && input.cashTenderedCents !== undefined) {
    metadata.cashTenderedCents = String(input.cashTenderedCents);
  }

  const result = await rail.createCharge({
    context: {
      tenantId: input.tenantId,
      locationId: input.locationId,
      connectAccountId: input.connectAccountId ?? null,
      idempotencyKey: input.paymentId,
    },
    amount,
    tip,
    capture: true,
    metadata,
  });

  // Pull the application fee the rail computed (card rails only).
  const applicationFeeCents = railChargesApplicationFee(input.rail)
    ? Number(result.raw?.applicationFeeCents ?? 0)
    : 0;

  const cashTendered =
    input.rail === "cash"
      ? Number(result.raw?.cashTenderedCents ?? input.cashTenderedCents ?? input.amountCents + input.tipCents)
      : null;
  const cashChange =
    input.rail === "cash" ? Number(result.raw?.cashChangeCents ?? 0) : null;

  const payment: Payment = {
    id: input.paymentId,
    order_id: input.orderId,
    tenant_id: input.tenantId,
    location_id: input.locationId,
    rail: input.rail,
    status: result.status as PaymentStatus,
    amount_cents: input.amountCents,
    tip_cents: input.tipCents,
    application_fee_cents: applicationFeeCents,
    currency: input.currency,
    charge_id: result.chargeId,
    connect_account_id: input.connectAccountId ?? null,
    crypto_tx_hash: result.cryptoTxHash ?? null,
    crypto_chain: result.cryptoChain ?? null,
    cash_tendered_cents: cashTendered,
    cash_change_cents: cashChange,
    refunded_cents: 0,
    simulated: railIsSimulated(input.rail),
    raw: result.raw ?? null,
    created_at: nowIso(),
    updated_at: nowIso(),
  };

  let saved: Payment;
  try {
    saved = await driver.upsertPayment(payment);
  } catch (err) {
    // A different live card/Coinbase tender already holds this order's slot
    // (payments_one_live_card_or_cb). The intent we just created is an orphan:
    // cancel it so it can never be confirmed.
    if (
      err instanceof LiveTenderConflictError &&
      (isRealIntentTender(payment) || isRealTerminalTender(payment))
    ) {
      await stripeRequest(
        `/payment_intents/${payment.charge_id}/cancel`,
        {},
        { stripeAccount: payment.connect_account_id },
      ).catch(() => undefined);
    }
    throw err;
  }
  if (saved.status === "captured" || saved.status === "authorized") {
    // This tender may have just covered the order: any card-reader / card intent
    // still open on it must not stay live (it could be tapped and double charge).
    // The tender is already saved: a failure closing the others must not turn
    // this into a 502 (alert, then still evaluate the order).
    await closeSiblingsOfSettledOrder(saved).catch((err) =>
      captureError(err, {
        scope: "close-siblings",
        paymentId: saved.id,
        orderId: input.orderId,
      }),
    );
  }
  await maybeMarkOrderPaid(input.orderId);
  return { payment: saved, clientSecret: result.clientSecret };
}

/**
 * Persist a rail-reported status for a tender and ALWAYS re-evaluate the order.
 * Used by takePayment, polling and the provider webhooks.
 *
 * Precedence: a `refunded` tender never changes, and a `captured` tender is never
 * downgraded (a late `failed`/`canceled`/`pending` event or a replayed older
 * webhook must not un-settle money). Everything else takes the new status. The
 * order check runs even when the tender status is unchanged, so an order whose
 * tender settled before the order was evaluated still becomes `paid`.
 */
export async function applyRailStatus(
  paymentId: string,
  status: PaymentStatus,
  opts: {
    raw?: Record<string, unknown>;
    /**
     * Gratuity the rail learned AFTER the tender was created (a card-present tip
     * typed on the reader). Base `amount_cents` is never touched.
     */
    tipCents?: number;
  } = {},
): Promise<Payment | null> {
  const driver = getPosDriver();
  const payment = await driver.getPayment(paymentId);
  if (!payment) return null;

  let saved = payment;
  const locked =
    payment.status === "refunded" ||
    (payment.status === "captured" && status !== "refunded");
  if (
    !locked &&
    (status !== payment.status ||
      opts.raw ||
      (opts.tipCents !== undefined && opts.tipCents !== payment.tip_cents))
  ) {
    const next: Payment = {
      ...payment,
      status,
      tip_cents: opts.tipCents ?? payment.tip_cents,
      raw: opts.raw ? { ...(payment.raw ?? {}), ...opts.raw } : payment.raw,
      updated_at: nowIso(),
    };
    try {
      saved = await driver.upsertPayment(next);
    } catch (err) {
      if (!(err instanceof LiveTenderConflictError)) throw err;
      saved = await resolveLiveTenderConflict(payment, next, err);
    }
    if (
      (saved.status === "captured" || saved.status === "authorized") &&
      saved.status !== payment.status
    ) {
      await closeSiblingsOfSettledOrder(saved);
    }
  }
  await maybeMarkOrderPaid(payment.order_id);
  return saved;
}

/**
 * A status flip would make a second tender of the same card/Coinbase rail OPEN
 * (`payments_one_live_card_or_cb` covers only requires_action/pending): typically
 * a late "payment failed / requires action" event for a tender that was canceled
 * when the customer switched rail or retried, while a newer tender holds the
 * slot. The flip is ignored (the tender stays canceled) and logged. A SETTLING
 * flip can never conflict (settled tenders do not hold the slot), so money that
 * settled is always recorded; if the index of an un-migrated database refuses it
 * anyway, the error is rethrown rather than ever recording captured money as
 * canceled.
 */
async function resolveLiveTenderConflict(
  current: Payment,
  next: Payment,
  err: unknown,
): Promise<Payment> {
  if (next.status === "captured" || next.status === "authorized") throw err;
  captureError(new Error("ignored status flip that would open a second live tender"), {
    scope: "live-tender-conflict",
    paymentId: current.id,
    orderId: current.order_id,
  });
  return current;
}

/**
 * Cancel a tender's provider-side object, if it has one that is still open: a
 * real Stripe PaymentIntent (on the connected account) or a real Coinbase charge.
 * Throws when the provider refuses. Does NOT touch the local row.
 */
export async function cancelTenderOnProvider(p: Payment): Promise<void> {
  if (isRealTerminalTender(p)) {
    // Clear the reader's screen first (best effort: it may be offline, idle, or
    // mid-authorization). Canceling the PaymentIntent is what makes a late tap
    // fail, and it throws if the card already succeeded (the caller re-syncs).
    const readerId = typeof p.raw?.reader_id === "string" ? p.raw.reader_id : null;
    if (readerId) {
      await cancelReaderActionForIntent(
        p.connect_account_id!,
        readerId,
        p.charge_id!,
      ).catch(() => undefined);
    }
    await stripeRequest(
      `/payment_intents/${p.charge_id}/cancel`,
      {},
      { stripeAccount: p.connect_account_id },
    );
    return;
  }
  if (isRealIntentTender(p)) {
    await stripeRequest(
      `/payment_intents/${p.charge_id}/cancel`,
      {},
      { stripeAccount: p.connect_account_id },
    );
    return;
  }
  if (p.rail === "crypto_coinbase" && !p.simulated && p.charge_id) {
    await cancelCoinbaseCharge(p.charge_id);
  }
}

/**
 * Cancel an open (`requires_action`/`pending`) tender: provider first, BEST EFFORT
 * (a refusal is logged, the local row is canceled regardless), then the local
 * row. A settled tender is left alone. Used where the order itself is being
 * given up (sweeper, cancel, a tender created on an abandoned order).
 */
export async function cancelPendingTender(p: Payment): Promise<void> {
  if (p.status !== "requires_action" && p.status !== "pending") return;
  await cancelTenderOnProvider(p).catch((err) =>
    captureError(err, {
      scope: "cancel-tender-provider",
      paymentId: p.id,
      orderId: p.order_id,
      rail: p.rail,
    }),
  );
  await applyRailStatus(p.id, "canceled");
}

/**
 * Called right after a CASH tender was written on an online order. If tenders
 * created EARLIER (by created_at, then id) and already settled cover the amount
 * due, this tender is excess: a concurrent till raced us. It is voided
 * (`canceled`, bypassing the captured lock) and true is returned. The ordering is
 * total, so of two racing tenders exactly one is voided.
 */
export async function voidIfOverpaying(payment: Payment): Promise<boolean> {
  const driver = getPosDriver();
  const order = await driver.getOrder(payment.order_id);
  if (!order) return false;
  const earlier = (await listOrderCurrencyPayments(order)).filter(
    (p) =>
      p.id !== payment.id &&
      (p.status === "captured" || p.status === "authorized") &&
      (p.created_at < payment.created_at ||
        (p.created_at === payment.created_at && p.id < payment.id)),
  );
  if (earlier.reduce((n, p) => n + p.amount_cents, 0) < orderDueCents(order)) {
    return false;
  }
  await driver.upsertPayment({
    ...payment,
    status: "canceled",
    raw: { ...(payment.raw ?? {}), voided: "overpay" },
    updated_at: nowIso(),
  });
  return true;
}

export type OpenTenderOutcome = "canceled" | "in_flight" | "settled";

/**
 * STRICT cancel of an open (`requires_action`/`pending`) tender: the provider is
 * asked first; if it REFUSES (a Coinbase payment detected, a card confirming) the
 * tender is re-synced from the provider and is NOT marked canceled locally unless
 * the provider says it is. Returns
 *  - `canceled`: the provider object (if any) and the local row are canceled;
 *  - `settled`: the provider says the money landed (recorded by the re-sync);
 *  - `in_flight`: still pending at the provider: leave it alone.
 */
export async function cancelOpenTender(p: Payment): Promise<OpenTenderOutcome> {
  try {
    await cancelTenderOnProvider(p);
  } catch (err) {
    const synced = await refreshPaymentStatus(p.id).catch(() => null);
    if (synced?.status === "captured" || synced?.status === "authorized") {
      return "settled";
    }
    if (synced?.status === "canceled" || synced?.status === "failed") {
      return "canceled";
    }
    captureError(err, {
      scope: "cancel-open-tender",
      paymentId: p.id,
      orderId: p.order_id,
      rail: p.rail,
    });
    return "in_flight";
  }
  await applyRailStatus(p.id, "canceled");
  return "canceled";
}

/**
 * An online order is now fully covered by settled money: any other tender still
 * open on it is no longer needed, so close it (STRICT, see `cancelOpenTender`: a
 * tender the provider will not release is left open and alerted, never marked
 * canceled). Runs only once settled money covers the amount due, so an in-store
 * split (card for part, the rest still open) is left alone.
 */
async function closeSiblingsOfSettledOrder(settled: Payment): Promise<void> {
  const driver = getPosDriver();
  const order = await driver.getOrder(settled.order_id);
  if (!order) return;
  const payments = await listOrderCurrencyPayments(order);
  if (settledCents(payments) < orderDueCents(order)) return;
  for (const o of payments) {
    if (o.id === settled.id) continue;
    if (o.status !== "requires_action" && o.status !== "pending") continue;
    const outcome = await cancelOpenTender(o);
    if (outcome === "in_flight") {
      captureError(
        new Error("open tender still confirming on an order that is already fully paid"),
        { scope: "settled-order-open-tender", orderId: order.id, paymentId: o.id },
      );
    }
  }
}

/**
 * Before a NEW online tender is created, close every OTHER open tender on the
 * order so exactly one rail is live (rail switch): open card intents are
 * canceled on Stripe (strict, see `cancelOpenOnlineIntents`), a pending
 * SIMULATED USDC tender is canceled locally, and a pending Coinbase charge is
 * canceled with Coinbase (if Coinbase refuses, the charge is re-synced: still
 * pending means it may be paid, so the switch is refused). A card that is
 * `processing` is never canceled.
 *
 * TODO(slice 3): a REAL pending USDC tender is never auto-canceled today, because
 * real USDC detection does not exist yet (nothing could tell us a transfer was
 * in flight). Once the watcher lands, cancel it only when no transfer is seen.
 */
export async function cancelSupersededTenders(
  orderId: string,
  exceptPaymentId: string,
): Promise<void> {
  await cancelOpenOnlineIntents(orderId, exceptPaymentId);
  const pending = (await getPosDriver().listPaymentsForOrder(orderId)).filter(
    (p) => p.status === "pending" && p.id !== exceptPaymentId,
  );
  for (const p of pending) {
    if (p.rail === "crypto_onchain_usdc") {
      if (!p.simulated) continue; // TODO(slice 3), see above
      await applyRailStatus(p.id, "canceled");
    } else if (p.rail === "crypto_coinbase") {
      const outcome = await cancelOpenTender(p);
      if (outcome === "in_flight") {
        throw new Error("A Coinbase payment is still being confirmed.");
      }
    }
  }
}

/**
 * Re-check a pending tender's status with its rail (crypto confirmation watcher,
 * Stripe capture) and persist the new status. Marks the order paid if covered.
 */
export async function refreshPaymentStatus(
  paymentId: string,
): Promise<Payment | null> {
  const driver = getPosDriver();
  const payment = await driver.getPayment(paymentId);
  if (!payment) return null;
  if (payment.status === "captured" || payment.status === "refunded") {
    // Nothing to ask the rail, but make sure the order caught up.
    await maybeMarkOrderPaid(payment.order_id);
    return payment;
  }
  // A card-present tender on a reader is settled by the terminal flow (it reads
  // the PaymentIntent AND the reader, records the tip/receipt, and a simulated one
  // waits for the simulated reader): never by the rail's blanket `status`.
  if (payment.rail === "stripe_terminal" && payment.raw?.reader_id) {
    const { syncCardTender } = await import("./terminal/flow");
    return (await syncCardTender(paymentId)).payment;
  }

  const rail = requirePaymentRail(payment.rail);
  const status = await rail.status(
    {
      tenantId: payment.tenant_id,
      locationId: payment.location_id,
      connectAccountId: payment.connect_account_id,
      idempotencyKey: payment.id,
    },
    payment.charge_id ?? payment.id,
  );

  return applyRailStatus(payment.id, status);
}

/** True for a real (non-simulated) Stripe PaymentIntent tender. */
export function isRealIntentTender(p: Payment): boolean {
  return (
    p.rail === "stripe_online" &&
    !p.simulated &&
    !!p.charge_id &&
    !p.charge_id.startsWith("sim_") &&
    !!p.connect_account_id &&
    !cardRailsSimulated()
  );
}

/** True for a real (non-simulated) card-present PaymentIntent tender. */
export function isRealTerminalTender(p: Payment): boolean {
  return (
    p.rail === "stripe_terminal" &&
    !p.simulated &&
    !!p.charge_id &&
    !p.charge_id.startsWith("sim_") &&
    !!p.connect_account_id &&
    !cardRailsSimulated()
  );
}

const NON_CANCELABLE_INTENT_STATUSES = ["succeeded", "processing", "canceled"];

/**
 * Before a NEW stripe_online intent is created for an order, cancel any earlier
 * stripe_online tenders still in `requires_action`: cancel the PaymentIntent on
 * the connected account and mark the tender canceled, so two open intents can
 * never both be confirmed. If Stripe refuses to cancel (e.g. it already
 * succeeded / processing / already canceled), the tender is re-synced from
 * Stripe instead; any other failure propagates and blocks creating another
 * intent.
 */
export async function cancelOpenOnlineIntents(
  orderId: string,
  exceptPaymentId?: string,
): Promise<void> {
  const open = (await getPosDriver().listPaymentsForOrder(orderId)).filter(
    (p) =>
      p.rail === "stripe_online" &&
      p.status === "requires_action" &&
      p.id !== exceptPaymentId,
  );
  for (const p of open) {
    if (isRealIntentTender(p)) {
      try {
        await stripeRequest(
          `/payment_intents/${p.charge_id}/cancel`,
          {},
          { stripeAccount: p.connect_account_id },
        );
      } catch (err) {
        // The cancel failed. Only carry on if Stripe says the intent is in a
        // state that can no longer be confirmed by the customer in a way we
        // don't already track (succeeded / processing / canceled): sync it.
        // Anything else (a transient error, a still-cancelable intent) means
        // the old intent may yet be confirmed, so rethrow and create no new one.
        const intent = await stripeGet<{ status: string }>(
          `/payment_intents/${p.charge_id}`,
          { stripeAccount: p.connect_account_id },
        ).catch(() => null);
        if (!intent || !NON_CANCELABLE_INTENT_STATUSES.includes(intent.status)) {
          throw err;
        }
        await applyRailStatus(p.id, mapIntentStatus(intent.status));
        continue;
      }
    }
    await applyRailStatus(p.id, "canceled");
  }
}

/**
 * For the idempotent-retry path: a fresh `client_secret` for a stripe_online
 * tender still awaiting the customer, retrieved from Stripe on the connected
 * account (never stored). Also re-syncs the tender if Stripe moved on.
 */
export async function freshClientSecret(
  payment: Payment,
): Promise<string | undefined> {
  if (payment.status !== "requires_action" || !isRealIntentTender(payment)) {
    return undefined;
  }
  try {
    const intent = await stripeGet<{ status: string; client_secret?: string }>(
      `/payment_intents/${payment.charge_id}`,
      { stripeAccount: payment.connect_account_id },
    );
    const mapped = mapIntentStatus(intent.status);
    if (mapped !== "requires_action") {
      await applyRailStatus(payment.id, mapped);
      return undefined;
    }
    return intent.client_secret;
  } catch {
    return undefined;
  }
}

/** A refund would exceed what is left on the tender (maps to HTTP 409). */
export class RefundExceedsError extends Error {
  constructor() {
    super("Refund amount exceeds what is left on this payment.");
    this.name = "RefundExceedsError";
  }
}

/**
 * Rails whose `refund()` only RECORDS the intent: nothing is sent on-chain or via
 * Coinbase. The money must be returned by hand.
 */
export function isManualRefundRail(rail: Payment["rail"]): boolean {
  return rail === "crypto_onchain_usdc" || rail === "crypto_coinbase";
}

/** True for the card rails, where Stripe itself caps the refunded money. */
function isCardRail(rail: Payment["rail"]): boolean {
  return rail === "stripe_terminal" || rail === "stripe_online";
}

/**
 * Refund a tender (full or partial). The local bookkeeping (refunded_cents,
 * refund-id append, over-refund cap) is ATOMIC in the driver
 * (`reservePaymentRefund`), so concurrent refunds never lose an update.
 *
 *  - cash / crypto: nothing external caps the money, so RESERVE first, then call
 *    the rail; if the rail fails the reservation is released.
 *  - card: Stripe caps the money (and dedupes on the idempotency key), so call
 *    the rail first, then record atomically. (Reserving first would turn a crash
 *    between reserve and the Stripe call into a refund recorded but never made.)
 *
 * Returns `replayed: true` (and writes nothing) for a repeated `refundId`.
 */
export async function refundPayment(input: {
  paymentId: string;
  amountCents?: number;
  reason?: string;
  /**
   * Client-minted id for THIS refund request. A retry with the same id is
   * idempotent (same Stripe key, and never applied to the tender twice), while a
   * new id is a new refund, so repeated partial refunds work.
   */
  refundId?: string;
}): Promise<
  | (Payment & {
      replayed?: boolean;
      refundedNowCents?: number;
      /**
       * True when the rail only RECORDS the refund (crypto): no money moved, staff
       * must send it back themselves. Callers must say so, never "refunded".
       */
      manualRefund?: boolean;
    })
  | null
> {
  const driver = getPosDriver();
  const payment = await driver.getPayment(input.paymentId);
  if (!payment) return null;

  const total = payment.amount_cents + payment.tip_cents;
  const refundId = input.refundId ?? null;
  if (refundId && (payment.refund_ids ?? []).includes(refundId)) {
    return { ...payment, replayed: true, refundedNowCents: 0 };
  }

  const rail = requirePaymentRail(payment.rail);
  const refundAmount = input.amountCents ?? total - payment.refunded_cents;
  if (refundAmount <= 0 || payment.refunded_cents + refundAmount > total) {
    throw new RefundExceedsError();
  }

  const callRail = () =>
    rail.refund({
      context: {
        tenantId: payment.tenant_id,
        locationId: payment.location_id,
        connectAccountId: payment.connect_account_id,
        // Unique per refund request. Without a client refundId fall back to a
        // counter of what was already refunded + the amount (clients should
        // send refundId).
        idempotencyKey: refundId
          ? `refund_${payment.id}_${refundId}`
          : `refund_${payment.id}_${payment.refunded_cents}_${refundAmount}`,
      },
      chargeId: payment.charge_id ?? payment.id,
      amount: { amount: refundAmount, currency: payment.currency },
      reason: input.reason,
    });

  let recorded: RefundReservation;
  if (isCardRail(payment.rail)) {
    await callRail();
    recorded = await driver.reservePaymentRefund(payment.id, refundAmount, refundId);
  } else {
    recorded = await driver.reservePaymentRefund(payment.id, refundAmount, refundId);
    if (recorded.ok) {
      try {
        await callRail();
      } catch (err) {
        await driver.releasePaymentRefund(payment.id, refundAmount, refundId);
        throw err;
      }
    }
  }

  if (!recorded.ok) {
    if (recorded.reason === "duplicate" && recorded.payment) {
      return { ...recorded.payment, replayed: true, refundedNowCents: 0 };
    }
    if (recorded.reason === "not_found") return null;
    throw new RefundExceedsError();
  }
  const updated = recorded.payment;

  // If all tenders on the order are fully refunded, mark the order refunded.
  const all = await driver.listPaymentsForOrder(payment.order_id);
  const allRefunded =
    all.length > 0 && all.every((p) => p.status === "refunded");
  // Compare-and-set from a "real" order status only: an abandoned/voided/awaiting
  // order (a refunded LATE payment) must keep its status, not turn `refunded`.
  if (allRefunded) {
    await driver.transitionOrderStatus(
      payment.order_id,
      [
        "draft",
        "placed",
        "paid",
        "in_kitchen",
        "ready",
        "recall",
        "out_for_delivery",
        "completed",
      ],
      "refunded",
    );
  }

  return {
    ...updated,
    refundedNowCents: refundAmount,
    manualRefund: isManualRefundRail(payment.rail),
  };
}

/**
 * Mark the order `paid` once SETTLED (authorized/captured) tenders cover the
 * amount due. Only a `draft`, `placed` or `awaiting_payment` order moves to
 * `paid`: a late settlement (webhook, slow crypto) must never regress an order
 * that has already progressed (`in_kitchen`, `ready`, `completed`, ...). Never
 * downgrades. Every move is a compare-and-set, so concurrent settlements (webhook
 * + client sync + sweeper) cannot double-apply.
 *
 *  - `draft`/`placed` (in-store, and legacy online orders placed before the
 *    lifecycle shipped): plain move to `paid`.
 *  - `awaiting_payment` (online): `finalizeOnlinePayment` -- the single place that
 *    promotes the order onto the KDS, depletes inventory and dispatches delivery.
 *  - `abandoned`/`voided`: ANY settled money (even below the amount due) is
 *    flagged for a manual accept-or-refund; the order is NOT promoted.
 *  - online orders holding MORE settled money than they are worth (two tenders
 *    both settled) are flagged as a duplicate payment.
 */
async function maybeMarkOrderPaid(orderId: string): Promise<void> {
  const driver = getPosDriver();
  const order = await driver.getOrder(orderId);
  if (!order) return;

  const payments = await listOrderCurrencyPayments(order);
  if (order.status === "abandoned" || order.status === "voided") {
    await flagLatePayment(order, payments);
    return;
  }
  if (settledCents(payments) < orderDueCents(order)) return;

  if (order.status === "draft" || order.status === "placed") {
    await driver.transitionOrderStatus(orderId, ["draft", "placed"], "paid");
  } else if (order.status === "awaiting_payment") {
    await finalizeOnlinePayment(orderId);
  } else if (order.status !== "paid") {
    console.info(
      `[payments] order ${orderId} settled while ${order.status}; status left unchanged`,
    );
  }
  await flagDuplicatePayment(order, payments);
}

/** Nil UUID: the `actor_user_id` of audit rows written by the system itself. */
const SYSTEM_ACTOR = {
  id: "00000000-0000-0000-0000-000000000000",
  label: "checkout lifecycle",
};

/** Money still held on settled tenders (refunds netted off), base + tip. */
function netSettledCents(payments: Payment[]): number {
  return payments
    .filter((p) => p.status === "captured" || p.status === "authorized")
    .reduce(
      (n, p) => n + Math.max(0, p.amount_cents + p.tip_cents - p.refunded_cents),
      0,
    );
}

export { netSettledCents };

/**
 * Money settled on an order we already gave up on (`abandoned`, or a legacy
 * `voided` online order), even if it is less than the order was worth. The order
 * is NOT promoted (the customer was told the checkout expired; the kitchen must
 * not cook it unasked). Instead:
 *  - the error sink is alerted;
 *  - a durable `late_payment` marker is set in the order's fulfillment (no schema
 *    change; survives restarts; makes the order appear in the admin "Late
 *    payments" list until accepted or refunded);
 *  - an audit row is written.
 * Idempotent: an unchanged settled amount does nothing, and a marker that already
 * carries a resolution is never overwritten.
 */
async function flagLatePayment(order: Order, payments: Payment[]): Promise<void> {
  const settled = payments.filter(
    (p) => p.status === "captured" || p.status === "authorized",
  );
  if (settled.length === 0) return;
  const amount = netSettledCents(payments);
  if (amount <= 0) return;
  const prior = order.fulfillment?.late_payment;
  if (prior?.resolved) return;
  if (prior && prior.amount_cents === amount) return;
  captureError(new Error("payment settled on an abandoned order"), {
    scope: "late-payment",
    orderId: order.id,
    tenantId: order.tenant_id,
    amountCents: amount,
  });
  if (!order.fulfillment) return; // not an online order: nothing to mark
  const driver = getPosDriver();
  const now = nowIso();
  if (prior) {
    await driver.updateLatePayment(order.id, {
      amount_cents: amount,
      payment_id: settled[0]!.id,
    });
  } else {
    await driver.mergeOrderFulfillment(order.id, {
      late_payment: {
        kind: "late",
        payment_id: settled[0]!.id,
        amount_cents: amount,
        flagged_at: now,
      },
    });
  }
  await recordAudit({
    actor: SYSTEM_ACTOR,
    action: "late_payment_flagged",
    tenantId: order.tenant_id,
    detail: `${amount}c settled on ${order.status} order ${order.id} (payment ${settled[0]!.id}); needs accept or refund.`,
  });
}

/**
 * An ONLINE order that holds more settled money than it is worth (two tenders
 * both settled, e.g. a webhook for a tender the customer had abandoned, or
 * concurrent cash). Both tenders stay recorded as settled; this puts the excess
 * in the admin list as "Duplicate payment, refund one" via the same marker.
 */
async function flagDuplicatePayment(order: Order, payments: Payment[]): Promise<void> {
  // In-store orders carry the tip on each tender (not in the order total), so
  // their excess is measured on base amounts; online orders fold the tip in.
  const inStore = order.channel === "in_store";
  const held = inStore
    ? payments
        .filter((p) => p.status === "captured" || p.status === "authorized")
        // Refunds are taken off the tip first, so a tip-only refund can't hide a
        // duplicate of the base.
        .reduce(
          (n, p) =>
            n + Math.max(0, p.amount_cents - Math.max(0, p.refunded_cents - p.tip_cents)),
          0,
        )
    : netSettledCents(payments);
  const excess = held - (inStore ? orderDueCents(order) : order.totals.total_cents);
  if (excess <= 0) return;
  const prior = order.fulfillment?.late_payment;
  if (prior && (prior.kind !== "duplicate" || prior.resolved || prior.amount_cents === excess)) {
    return;
  }
  const newest = payments
    .filter((p) => p.status === "captured" || p.status === "authorized")
    .sort((a, b) => b.created_at.localeCompare(a.created_at))[0]!;
  captureError(new Error("DOUBLE SETTLEMENT: order holds more settled money than it is worth"), {
    scope: "duplicate-payment",
    orderId: order.id,
    tenantId: order.tenant_id,
    excessCents: excess,
  });
  const driver = getPosDriver();
  if (prior) {
    await driver.updateLatePayment(order.id, { amount_cents: excess, payment_id: newest.id });
  } else {
    await driver.mergeOrderFulfillment(order.id, {
      late_payment: {
        kind: "duplicate",
        payment_id: newest.id,
        amount_cents: excess,
        flagged_at: nowIso(),
      },
    });
  }
  await recordAudit({
    actor: SYSTEM_ACTOR,
    action: "late_payment_flagged",
    tenantId: order.tenant_id,
    detail: `Duplicate payment: ${excess}c more settled than owed on order ${order.id}; refund one tender.`,
  });
}
