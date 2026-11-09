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
import { assertTakesPayment } from "@/lib/marketplace/guard";
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
import {
  baseRefundedCents,
  coveringBaseCents,
  isFullyRefunded,
  liveTenders,
  refundableParts,
  refundedTenderCovers,
  refundedTendersCover,
  settledBaseCents,
} from "./refund-state";
import type { PaymentRailKey } from "./PaymentRail";
import { RefundRefusedError } from "./PaymentRail";
import { requirePaymentRail } from "./registry";
import {
  mapIntentStatus,
  StripeError,
  StripeTimeoutError,
  STRIPE_TIMEOUT_MS,
  stripeGet,
  stripeRequest,
} from "./providers/stripe-client";
import { cancelReaderActionForIntent } from "./providers/stripe-terminal-api";
import { railChargesApplicationFee } from "./fees";
import { expireCheckoutSession, getCheckoutSession } from "./rails/stripe-online";
import { CardPaymentsNotReadyError } from "./connect";
import { cashTenderError } from "./cash-tender";
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
    case "gift_card":
    case "store_credit":
      return false; // cash and stored value are always real
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

/**
 * A cash tender whose cash handed over is less than its amount + tip (maps to
 * HTTP 422). A short tender must be sent as a partial (amount = cash handed over).
 */
export class CashUnderTenderError extends Error {
  readonly code = "cash_under_tender";
  constructor(message: string) {
    super(message);
    this.name = "CashUnderTenderError";
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
 * Tenders that cover the balance: pending, authorized, captured -- INCLUDING
 * pending crypto, so the cashier isn't asked to collect twice while it
 * confirms -- and REFUNDED tenders when the order was paid in full (a refund
 * after the sale never re-opens the balance or invites a second charge; to
 * collect again, staff ring a new order). On an order never paid in full a
 * refunded tender was given back and does not count. `requires_action`,
 * failed and canceled tenders never cover. See refund-state.ts.
 */
function coveredTenders(payments: Payment[], dueCents: number): Payment[] {
  const legacy = refundedTendersCover(payments, dueCents);
  return payments.filter(
    (p) =>
      p.status === "pending" ||
      p.status === "authorized" ||
      p.status === "captured" ||
      (p.status === "refunded" && refundedTenderCovers(p, legacy)),
  );
}

/**
 * Was the order paid in full (settled money covering the amount due, refunded
 * tenders only as far as they still cover)? Refunds of an order that never was
 * are refused at the till (void it instead).
 */
export async function orderPaidInFull(order: Order): Promise<boolean> {
  const payments = await listOrderCurrencyPayments(order);
  const due = orderDueCents(order);
  return settledCents(payments, due) >= due;
}

function coveredCents(payments: Payment[], dueCents: number): number {
  return coveringBaseCents(payments, dueCents);
}

/** Settled base money under the same rule (the order is `paid` once it covers the due). */
function settledCents(payments: Payment[], dueCents: number): number {
  return settledBaseCents(payments, dueCents);
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

/**
 * Pure balance rule behind `getOrderBalance`: amount due minus covering tenders
 * in the ORDER's currency (never negative).
 */
export function orderBalanceFromPayments(
  order: Order,
  all: Payment[],
): number {
  // A marketplace order (DoorDash / Uber Eats / Grubhub) is paid by the
  // marketplace before it reaches us: it never owes a balance at the till.
  if (order.channel === "marketplace") return 0;
  const cur = order.currency.toUpperCase();
  const payments = all.filter((p) => p.currency.toUpperCase() === cur);
  const due = orderDueCents(order);
  return Math.max(0, due - coveredCents(payments, due));
}

/** Remaining unpaid balance on an order, in cents (never negative). */
export async function getOrderBalance(order: Order): Promise<number> {
  const payments = await getPosDriver().listPaymentsForOrder(order.id);
  return orderBalanceFromPayments(order, payments);
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
  const covering = coveredTenders(payments, orderDueCents(order));
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

  // Paid by the marketplace: never takes a tender, whatever route got here.
  const target = await driver.getOrder(input.orderId);
  if (target) assertTakesPayment(target);

  // Cash must be covered by what was handed over: a short tender is never booked
  // as the full amount (it would leave the drawer short and the order "paid").
  if (input.rail === "cash") {
    const short = cashTenderError(input);
    if (short) throw new CashUnderTenderError(short);
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
    /**
     * Rail-native charge id learned AFTER the tender was created: a Checkout
     * tender has no PaymentIntent until the payer confirms, so the webhook (or
     * the session re-read) writes it on capture. Only fills an empty charge_id;
     * refunds need it.
     */
    chargeId?: string;
    /** `/v1` payment session status to record when the tender is canceled/failed. */
    sessionStatus?: "expired" | "canceled";
  } = {},
): Promise<Payment | null> {
  const driver = getPosDriver();
  const payment = await driver.getPayment(paymentId);
  if (!payment) return null;

  let saved = payment;
  const locked =
    payment.status === "refunded" ||
    (payment.status === "captured" && status !== "refunded");
  const newChargeId = !payment.charge_id && opts.chargeId ? opts.chargeId : null;
  if (
    !locked &&
    (status !== payment.status ||
      opts.raw ||
      newChargeId ||
      (opts.tipCents !== undefined && opts.tipCents !== payment.tip_cents))
  ) {
    const next: Payment = {
      ...payment,
      status,
      charge_id: newChargeId ?? payment.charge_id,
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
  // ALWAYS mirror the tender onto its session row (not only on a status change):
  // a sync that failed once, or a webhook that repeats an already-applied status,
  // must still repair a session row left `open` after the money landed.
  await syncPaymentSession(saved, opts.sessionStatus).catch((err) =>
    captureError(err, { scope: "payment-session-sync", paymentId: saved.id }),
  );
  await maybeMarkOrderPaid(payment.order_id);
  return saved;
}

// ---------------------------------------------------------------------------
// /v1 payment sessions (Stripe Checkout on the connected account)
// ---------------------------------------------------------------------------

/** The Checkout Session id a tender was created for, if it is a session tender. */
function checkoutSessionId(p: Payment): string | null {
  const id = p.raw?.checkout_session_id;
  return p.rail === "stripe_online" && typeof id === "string" ? id : null;
}

/** True for a tender created by `POST /orders/{id}/payment-sessions`. */
export function isCheckoutTender(p: Payment): boolean {
  return checkoutSessionId(p) !== null;
}

/**
 * True for a REAL Stripe Checkout tender: not simulated, on a connected account,
 * and the session id is a Stripe one (never a local `cs_sim_` id).
 */
export function isRealCheckoutTender(p: Payment): boolean {
  const id = checkoutSessionId(p);
  return (
    id !== null &&
    !p.simulated &&
    id.startsWith("cs_") &&
    !id.startsWith("cs_sim_") &&
    !!p.connect_account_id &&
    !cardRailsSimulated()
  );
}

/** Mirror a tender's outcome onto its `payment_sessions` row (if it has one). */
export async function syncPaymentSession(
  payment: Payment,
  sessionStatus?: "expired" | "canceled",
): Promise<void> {
  const sessionId = checkoutSessionId(payment);
  if (!sessionId) return;
  const driver = getPosDriver();
  const session = await driver.getPaymentSessionByStripeId(sessionId);
  if (!session) return;
  if (payment.status === "captured" || payment.status === "authorized") {
    await driver.updatePaymentSession(session.id, {
      status: "completed",
      payment_id: payment.id,
    });
  } else if (payment.status === "canceled" || payment.status === "failed") {
    await driver.updatePaymentSession(session.id, {
      status: sessionStatus ?? "canceled",
    });
  }
}

/**
 * Re-read a REAL Checkout Session from Stripe and settle its tender: a paid
 * session captures the tender (writing the PaymentIntent id as `charge_id`), an
 * expired one cancels it, an open one is left alone. This is the reconcile path
 * behind `GET /payment-sessions/{id}` and every "did it actually pay?" check.
 * The amount is verified against the tender before anything is settled.
 */
export async function syncCheckoutTender(p: Payment): Promise<Payment> {
  const sessionId = checkoutSessionId(p);
  if (!sessionId || !isRealCheckoutTender(p)) return p;
  const s = await getCheckoutSession(sessionId, p.connect_account_id);
  if (s.status === "complete" && s.payment_status === "paid") {
    if (
      s.amount_total !== p.amount_cents + p.tip_cents ||
      (s.currency ?? "").toLowerCase() !== p.currency.toLowerCase()
    ) {
      captureError(new Error("checkout session amount/currency mismatch"), {
        scope: "checkout-sync",
        paymentId: p.id,
        expected: p.amount_cents + p.tip_cents,
        got: s.amount_total,
      });
      return p;
    }
    return (
      (await applyRailStatus(p.id, "captured", {
        chargeId: typeof s.payment_intent === "string" ? s.payment_intent : undefined,
      })) ?? p
    );
  }
  if (s.status === "expired") {
    return (
      (await applyRailStatus(p.id, "canceled", { sessionStatus: "expired" })) ?? p
    );
  }
  return p;
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
  if (isRealCheckoutTender(p)) {
    // A Checkout tender whose payer never confirmed has no PaymentIntent: expire
    // the SESSION. Stripe refuses (throws) if it already completed or expired;
    // the strict callers then re-sync from Stripe.
    await expireCheckoutSession(checkoutSessionId(p)!, p.connect_account_id);
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
  if (settledCents(payments, orderDueCents(order)) < orderDueCents(order)) return;
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

  // A hosted-session (Checkout) tender is settled by re-reading its SESSION, never
  // by the rail's blanket PaymentIntent `status` (it has no intent yet, and a
  // simulated one only completes through its simulate step).
  if (isCheckoutTender(payment)) {
    return isRealCheckoutTender(payment) ? syncCheckoutTender(payment) : payment;
  }

  // An external tender has no rail to ask: it is exactly what the caller recorded.
  if (payment.rail === "external") return payment;

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
    if (isRealCheckoutTender(p)) {
      // STRICT, like a PaymentIntent: expire the Checkout Session first. If
      // Stripe refuses (the payer just completed it, or it already expired) the
      // tender is re-synced from the session; anything still open or unreadable
      // rethrows, so no second session is created while this one can be paid.
      try {
        await expireCheckoutSession(checkoutSessionId(p)!, p.connect_account_id);
      } catch (err) {
        const synced = await syncCheckoutTender(p).catch(() => null);
        if (
          synced &&
          (synced.status === "captured" ||
            synced.status === "authorized" ||
            synced.status === "canceled")
        ) {
          continue;
        }
        throw err;
      }
      await applyRailStatus(p.id, "canceled", { sessionStatus: "canceled" });
      continue;
    }
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

/** A refund was asked for an `external` tender (no processor to refund through). */
export class ExternalRefundUnsupportedError extends Error {
  constructor() {
    super(
      "This payment was recorded from outside POS (cash on delivery, invoice, kiosk card, gift card) and cannot be refunded here. Refund it where it was taken.",
    );
    this.name = "ExternalRefundUnsupportedError";
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
 * The provider REFUSED a refund for sure (a 4xx answer other than an
 * idempotency conflict or a rate limit): no money moved, so the reservation can
 * be released. Anything else (network error, 5xx, 409/429, an unknown error)
 * may or may not have moved money: the reservation stays `pending` and a retry
 * under the same refund id asks the provider again with the same key.
 */
export function isDefiniteRefundFailure(err: unknown): boolean {
  if (err instanceof RefundRefusedError) return true;
  // A timeout is an unknown outcome (Stripe may have refunded): never definite.
  if (err instanceof StripeTimeoutError) return false;
  // An idempotency error means this key was already used (with other params):
  // the original refund may well exist. Never "definite": leave it pending.
  if (err instanceof StripeError && isIdempotencyError(err)) return false;
  return (
    err instanceof StripeError &&
    err.status >= 400 &&
    err.status < 500 &&
    err.status !== 409 &&
    err.status !== 429
  );
}

function isIdempotencyError(err: StripeError): boolean {
  const e = ((err.raw ?? {}) as { error?: { type?: unknown; code?: unknown } }).error;
  return err.code === "idempotency_error" || e?.type === "idempotency_error" || e?.code === "idempotency_error";
}

/**
 * The provider call of one refund entry, built ONLY from what the entry stored
 * (amount, tip part, reason) and stable ids, so the first call, every retry and
 * the replay repair send identical parameters under the same idempotency key.
 */
function providerRefundRequest(
  payment: Payment,
  entry: { amount_cents: number; tip_cents?: number | null; reason: string | null },
  refundId: string,
) {
  const tip = typeof entry.tip_cents === "number" ? entry.tip_cents : 0;
  return {
    context: {
      tenantId: payment.tenant_id,
      locationId: payment.location_id,
      connectAccountId: payment.connect_account_id,
      // One key per refund id: a retry is the SAME refund at the provider.
      idempotencyKey: `refund_${payment.id}_${refundId}`,
    },
    chargeId: payment.charge_id ?? payment.id,
    amount: { amount: entry.amount_cents, currency: payment.currency },
    reason: entry.reason ?? undefined,
    metadata: {
      order_id: payment.order_id,
      payment_id: payment.id,
      refund_id: refundId,
      ...(tip ? { tip_cents: String(tip) } : {}),
    },
  };
}

/** A card refund is reserved and its provider outcome is not known yet (retry to finish). */
export class RefundPendingError extends Error {
  constructor(message = "The refund is still in progress at the card processor: retry to finish it.") {
    super(message);
    this.name = "RefundPendingError";
  }
}

/**
 * Stripe keeps an idempotency key for 24 h: after that the same key is a NEW
 * request, so replaying a card refund older than this could refund twice. Older
 * card refunds are never sent again automatically; they are alerted and resolved
 * by a manager (`resolveStuckCardRefund`, which looks the refund up at Stripe).
 */
export const STRIPE_IDEMPOTENCY_SAFE_MS = 23 * 60 * 60_000;

/** The refund entry is too old to replay under its Stripe idempotency key. */
export function isPastIdempotencyWindow(entry: { at: string }, now = Date.now()): boolean {
  const at = Date.parse(entry.at);
  // No usable timestamp: assume the worst (never replay).
  return !Number.isFinite(at) || now - at > STRIPE_IDEMPOTENCY_SAFE_MS;
}

/** A pending card refund older than Stripe's idempotency window: a manager must resolve it. */
export class RefundNeedsResolutionError extends RefundPendingError {
  constructor() {
    super(
      "This card refund is stuck at the card processor for over a day. A manager must resolve it in the back office (look it up at Stripe) before it can finish.",
    );
    this.name = "RefundNeedsResolutionError";
  }
}

/** How long a card refund replay holds the tender's refund lock (one Stripe call + margin). */
const REPLAY_LOCK_MS = STRIPE_TIMEOUT_MS + 20_000;

/** A gift card sale / reload tender is refunded only under a client refund id (retry-safe). */
export class RefundIdRequiredError extends Error {
  constructor() {
    super("A refund id is required to refund a gift card sale.");
    this.name = "RefundIdRequiredError";
  }
}

/** The provider refused or failed the refund (nothing was recorded). */
export class RefundRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RefundRejectedError";
  }
}

type RefundOutcome = Payment & {
  replayed?: boolean;
  refundedNowCents?: number;
  /** The tip part of what was refunded now. */
  tipRefundedNowCents?: number;
  /** Provider refund id (Stripe re_...) of this refund, when there is one. */
  processorRef?: string | null;
  /**
   * True when the rail only RECORDS the refund (crypto): no money moved, staff
   * must send it back themselves. Callers must say so, never "refunded".
   */
  manualRefund?: boolean;
};

/**
 * Refund a tender (full or partial). The bookkeeping (refunded_cents, the
 * separate base and tip caps, the refund-id append) is ATOMIC in the driver
 * (`reservePaymentRefund`), so concurrent refunds never lose an update or
 * overshoot a cap. The money is ALWAYS reserved first, then the rail is called:
 *
 *  - cash / crypto: a plain reservation; if the rail call fails it is released.
 *  - card and stored value (gift card / store credit): reserved as `pending`
 *    (it holds its room in the caps, so concurrent refunds of one tender are
 *    serialized by the reservation, but status, `refunded_cents` and reports do
 *    not move yet), then the provider is called with the reserved amount and an
 *    idempotency key derived from `refundId` (Stripe; the stored-value credit is
 *    keyed the same way), then the entry is confirmed and the provider refund id
 *    recorded. A definite refusal releases it (card: with a tombstone, so a
 *    Stripe key that failed is never reused; a refund Stripe reports failed /
 *    canceled is a refusal too). An unknown outcome leaves it `pending`: a retry
 *    under the same `refundId` asks the provider again with the same key (it
 *    replays the original refund: never a second one) and confirms it.
 *  - a tender that BOUGHT a gift card (src/lib/giftcards): refused while the
 *    card still holds that value; as EXCESS money (a duplicate tender) it is
 *    re-checked right after the atomic reservation, so two concurrent "excess"
 *    refunds can never both pass.
 *
 * Returns `replayed: true` (and moves nothing) for a refund id that is already
 * done (or was released). An older card refund recorded without a provider id
 * is repaired on replay (`repairReplayedCardRefund`).
 */
export async function refundPayment(input: {
  paymentId: string;
  amountCents?: number;
  reason?: string;
  /**
   * Client-minted id for THIS refund request. A retry with the same id is
   * idempotent (same provider key, and never applied to the tender twice), while
   * a new id is a new refund, so repeated partial refunds work. Every caller
   * sends one; stored value falls back to a deterministic id, anything else to a
   * fresh one (such a call is not retry-safe).
   */
  refundId?: string;
  /**
   * The GRATUITY part of the refund (tip refunds are tracked separately and
   * flagged; base part = amount - tip). Omitted: the legacy rule, base first
   * and only what is left over comes off the tip.
   */
  tipCents?: number;
}): Promise<RefundOutcome | null> {
  const driver = getPosDriver();
  const payment = await driver.getPayment(input.paymentId);
  if (!payment) return null;

  // Money recorded through payments.recordExternal was taken outside POS's
  // processors: there is no rail to return it through (GAPS #48), so refusing
  // beats pretending (and an unrecoverable local-only "refund").
  if (payment.rail === "external") throw new ExternalRefundUnsupportedError();

  const rail = requirePaymentRail(payment.rail);
  const card = isCardRail(payment.rail);
  const storedValueRail = payment.rail === "gift_card" || payment.rail === "store_credit";
  const providerFirst = card || storedValueRail;
  const total = payment.amount_cents + payment.tip_cents;
  const reserved = payment.refund_reserved_cents ?? 0;
  const refundAmount = input.amountCents ?? total - payment.refunded_cents - reserved;
  const refundId =
    input.refundId ??
    (storedValueRail
      ? `auto_${payment.refunded_cents}_${refundAmount}`
      : `auto-${globalThis.crypto.randomUUID()}`);

  type StoredEntry = { amount_cents: number; tip_cents?: number | null; reason: string | null };
  const callRail = (entry: StoredEntry) => rail.refund(providerRefundRequest(payment, entry, refundId));

  /** Card / stored value: ask the provider for a reserved refund, then confirm or release it. */
  const settle = async (entry: StoredEntry): Promise<string | null> => {
    const amountCents = entry.amount_cents;
    let result;
    try {
      result = await callRail(entry);
    } catch (err) {
      if (isDefiniteRefundFailure(err)) {
        await driver.releasePaymentRefund(payment.id, amountCents, refundId, { tombstone: card });
        throw err;
      }
      captureError(err, { scope: "refund-pending", paymentId: payment.id, refundId });
      throw new RefundPendingError();
    }
    if (result.status === "failed" || result.status === "canceled") {
      await driver.releasePaymentRefund(payment.id, amountCents, refundId, { tombstone: card });
      throw new RefundRejectedError(
        `The ${card ? "card processor" : "card"} did not refund it (${result.providerStatus ?? result.status}).`,
      );
    }
    const ref = result.refundId ?? null;
    // If this write fails the entry stays pending: a retry replays the same
    // provider refund (same key) and confirms it. Never recorded twice.
    await driver.confirmPaymentRefund(payment.id, refundId, ref);
    return ref;
  };

  const finish = async (
    amountCents: number,
    tipCents: number,
    processorRef: string | null,
  ): Promise<RefundOutcome> => {
    await maybeMarkOrderRefunded(payment.order_id);
    const fresh = (await driver.getPayment(payment.id)) ?? payment;
    return {
      ...fresh,
      refundedNowCents: amountCents,
      tipRefundedNowCents: tipCents,
      processorRef,
      manualRefund: isManualRefundRail(payment.rail),
    };
  };

  // A refund id seen before: finish it if it is still pending at the provider;
  // an older card refund recorded without a provider id is repaired; else it is
  // done (or was released): replay.
  if ((payment.refund_ids ?? []).includes(refundId)) {
    const entry = (payment.refunds ?? []).find((r) => r.request_id === refundId);
    if (providerFirst && entry?.state === "pending") {
      if (card && isPastIdempotencyWindow(entry)) {
        // Replaying under an expired key could refund twice: alert, never resend.
        captureError(new Error("card refund pending past the Stripe idempotency window"), {
          scope: "refund-needs-resolution",
          paymentId: payment.id,
          refundId,
          sinceIso: entry.at,
        });
        throw new RefundNeedsResolutionError();
      }
      const tip = typeof entry.tip_cents === "number" ? entry.tip_cents : 0;
      if (!card) {
        const ref = await settle(entry);
        return finish(entry.amount_cents, tip, ref);
      }
      // A card replay holds the tender's refund lock while it talks to Stripe,
      // so the stuck-refund resolver (refund-resolve.ts) never looks it up and
      // releases it at the same moment.
      const owner = `replay:${globalThis.crypto.randomUUID()}`;
      const until = new Date(Date.now() + REPLAY_LOCK_MS).toISOString();
      if (!(await driver.takePaymentRefundLock(payment.id, owner, until))) {
        throw new RefundPendingError("A manager is resolving this card refund right now: try again in a moment.");
      }
      let ref: string | null;
      try {
        // Re-read under the lock: the resolver may have just finished it.
        const now = ((await driver.getPayment(payment.id))?.refunds ?? []).find((r) => r.request_id === refundId);
        if (now?.state !== "pending") {
          const fresh = (await driver.getPayment(payment.id)) ?? payment;
          return { ...fresh, replayed: true, refundedNowCents: 0, tipRefundedNowCents: 0 };
        }
        ref = await settle(entry);
      } finally {
        await driver.releasePaymentRefundLock(payment.id, owner).catch(() => undefined);
      }
      return finish(entry.amount_cents, tip, ref);
    }
    const repaired = await repairReplayedCardRefund(payment, refundId, rail);
    return { ...repaired, replayed: true, refundedNowCents: 0, tipRefundedNowCents: 0 };
  }

  if (refundAmount <= 0 || payment.refunded_cents + reserved + refundAmount > total) {
    throw new RefundExceedsError();
  }
  const tipPart = input.tipCents;
  if (tipPart !== undefined) {
    // Explicit split: base and tip are capped separately (a food refund never
    // eats into the tip, a tip refund never into the food).
    const left = refundableParts(payment);
    if (
      !Number.isSafeInteger(tipPart) ||
      tipPart < 0 ||
      tipPart > refundAmount ||
      tipPart > left.tipCents ||
      refundAmount - tipPart > left.baseCents
    ) {
      throw new RefundExceedsError();
    }
  }

  // Stored value: decided BEFORE any money moves (throws while a gift card this
  // tender bought still holds its value).
  const giftcards = await import("@/lib/giftcards/service");
  const saleMode = await giftcards.storedValueSaleRefundMode(payment, refundAmount);
  // A sale tender's refund must be retry-safe: a fresh random id on a retry
  // would be a second refund of the money that bought the card.
  if (saleMode !== null && input.refundId === undefined) throw new RefundIdRequiredError();

  // Whether the order was paid in full when this refund is made: only then does
  // the refunded tender keep covering its balance (refund-state.ts).
  const order = await driver.getOrder(payment.order_id);
  const covering = order ? await orderPaidInFull(order) : null;
  const recorded: RefundReservation = await driver.reservePaymentRefund(
    payment.id,
    refundAmount,
    refundId,
    {
      reason: input.reason ?? null,
      tipCents: tipPart ?? null,
      pending: providerFirst,
      covering,
    },
  );
  if (!recorded.ok) {
    if (recorded.reason === "duplicate") {
      // A concurrent call with the same id got there first: hand it over.
      return refundPayment(input);
    }
    if (recorded.reason === "not_found") return null;
    throw new RefundExceedsError();
  }
  const entry = (recorded.payment.refunds ?? []).find((r) => r.id === recorded.refundEntryId) ?? {
    amount_cents: refundAmount,
    tip_cents: tipPart ?? 0,
    reason: input.reason ?? null,
  };
  const tipNow = typeof entry.tip_cents === "number" ? entry.tip_cents : 0;

  if (saleMode !== null) {
    // Re-checked after the atomic reservation (it sees every concurrent one):
    // "excess" against racing refunds, "released" against a settlement that
    // credited the card between the decision and the reservation.
    try {
      await giftcards.assertStoredValueRefundAllowed(recorded.payment);
    } catch (err) {
      await driver.releasePaymentRefund(payment.id, refundAmount, refundId);
      throw err;
    }
  }

  let processorRef: string | null = null;
  if (providerFirst) {
    processorRef = await settle(entry);
  } else {
    try {
      const r = await callRail(entry);
      processorRef = r?.refundId ?? null;
    } catch (err) {
      await driver.releasePaymentRefund(payment.id, refundAmount, refundId);
      throw err;
    }
  }
  return finish(refundAmount, tipNow, processorRef);
}

/**
 * Every LIVE tender of the order is fully refunded: mark the order `refunded`.
 * Declined / canceled attempts never took money, so they are ignored (an order
 * with an earlier declined card is still fully refunded once its real tender is).
 * Compare-and-set from a "real" order status only: an abandoned/voided/awaiting
 * order (a refunded LATE payment) keeps its status, it does not turn `refunded`.
 */
export async function maybeMarkOrderRefunded(orderId: string): Promise<void> {
  const driver = getPosDriver();
  const all = await driver.listPaymentsForOrder(orderId);
  if (!isFullyRefunded(null, all)) return;
  // Money given back on an order that was never paid in full does not close it
  // out as `refunded`: it is still open (or voided by the void flow). Only when
  // EVERY refund was made while unpaid: a part payment given back earlier must
  // not block an order later paid in full and then fully refunded.
  const entries = liveTenders(all).flatMap((p) => p.refunds ?? []);
  if (entries.length > 0 && entries.every((r) => r.covering === false)) return;
  await driver.transitionOrderStatus(
    orderId,
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

/**
 * A replayed CARD refund whose refunds[] entry has no provider id (the process
 * died between recording it and the Stripe call, or Stripe returned none):
 * call the rail again with the SAME idempotency key (Stripe returns the
 * original refund, or makes it now if it never happened) and record the id.
 * Only within Stripe's idempotency window (~23 h); after it, alert only.
 * Best effort: a failure leaves the entry as it was and is alerted.
 */
async function repairReplayedCardRefund(
  payment: Payment,
  refundId: string,
  rail: ReturnType<typeof requirePaymentRail>,
): Promise<Payment> {
  if (!isCardRail(payment.rail)) return payment;
  const entry = (payment.refunds ?? []).find((r) => r.request_id === refundId);
  if (!entry || entry.processor_ref) return payment;
  const driver = getPosDriver();
  if (!driver.setRefundProcessorRef) return payment;
  if (isPastIdempotencyWindow(entry)) {
    // The key has expired at Stripe: calling again would be a NEW refund (a
    // double refund if the first one happened). Alert; a manager resolves it.
    captureError(new Error("card refund without a Stripe id past the idempotency window"), {
      scope: "refund-needs-resolution",
      paymentId: payment.id,
      refundId,
      sinceIso: entry.at,
    });
    return payment;
  }
  try {
    // The same parameters as the original call (from the stored entry): a
    // different body under the same key is a Stripe idempotency error.
    const railRefund = await rail.refund(providerRefundRequest(payment, entry, refundId));
    if (railRefund?.refundId) {
      await driver.setRefundProcessorRef(payment.id, refundId, railRefund.refundId);
    }
  } catch (err) {
    captureError(err, { scope: "refund-replay-repair", paymentId: payment.id });
  }
  return (await driver.getPayment(payment.id)) ?? payment;
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
async function maybeMarkOrderPaid(
  orderId: string,
  opts: { respectHoldReason?: boolean } = {},
): Promise<void> {
  const driver = getPosDriver();
  const order = await driver.getOrder(orderId);
  if (!order) return;

  const payments = await listOrderCurrencyPayments(order);
  if (order.status === "abandoned" || order.status === "voided") {
    await flagLatePayment(order, payments);
    return;
  }
  if (settledCents(payments, orderDueCents(order)) < orderDueCents(order)) return;

  if (
    order.status === "draft" &&
    order.hold?.reason === "awaiting_payment" &&
    order.fulfillment
  ) {
    // A /v1 order held for payment: settle it like an online checkout, so an ASAP
    // order's `promised_at` counts from payment time (not creation) and a
    // delivery is dispatched later. In-store drafts (no hold) keep the plain move.
    await finalizeOnlinePayment(orderId, { from: ["draft"] });
  } else if (
    // `scheduled` always: a catering order paid by card must still wait for its
    // release time, whichever path recorded the money.
    (opts.respectHoldReason || order.hold?.reason === "scheduled") &&
    order.status === "draft" &&
    order.hold &&
    order.hold.reason !== "awaiting_payment"
  ) {
    // A hold with another reason (`scheduled`, `manual`, ...) is not a payment
    // hold: money alone does not end it (only a release does). Leave it held.
  } else if (order.status === "draft" || order.status === "placed") {
    await driver.transitionOrderStatus(orderId, ["draft", "placed"], "paid");
  } else if (order.status === "awaiting_payment") {
    await finalizeOnlinePayment(orderId);
  } else if (order.status !== "paid") {
    console.info(
      `[payments] order ${orderId} settled while ${order.status}; status left unchanged`,
    );
  }
  // A gift-card sale/reload order: credit the card now that it is paid.
  if (order.core_ext?.stored_value) {
    await (await import("@/lib/giftcards/service"))
      .settleStoredValueOrder(orderId)
      .catch((err) => captureError(err, { scope: "giftcard-settle", orderId }));
  }
  await flagDuplicatePayment(order, payments);
}

/**
 * After an `external` tender was recorded (`payments.recordExternal`): once it is
 * CAPTURED, close any other open tender if the order is now fully covered (a
 * payment-session link must not stay payable), then mark the order paid. Both
 * steps re-read the order and only act on SETTLED base money covering the food
 * amount due (`orderDueCents`: tips never count), so a partial tender, a pending
 * (invoice / cash still to collect) or an authorized one releases nothing.
 *
 * `respectHoldReason`: a hold that is not an `awaiting_payment` hold is not ended
 * by money. The close step is best effort (the tender is already saved): its
 * failure is alerted, never turned into an error for the caller.
 */
export async function settleOrderAfterExternalTender(saved: Payment): Promise<void> {
  if (saved.status === "captured") {
    await closeSiblingsOfSettledOrder(saved).catch((err) =>
      captureError(err, {
        scope: "close-siblings",
        paymentId: saved.id,
        orderId: saved.order_id,
      }),
    );
  }
  await maybeMarkOrderPaid(saved.order_id, { respectHoldReason: true });
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
/**
 * How long past its hold EXPIRY a `scheduled` order may still be released (a paid
 * order would otherwise fire old food at the kitchen) before staff are alerted.
 * Shared by `orders.release` and the held-order sweeper. Measured from expiry, not
 * from the fire time: catering's holds expire 6 h after fire_at, so the effective
 * cutoff there is fire_at + 12 h (catering's own release window is set to match).
 */
export const SCHEDULED_PAID_GRACE_MS = 6 * 60 * 60 * 1000;

/**
 * An expired `scheduled` hold needs a human: it is paid (but too stale to fire),
 * partly paid, or still owes an invoice. Puts it in the admin "Late payments"
 * list (`fulfillment.late_payment`, kind `scheduled`) and the error sink. Idempotent
 * per (order, detail); returns true when it newly flagged. The item resolves itself
 * from the list once the order leaves `draft` (refunded and voided).
 */
export async function flagStrandedScheduled(
  order: Order,
  payments: Payment[],
  detail: "paid" | "partial" | "invoice_pending",
): Promise<boolean> {
  const prior = order.fulfillment?.late_payment;
  // Any resolved marker (accepted, refunded, refund_owed_manual: money still owed
  // back by hand, released, canceled) is staff's decision: never overwritten, never
  // re-flagged. An unresolved one of another kind belongs to its own flow.
  if (prior && (prior.resolved || prior.kind !== "scheduled")) return false;
  if (prior && prior.detail === detail) return false;
  const settled = payments.filter((p) => p.status === "captured" || p.status === "authorized");
  const amount =
    detail === "invoice_pending"
      ? payments.filter((p) => p.status === "pending").reduce((n, p) => n + p.amount_cents, 0)
      : netSettledCents(payments);
  captureError(new Error(`scheduled hold expired: ${detail}`), {
    scope: "scheduled-hold-stranded",
    orderId: order.id,
    tenantId: order.tenant_id,
    detail,
    amountCents: amount,
  });
  if (!order.fulfillment) return false;
  await getPosDriver().mergeOrderFulfillment(order.id, {
    late_payment: {
      kind: "scheduled",
      detail,
      payment_id: (settled[0] ?? payments[0])?.id ?? "",
      amount_cents: amount,
      flagged_at: nowIso(),
    },
  });
  await recordAudit({
    actor: SYSTEM_ACTOR,
    action: "late_payment_flagged",
    tenantId: order.tenant_id,
    detail:
      detail === "paid"
        ? `Scheduled order ${order.id} is fully paid (${amount}c) but its hold expired unreleased; it was not fired. Refund it or recreate it.`
        : detail === "partial"
          ? `Scheduled order ${order.id} is only PARTLY paid (${amount}c settled) and its hold expired. Refund it or collect the balance and recreate it.`
          : `Scheduled order ${order.id} still owes an invoice (${amount}c) and its hold expired. Decide whether to cancel it.`,
  });
  return true;
}

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
  // Measured on BASE amounts for every order (never base + tip): the tip rides on
  // the tender, not the amount due, and may be added by the payer (an agent-channel
  // order paid by session with a tip the order did not carry). Comparing money
  // including tips to the order total would flag that tip as a duplicate payment,
  // and the admin refund of the "duplicate" would refund the tip. Only the BASE
  // part of refunds counts, so a tip-only refund can't hide a duplicate of the base.
  const held = payments
    .filter((p) => p.status === "captured" || p.status === "authorized")
    .reduce((n, p) => n + Math.max(0, p.amount_cents - baseRefundedCents(p)), 0);
  const baseExcess = held - orderDueCents(order);
  if (baseExcess <= 0) return;
  // The admin refund returns exactly the marker amount. A payer-added tip is never
  // a duplicate on its own (base test above), but when the base IS duplicated the
  // refund must also return the tip charged on the duplicate: online orders measure
  // the whole money held against the order total.
  const excess =
    order.channel === "in_store"
      ? baseExcess
      : Math.max(baseExcess, netSettledCents(payments) - order.totals.total_cents);
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
