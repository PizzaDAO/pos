/**
 * Card-present tender flow, SERVER-DRIVEN (plans/terminal-card-reader.md).
 *
 *   start   -> PaymentIntent (card_present, on the connected account) + the
 *              tender row (`requires_action`) -> process_payment_intent on the
 *              reader. The READER collects the card and confirms.
 *   sync    -> read the PaymentIntent (+ the reader) from Stripe and move the
 *              tender: succeeded -> `captured`, with the on-reader tip and the
 *              EMV receipt fields; a decline/cancel stays `requires_action` with
 *              `raw.last_error`. Polling and the webhooks both call this.
 *   retry   -> process_payment_intent again on the SAME PaymentIntent (Stripe: never
 *              recreate the PI after a decline).
 *   cancel  -> cancel_action on the reader, then cancel the PI.
 *
 * Money safety:
 *  - the order is promoted ONLY through `applyRailStatus` -> `maybeMarkOrderPaid`
 *    (shared compare-and-set); this module never writes order status;
 *  - `requires_action` tenders do not cover the balance (no false "paid");
 *  - sync trusts Stripe, not the caller: the PI id, metadata.payment_id, currency
 *    and amount must match the tender before anything settles;
 *  - the tender id is the PI idempotency key; `process_payment_intent` gets a
 *    per-attempt key `<paymentId>:process:<n>`, with `n` persisted BEFORE the call.
 *
 * Simulated mode (see `cardReaderMode`) never calls Stripe: a tender waits for the
 * simulated reader (`simulateCardTender`: approve / decline) or, if
 * TERMINAL_SIM_AUTO_APPROVE_MS is set, approves itself.
 */
import { getPosDriver } from "@/lib/db";
import type { Payment } from "@/lib/db";
import { LiveTenderConflictError } from "@/lib/db/payment-types";
import type { TerminalTipMode } from "@/lib/db/payment-types";
import { captureError } from "@/lib/observability";
import { resolveCardConnectAccountId } from "../connect";
import { cardReaderMode, terminalSimAutoApproveMs } from "../env";
import { mapIntentStatus, StripeError } from "../providers/stripe-client";
import {
  cancelReaderAction,
  presentPaymentMethod,
  processPaymentIntent,
  retrievePaymentIntent,
  retrieveReader,
  type StripeCardPresent,
  type StripeTerminalPaymentIntent,
} from "../providers/stripe-terminal-api";
import {
  applyRailStatus,
  cancelOpenTender,
  getOrderBalance,
  takePaymentDetailed,
} from "../service";
import { DEFAULT_TIP_MODE } from "./locations";
import {
  isSimulatedReaderId,
  readerActionView,
  resolveReaderForCharge,
  type ReaderActionView,
} from "./readers";

export type TerminalErrorCode =
  | "order_not_found"
  | "order_not_payable"
  | "amount_invalid"
  | "amount_exceeds_balance"
  | "payment_not_found"
  | "wrong_rail"
  | "reader_offline"
  | "reader_busy"
  | "reader_timeout"
  | "not_simulated"
  | "mismatch"
  | "provider_error";

/** A flow failure with the HTTP status a route should return. */
export class TerminalFlowError extends Error {
  constructor(
    readonly code: TerminalErrorCode,
    message: string,
    readonly status: number,
    /** The tender (if one exists), so the UI can keep showing it. */
    readonly payment?: Payment,
  ) {
    super(message);
    this.name = "TerminalFlowError";
  }
}

/** What the cashier sees when a card did not go through (display only). */
export interface CardLastError {
  code: string | null;
  declineCode: string | null;
  message: string;
}

export interface CardSyncResult {
  payment: Payment;
  readerAction: ReaderActionView | null;
}

/** Simulated receipt (matches the e2e fixture "Visa •••• 4242"). */
const SIM_RECEIPT = {
  brand: "visa",
  last4: "4242",
  read_method: "contactless_emv",
  application_preferred_name: "Visa Credit",
  dedicated_file_name: "A0000000031010",
  account_type: "credit",
  authorization_response_code: "00",
  authorization_code: "SIM123",
} as const;

const SIM_DECLINE: CardLastError = {
  code: "card_declined",
  declineCode: "generic_decline",
  message: "Your card was declined.",
};

const UNPAYABLE_STATUSES = ["abandoned", "voided", "refunded", "awaiting_payment"];

function nowIso(): string {
  return new Date().toISOString();
}

function isOpen(p: Payment): boolean {
  return p.status === "requires_action" || p.status === "pending";
}

function isSimTender(p: Payment): boolean {
  return p.simulated || (p.charge_id ?? "").startsWith("sim_");
}

function readRaw<T = unknown>(p: Payment, key: string): T | undefined {
  return p.raw?.[key] as T | undefined;
}

async function loadTerminalTender(paymentId: string): Promise<Payment> {
  const payment = await getPosDriver().getPayment(paymentId);
  if (!payment) {
    throw new TerminalFlowError("payment_not_found", "Payment not found.", 404);
  }
  if (payment.rail !== "stripe_terminal") {
    throw new TerminalFlowError("wrong_rail", "Not a card-reader payment.", 400, payment);
  }
  return payment;
}

async function reload(p: Payment): Promise<Payment> {
  return (await getPosDriver().getPayment(p.id)) ?? p;
}

function lastErrorFromIntent(
  pi: StripeTerminalPaymentIntent,
  fallback?: { code?: string | null; message?: string | null },
): CardLastError | null {
  const e = pi.last_payment_error;
  if (e) {
    return {
      code: e.code ?? null,
      declineCode: e.decline_code ?? null,
      message: e.message ?? "The card was not accepted.",
    };
  }
  if (fallback?.code || fallback?.message) {
    return {
      code: fallback.code ?? null,
      declineCode: null,
      message: fallback.message ?? "The payment was not completed.",
    };
  }
  return null;
}

function receiptFromCharge(pi: StripeTerminalPaymentIntent): Record<string, unknown> | null {
  const charge = pi.latest_charge;
  if (!charge || typeof charge === "string") return null;
  const cp: StripeCardPresent | null | undefined =
    charge.payment_method_details?.card_present;
  if (!cp) return null;
  // Truncated card data only (never a PAN): brand, last4 and the EMV fields the
  // card networks require on a printed receipt.
  return {
    brand: cp.brand ?? null,
    last4: cp.last4 ?? null,
    read_method: cp.read_method ?? null,
    application_preferred_name: cp.receipt?.application_preferred_name ?? null,
    dedicated_file_name: cp.receipt?.dedicated_file_name ?? null,
    account_type: cp.receipt?.account_type ?? null,
    authorization_response_code: cp.receipt?.authorization_response_code ?? null,
    authorization_code: null,
  };
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

export interface StartCardTenderInput {
  /** Client UUID: the tender id and the PaymentIntent idempotency key. */
  paymentId: string;
  orderId: string;
  readerId: string;
  /** Base amount to put on the card (the cashier may split), in cents. */
  amountCents: number;
  /** Tip from our POS tip UI; honored only when the location's tip mode is `pos`. */
  tipCents?: number;
}

/**
 * Start (or resume) a card tender for an in-store order. `tenantId`, `locationId`
 * and the currency come from the ORDER, never the caller. Idempotent on
 * `paymentId`; one live card tender per order (a second start returns the live
 * one). Returns the tender; the reader is already prompting when this resolves.
 */
export async function startCardTender(
  input: StartCardTenderInput,
): Promise<{ payment: Payment; resumed: boolean }> {
  const driver = getPosDriver();

  const existing = await driver.getPayment(input.paymentId);
  if (existing) {
    if (existing.order_id !== input.orderId || existing.rail !== "stripe_terminal") {
      throw new TerminalFlowError("order_not_payable", "paymentId already used for another order.", 409);
    }
    return { payment: existing, resumed: true };
  }

  const order = await driver.getOrder(input.orderId);
  if (!order) throw new TerminalFlowError("order_not_found", "Order not found.", 404);
  if (order.channel !== "in_store") {
    throw new TerminalFlowError("order_not_payable", "Card readers are for in-store orders only.", 409);
  }
  if (UNPAYABLE_STATUSES.includes(order.status)) {
    throw new TerminalFlowError("order_not_payable", "This order can no longer be paid.", 409);
  }

  const liveFor = async () =>
    (await driver.listPaymentsForOrder(order.id)).find(
      (p) => p.rail === "stripe_terminal" && isOpen(p),
    );
  const live = await liveFor();
  if (live) return { payment: live, resumed: true };

  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    throw new TerminalFlowError("amount_invalid", "Enter an amount greater than zero.", 422);
  }
  const balance = await getOrderBalance(order);
  if (input.amountCents > balance) {
    throw new TerminalFlowError(
      "amount_exceeds_balance",
      "That is more than the balance due on this order.",
      422,
    );
  }

  // The card gate: real mode needs a charges-enabled connected account (throws
  // CardPaymentsNotReadyError, a 409 for the route).
  const accountId = await resolveCardConnectAccountId(order.tenant_id);
  const reader = await resolveReaderForCharge(
    order.tenant_id,
    order.location_id,
    input.readerId,
    accountId,
  );

  const tipMode: TerminalTipMode =
    (await driver.getTerminalLocation(order.location_id))?.tip_mode ?? DEFAULT_TIP_MODE;
  const tipCents =
    tipMode === "pos" && Number.isInteger(input.tipCents) && (input.tipCents ?? 0) > 0
      ? (input.tipCents as number)
      : 0;
  const locationName =
    (await driver.listLocations(order.tenant_id)).find((l) => l.id === order.location_id)
      ?.name ?? "";

  let payment: Payment;
  try {
    ({ payment } = await takePaymentDetailed({
      paymentId: input.paymentId,
      orderId: order.id,
      tenantId: order.tenant_id,
      locationId: order.location_id,
      rail: "stripe_terminal",
      amountCents: input.amountCents,
      tipCents,
      currency: order.currency,
      connectAccountId: accountId,
      metadata: {
        reader_id: reader.id,
        tip_mode: tipMode,
        description: `Order #${order.order_number}${locationName ? ` - ${locationName}` : ""}`,
      },
    }));
  } catch (err) {
    // Lost the one-live-tender race (two tablets / a double tap): hand back the winner.
    if (err instanceof LiveTenderConflictError) {
      const winner = await liveFor();
      if (winner) return { payment: winner, resumed: true };
    }
    throw err;
  }

  await beginReaderAttempt(payment, reader, tipMode);
  return { payment: await reload(payment), resumed: false };
}

/**
 * Persist attempt `n` (BEFORE the Stripe call, so the per-attempt idempotency key
 * is never reused for a different request), then hand the PaymentIntent to the
 * reader. Simulated tenders just record the attempt and wait for the simulated
 * reader buttons.
 */
async function beginReaderAttempt(
  payment: Payment,
  reader: { id: string; simulated: boolean },
  tipMode: TerminalTipMode,
): Promise<void> {
  const attempt = (readRaw<number>(payment, "process_attempts") ?? 0) + 1;
  await applyRailStatus(payment.id, "requires_action", {
    raw: {
      process_attempts: attempt,
      reader_id: reader.id,
      reader_action_status: "in_progress",
      last_error: null,
      process_started_at: nowIso(),
      sim_outcome: null,
    },
  });
  if (isSimTender(payment) || reader.simulated) return;

  const accountId = payment.connect_account_id!;
  const config = {
    enableCustomerCancellation: true,
    // POS tip / no tip: keep the reader's tip screen out of it.
    skipTipping: tipMode !== "reader",
  };
  const key = `${payment.id}:process:${attempt}`;
  const call = () =>
    processPaymentIntent(accountId, reader.id, payment.charge_id!, config, key);
  try {
    try {
      await call();
    } catch (err) {
      // A timeout can be a false negative: Stripe dedupes the same key.
      if (err instanceof StripeError && err.code === "terminal_reader_timeout") {
        await call();
      } else {
        throw err;
      }
    }
  } catch (err) {
    throw await explainReaderError(payment, err);
  }
}

/** Map a Stripe reader error to a flow error, recording it on the tender. */
async function explainReaderError(payment: Payment, err: unknown): Promise<unknown> {
  if (!(err instanceof StripeError)) return err;
  const record = async (message: string, markFailed: boolean) => {
    await applyRailStatus(payment.id, "requires_action", {
      raw: {
        ...(markFailed ? { reader_action_status: "failed" } : {}),
        last_error: { code: err.code, declineCode: null, message } satisfies CardLastError,
      },
    }).catch(() => null);
    return (await getPosDriver().getPayment(payment.id)) ?? payment;
  };
  switch (err.code) {
    case "terminal_reader_offline": {
      const msg = "The card reader is offline. Check its power and WiFi, pick another reader, or take cash.";
      return new TerminalFlowError("reader_offline", msg, 409, await record(msg, true));
    }
    case "terminal_reader_busy": {
      const msg = "The card reader is busy with another payment.";
      return new TerminalFlowError("reader_busy", msg, 409, await record(msg, false));
    }
    case "terminal_reader_timeout": {
      const msg = "The card reader didn't respond in time. Try again.";
      return new TerminalFlowError("reader_timeout", msg, 504, await record(msg, true));
    }
    case "intent_invalid_state": {
      // Already succeeded / canceled: the sync below is the truth.
      const synced = await syncCardTender(payment.id).catch(() => null);
      return new TerminalFlowError(
        "provider_error",
        "This payment already changed state.",
        409,
        synced?.payment ?? payment,
      );
    }
    default: {
      const msg = err.message || "The card reader could not be reached.";
      return new TerminalFlowError("provider_error", msg, 502, await record(msg, true));
    }
  }
}

// ---------------------------------------------------------------------------
// Sync (polling + webhooks)
// ---------------------------------------------------------------------------

/**
 * Bring a card tender up to date with Stripe (or the simulated reader) and
 * persist it. Safe to call concurrently and repeatedly (poll x2 + webhook): every
 * write goes through `applyRailStatus`, which never downgrades `captured` and
 * promotes the order exactly once.
 */
export async function syncCardTender(paymentId: string): Promise<CardSyncResult> {
  const payment = await loadTerminalTender(paymentId);

  if (payment.status === "captured" || payment.status === "refunded") {
    // Settled: just make sure the order caught up.
    await applyRailStatus(payment.id, payment.status);
    return { payment: await reload(payment), readerAction: null };
  }
  if (payment.status === "canceled" || payment.status === "failed") {
    return { payment, readerAction: null };
  }
  return isSimTender(payment) ? syncSimulated(payment) : syncReal(payment);
}

async function syncSimulated(payment: Payment): Promise<CardSyncResult> {
  let outcome = readRaw<string | null>(payment, "sim_outcome") ?? null;
  const autoMs = terminalSimAutoApproveMs();
  if (!outcome && autoMs > 0) {
    const started = Date.parse(readRaw<string>(payment, "process_started_at") ?? "");
    if (Number.isFinite(started) && Date.now() - started >= autoMs) outcome = "approve";
  }

  if (outcome === "approve") {
    const tip = readRaw<number>(payment, "sim_tip_cents") ?? payment.tip_cents;
    await applyRailStatus(payment.id, "captured", {
      tipCents: tip,
      raw: {
        card_receipt: { ...SIM_RECEIPT },
        stripeStatus: "succeeded",
        reader_action_status: "succeeded",
        last_error: null,
        sim_outcome: null,
      },
    });
  } else if (outcome === "decline") {
    await applyRailStatus(payment.id, "requires_action", {
      raw: {
        last_error: SIM_DECLINE,
        reader_action_status: "failed",
        sim_outcome: null,
      },
    });
  }
  const fresh = await reload(payment);
  return {
    payment: fresh,
    readerAction: {
      status: (readRaw<string>(fresh, "reader_action_status") as ReaderActionView["status"]) ?? null,
      failureCode: null,
      failureMessage: null,
      paymentIntentId: fresh.charge_id,
    },
  };
}

async function syncReal(payment: Payment): Promise<CardSyncResult> {
  const accountId = payment.connect_account_id;
  if (!accountId || !payment.charge_id) {
    throw new TerminalFlowError("mismatch", "This payment has no card reader intent.", 409, payment);
  }
  const pi = await retrievePaymentIntent(accountId, payment.charge_id);

  // Trust Stripe, but only for THIS tender: id, correlation id, currency, amount.
  const tipMode = readRaw<string>(payment, "tip_mode");
  const readerTip = pi.amount_details?.tip?.amount ?? null;
  const impliedTip = pi.amount - payment.amount_cents;
  const finalTip = tipMode === "reader" ? impliedTip : payment.tip_cents;
  const amountOk =
    tipMode === "reader"
      ? impliedTip >= 0 && (readerTip === null || readerTip === impliedTip)
      : pi.amount === payment.amount_cents + payment.tip_cents;
  if (
    pi.id !== payment.charge_id ||
    (pi.metadata?.payment_id && pi.metadata.payment_id !== payment.id) ||
    pi.currency.toLowerCase() !== payment.currency.toLowerCase() ||
    !amountOk
  ) {
    captureError(new Error("terminal PaymentIntent does not match its tender"), {
      scope: "terminal-sync",
      paymentId: payment.id,
      piAmount: pi.amount,
      expectedAmount: payment.amount_cents + payment.tip_cents,
    });
    throw new TerminalFlowError(
      "mismatch",
      "The card payment doesn't match this order. Nothing was recorded.",
      409,
      payment,
    );
  }

  if (pi.status === "succeeded") {
    await applyRailStatus(payment.id, "captured", {
      tipCents: finalTip,
      raw: {
        card_receipt: receiptFromCharge(pi),
        stripeStatus: pi.status,
        reader_action_status: "succeeded",
        last_error: null,
      },
    });
    return { payment: await reload(payment), readerAction: null };
  }

  const mapped = mapIntentStatus(pi.status);
  if (mapped !== "requires_action") {
    await applyRailStatus(payment.id, mapped, { raw: { stripeStatus: pi.status } });
    return { payment: await reload(payment), readerAction: null };
  }

  // Still unpaid: ask the reader what happened (decline, customer cancel, busy).
  let readerAction: ReaderActionView | null = null;
  const readerId = readRaw<string>(payment, "reader_id");
  if (readerId && !isSimulatedReaderId(readerId)) {
    try {
      const reader = await retrieveReader(accountId, readerId);
      const view = readerActionView(reader.action);
      if (view && view.paymentIntentId === pi.id) readerAction = view;
    } catch {
      // Reader unreachable: the PaymentIntent alone still tells us it is unpaid.
    }
  }
  const failed = readerAction?.status === "failed" || !!pi.last_payment_error;
  const lastError = failed
    ? lastErrorFromIntent(pi, {
        code: readerAction?.failureCode,
        message: readerAction?.failureMessage,
      })
    : null;
  const nextRaw = {
    stripeStatus: pi.status,
    reader_action_status: readerAction?.status ?? readRaw<string>(payment, "reader_action_status") ?? null,
    last_error: lastError ?? (failed ? readRaw(payment, "last_error") ?? null : null),
  };
  // Write only on change: every upsert bumps updated_at, which the reconcile
  // sweep uses to find abandoned tenders.
  const changed = (["stripeStatus", "reader_action_status", "last_error"] as const).some(
    (k) => JSON.stringify(nextRaw[k]) !== JSON.stringify(payment.raw?.[k] ?? null),
  );
  if (changed || payment.status !== "requires_action") {
    await applyRailStatus(payment.id, "requires_action", { raw: nextRaw });
  }
  return { payment: await reload(payment), readerAction };
}

// ---------------------------------------------------------------------------
// Retry / cancel / reset
// ---------------------------------------------------------------------------

/**
 * Try the card again after a decline / customer cancel / offline reader: runs
 * `process_payment_intent` on the SAME PaymentIntent (optionally on another
 * reader). Syncs first, so a card that actually went through is never charged
 * twice.
 */
export async function retryCardTender(
  paymentId: string,
  readerId?: string,
): Promise<CardSyncResult> {
  const synced = await syncCardTender(paymentId);
  const payment = synced.payment;
  if (payment.status !== "requires_action") return synced;

  const previousReader = readRaw<string>(payment, "reader_id") ?? null;
  const targetId = readerId ?? previousReader;
  if (!targetId) {
    throw new TerminalFlowError("provider_error", "Pick a card reader.", 422, payment);
  }
  const accountId = payment.connect_account_id;
  const reader = await resolveReaderForCharge(
    payment.tenant_id,
    payment.location_id,
    targetId,
    accountId,
  );
  // Switching readers: clear the old one's screen (best effort).
  if (previousReader && previousReader !== reader.id && accountId && !isSimulatedReaderId(previousReader)) {
    await cancelReaderAction(accountId, previousReader).catch(() => undefined);
  }
  const tipMode = (readRaw<TerminalTipMode>(payment, "tip_mode") ?? DEFAULT_TIP_MODE) as TerminalTipMode;
  await beginReaderAttempt(payment, reader, tipMode);
  return { payment: await reload(payment), readerAction: null };
}

export type CancelOutcome = "canceled" | "settled" | "in_flight";

/**
 * Cancel an open card tender: cancel_action on the reader, then cancel the
 * PaymentIntent. `in_flight` = the customer is mid-authorization ("wait");
 * `settled` = the card actually went through (the tender is captured; refund it
 * if the cashier really meant to cancel).
 */
export async function cancelCardTender(
  paymentId: string,
): Promise<{ outcome: CancelOutcome; payment: Payment }> {
  const payment = await loadTerminalTender(paymentId);
  if (payment.status === "captured" || payment.status === "refunded") {
    return { outcome: "settled", payment };
  }
  if (payment.status === "canceled" || payment.status === "failed") {
    return { outcome: "canceled", payment };
  }

  const readerId = readRaw<string>(payment, "reader_id");
  if (!isSimTender(payment) && readerId && payment.connect_account_id) {
    try {
      await cancelReaderAction(payment.connect_account_id, readerId);
    } catch (err) {
      if (err instanceof StripeError && err.code === "terminal_reader_busy") {
        return { outcome: "in_flight", payment };
      }
      // Offline / nothing to cancel: the PaymentIntent cancel below still makes
      // any later tap fail.
    }
  }
  const outcome = await cancelOpenTender(payment);
  return { outcome, payment: await reload(payment) };
}

/** Cancel whatever the reader is doing (stuck `in_progress` after a dropped payment). */
export async function resetReader(input: {
  tenantId: string;
  locationId: string;
  readerId: string;
}): Promise<void> {
  const accountId =
    cardReaderMode() === "simulated"
      ? null
      : await resolveCardConnectAccountId(input.tenantId);
  const reader = await resolveReaderForCharge(
    input.tenantId,
    input.locationId,
    input.readerId,
    accountId,
  );
  if (reader.simulated || !accountId) return;
  try {
    await cancelReaderAction(accountId, reader.id);
  } catch (err) {
    if (err instanceof StripeError && err.code === "terminal_reader_busy") {
      throw new TerminalFlowError("reader_busy", "The customer is mid-payment. Wait a moment.", 409);
    }
    if (err instanceof StripeError && err.code === "terminal_reader_offline") {
      throw new TerminalFlowError("reader_offline", "The card reader is offline.", 409);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Simulate (sandbox / demo only)
// ---------------------------------------------------------------------------

export interface SimulateInput {
  outcome: "approve" | "decline";
  /** Simulated on-reader tip, in cents (approve only). */
  tipCents?: number;
}

/**
 * Drive the SIMULATED reader. Simulated mode: records the outcome and syncs.
 * Stripe test mode: calls the `present_payment_method` test helper (a decline
 * uses `4000000000000002`, a tip uses `amount_tip`), then syncs. Live mode: not
 * available (the route returns 404).
 */
export async function simulateCardTender(
  paymentId: string,
  input: SimulateInput,
): Promise<CardSyncResult> {
  const mode = cardReaderMode();
  if (mode === "stripe_live") {
    throw new TerminalFlowError("not_simulated", "Not available.", 404);
  }
  const payment = await loadTerminalTender(paymentId);
  if (!isOpen(payment)) return syncCardTender(paymentId);
  const tip =
    input.outcome === "approve" && Number.isInteger(input.tipCents) && (input.tipCents ?? 0) > 0
      ? (input.tipCents as number)
      : 0;

  if (isSimTender(payment)) {
    await applyRailStatus(payment.id, "requires_action", {
      raw: { sim_outcome: input.outcome, sim_tip_cents: tip },
    });
  } else {
    const readerId = readRaw<string>(payment, "reader_id");
    if (!readerId || !payment.connect_account_id) {
      throw new TerminalFlowError("not_simulated", "No reader on this payment.", 409, payment);
    }
    await presentPaymentMethod(payment.connect_account_id, readerId, {
      cardNumber: input.outcome === "decline" ? "4000000000000002" : undefined,
      amountTip: tip,
    });
  }
  return syncCardTender(paymentId);
}

// ---------------------------------------------------------------------------
// Reconcile (cron / end of day)
// ---------------------------------------------------------------------------

export interface ReconcileSummary {
  checked: number;
  settled: number;
  canceled: number;
  errors: number;
}

/**
 * Sweep card tenders left open (tablet died, cashier walked away): re-read each
 * from Stripe; if it succeeded it is captured, otherwise it is canceled so the
 * reader can never complete a stale payment.
 */
export async function reconcileTerminalTenders(
  opts: { olderThanMs?: number; limit?: number } = {},
): Promise<ReconcileSummary> {
  const cutoff = new Date(Date.now() - (opts.olderThanMs ?? 15 * 60_000)).toISOString();
  const stale = await getPosDriver().listStaleTerminalTenders(cutoff, opts.limit ?? 50);
  const summary: ReconcileSummary = { checked: 0, settled: 0, canceled: 0, errors: 0 };
  for (const t of stale) {
    summary.checked += 1;
    try {
      const { payment } = await syncCardTender(t.id);
      if (payment.status === "captured") {
        summary.settled += 1;
      } else if (isOpen(payment)) {
        const { outcome } = await cancelCardTender(payment.id);
        if (outcome === "canceled") summary.canceled += 1;
        if (outcome === "settled") summary.settled += 1;
      }
    } catch (err) {
      summary.errors += 1;
      captureError(err, { scope: "terminal-reconcile", paymentId: t.id });
    }
  }
  return summary;
}
