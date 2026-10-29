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
 * ATOMIC BALANCE: before any rail is called, the tender is RESERVED (inserted
 * as `pending`) through `driver.reserveTender`, which checks the remaining
 * balance and inserts in one atomic step (Postgres: row lock on the order).
 * Two concurrent requests can therefore never both take the last of the
 * balance. If the rail then fails, the reservation is marked `failed` (failed
 * tenders don't count toward the balance).
 *
 * SPLIT PAYMENT: an order may have several tenders across rails. The order is
 * marked `paid` once the sum of captured (or pending-crypto) base amounts covers
 * the order total. `getOrderBalance` returns the remaining balance the UI drives
 * to zero.
 */
import "./rails";
import { getPosDriver } from "@/lib/db";
import type { Order, Payment, PaymentStatus } from "@/lib/db";
import type { PaymentRailKey } from "./PaymentRail";
import { requirePaymentRail } from "./registry";
import { railChargesApplicationFee } from "./fees";
import { countsTowardBalance, isStaleUnsettled } from "./balance";
import { StripeError } from "./providers/stripe-client";
import {
  isCoinbaseConfigured,
  isOnchainConfigured,
  isStripeConfigured,
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
      return !isStripeConfigured();
    case "crypto_onchain_usdc":
      return !isOnchainConfigured();
    case "crypto_coinbase":
      return !isCoinbaseConfigured();
    default:
      return true;
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
 * Sum of base amounts covered by non-failed tenders, INCLUDING pending crypto.
 * Drives the UI balance so the cashier isn't asked to collect twice while a
 * crypto tender confirms. (Order is only marked `paid` once tenders SETTLE — see
 * `settledCents`.)
 */
function coveredCents(payments: Payment[]): number {
  return payments
    .filter((p) => countsTowardBalance(p))
    .reduce((sum, p) => sum + p.amount_cents, 0);
}

/** Sum of base amounts covered by SETTLED tenders (captured/authorized). */
function settledCents(payments: Payment[]): number {
  return payments
    .filter((p) => p.status === "captured" || p.status === "authorized")
    .reduce((sum, p) => sum + p.amount_cents, 0);
}

/** The tender doesn't fit in the order's remaining balance (→ HTTP 409). */
export class BalanceExceededError extends Error {
  constructor(
    message: string,
    readonly balanceCents: number,
  ) {
    super(message);
    this.name = "BalanceExceededError";
  }
}

/**
 * The rail call's outcome is UNKNOWN (timeout, network error, 5xx, rate limit):
 * the money may or may not have moved. The record is left `pending` and the
 * client must retry with the SAME id (the rail dedupes on it) → HTTP 503.
 */
export class PaymentOutcomeUnknownError extends Error {
  constructor(
    message: string,
    readonly id: string,
  ) {
    super(message);
    this.name = "PaymentOutcomeUnknownError";
  }
}

/**
 * Did the rail DEFINITIVELY refuse (no money moved)? Only then may a tender /
 * refund be finalized as failed. Stripe 4xx (decline / invalid request / auth)
 * are definitive, except idempotency conflicts (409, idempotency_error) and
 * rate limits (429); "not configured" errors never reached Stripe. Anything
 * else — network errors, timeouts, 5xx, unknown errors — is ambiguous.
 */
export function isDefinitiveRailFailure(err: unknown): boolean {
  if (err instanceof StripeError) {
    if (err.raw === null) return true; // never sent (not configured)
    const type = (err.raw as { error?: { type?: string } } | null)?.error?.type;
    if (type === "idempotency_error") return false;
    return (
      err.status >= 400 &&
      err.status < 500 &&
      err.status !== 409 &&
      err.status !== 429
    );
  }
  return false;
}

/** A refund doesn't fit / conflicts (→ HTTP 409/422). */
export class RefundRejectedError extends Error {
  constructor(
    message: string,
    readonly status: 409 | 422,
  ) {
    super(message);
    this.name = "RefundRejectedError";
  }
}

/** Remaining unpaid balance on an order, in cents (never negative). */
export async function getOrderBalance(order: Order): Promise<number> {
  const driver = getPosDriver();
  const payments = await driver.listPaymentsForOrder(order.id);
  const balance = order.totals.total_cents - coveredCents(payments);
  return Math.max(0, balance);
}

/**
 * Take one tender against an order. Idempotent on `paymentId`. Computes the
 * platform application fee for card rails, calls the rail, persists the tender,
 * and marks the order `paid` once the balance reaches zero.
 */
export async function takePayment(input: TakePaymentInput): Promise<Payment> {
  const driver = getPosDriver();

  const rail = requirePaymentRail(input.rail);

  // Idempotency guard: a tender with this id already exists.
  const existing = await driver.getPayment(input.paymentId);
  let reserved: Payment;
  if (existing) {
    if (existing.order_id !== input.orderId) {
      throw new BalanceExceededError("Payment id already used.", 0);
    }
    // A reservation whose rail outcome was never recorded (an earlier attempt
    // timed out / errored ambiguously): RESUME it with the SAME idempotency key
    // and the ORIGINAL amounts — the rail returns the original charge if it
    // happened, so this can't double-charge. Anything else is final → replay.
    const unfinished =
      existing.status === "pending" && !existing.charge_id && !existing.raw;
    if (!unfinished) return existing;
    if (isStaleUnsettled(existing)) {
      // It no longer holds the balance; don't charge against it blindly.
      throw new BalanceExceededError(
        "This payment attempt expired. Void it and start a new payment.",
        0,
      );
    }
    reserved = existing;
  } else {
    // ATOMIC reservation against the remaining balance BEFORE charging.
    const reservedAt = nowIso();
    const reservation = await driver.reserveTender({
      id: input.paymentId,
      order_id: input.orderId,
      tenant_id: input.tenantId,
      location_id: input.locationId,
      rail: input.rail,
      status: "pending",
      amount_cents: input.amountCents,
      tip_cents: input.tipCents,
      application_fee_cents: 0,
      currency: input.currency,
      charge_id: null,
      connect_account_id: input.connectAccountId ?? null,
      crypto_tx_hash: null,
      crypto_chain: null,
      cash_tendered_cents: null,
      cash_change_cents: null,
      refunded_cents: 0,
      simulated: railIsSimulated(input.rail),
      raw: null,
      created_at: reservedAt,
      updated_at: reservedAt,
    });
    if (!reservation.ok) {
      throw new BalanceExceededError(
        reservation.reason === "exceeds_balance"
          ? `Amount exceeds the remaining balance (${reservation.balanceCents}).`
          : "This order can no longer be paid.",
        reservation.balanceCents,
      );
    }
    // A concurrent request with the same id won the race → idempotent replay.
    if (!reservation.created) return reservation.payment;
    reserved = reservation.payment;
  }
  if (reserved.rail !== input.rail) {
    throw new BalanceExceededError("Payment id already used.", 0);
  }
  // Always charge the RESERVED amounts (a resume must match the original).
  input = {
    ...input,
    amountCents: reserved.amount_cents,
    tipCents: reserved.tip_cents,
    currency: reserved.currency,
  };
  const amount = { amount: input.amountCents, currency: input.currency };
  const tip =
    input.tipCents > 0
      ? { amount: input.tipCents, currency: input.currency }
      : undefined;

  // Pass the cash-tendered amount to the cash rail (for change calculation).
  const metadata: Record<string, string> = { ...input.metadata };
  if (input.rail === "cash" && input.cashTenderedCents !== undefined) {
    metadata.cashTenderedCents = String(input.cashTenderedCents);
  }

  let result: Awaited<ReturnType<typeof rail.createCharge>>;
  try {
    result = await rail.createCharge({
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
  } catch (err) {
    if (isDefinitiveRailFailure(err)) {
      // Definitive decline: no money moved — release the reservation.
      await driver
        .updatePaymentStatusFromProvider(reserved.id, "failed")
        .catch(() => null);
      throw err;
    }
    // Ambiguous: leave it pending; the client retries with the SAME id.
    throw new PaymentOutcomeUnknownError(
      "The payment provider did not confirm the charge. Retry the same payment.",
      reserved.id,
    );
  }

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
    created_at: reserved.created_at,
    updated_at: nowIso(),
  };

  const saved = await driver.upsertPayment(payment);
  await maybeMarkOrderPaid(input.orderId);
  return saved;
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
    return payment;
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

  if (status === payment.status) return payment;
  // Targeted status-only update (never resurrects a refunded tender).
  const updated = await driver.updatePaymentStatusFromProvider(
    payment.id,
    status,
  );
  await maybeMarkOrderPaid(payment.order_id);
  return updated;
}

/**
 * Refund a captured tender (full or partial). `refundId` is the client's
 * idempotency key for THIS refund request: retries with the same id never
 * refund twice (ledger + rail key `refund_<paymentId>_<refundId>`), while
 * distinct partial refunds each reach the rail. The refundable amount is
 * reserved atomically (Postgres: row lock on the payment) before the rail call.
 */
export async function refundPayment(input: {
  paymentId: string;
  refundId: string;
  amountCents?: number;
  reason?: string;
}): Promise<Payment | null> {
  const driver = getPosDriver();
  const payment = await driver.getPayment(input.paymentId);
  if (!payment) return null;

  // Idempotent replay of a refund that already settled.
  const prior = await driver.getRefund(input.refundId);
  if (prior) {
    if (prior.payment_id !== payment.id) {
      throw new RefundRejectedError(
        "Refund id already used for another payment.",
        409,
      );
    }
    if (prior.status === "succeeded") return payment;
    if (prior.status === "failed") {
      throw new RefundRejectedError(
        "This refund failed; retry with a new refund id.",
        409,
      );
    }
  }

  const refundAmount =
    input.amountCents ??
    payment.amount_cents + payment.tip_cents - payment.refunded_cents;

  const reservation = await driver.reserveRefund({
    id: input.refundId,
    paymentId: payment.id,
    amountCents: refundAmount,
    reason: input.reason ?? null,
  });
  if (!reservation.ok) {
    throw new RefundRejectedError(
      reservation.reason === "exceeds_refundable"
        ? `Refund exceeds the refundable amount (${reservation.refundableCents}).`
        : reservation.reason === "refund_mismatch"
          ? "Refund id already used for another payment."
          : reservation.reason === "not_settled"
            ? "Only a settled (captured) payment can be refunded."
            : "Payment not found.",
      reservation.reason === "exceeds_refundable" ? 422 : 409,
    );
  }
  const refund = reservation.refund;

  const rail = requirePaymentRail(payment.rail);
  try {
    await rail.refund({
      context: {
        tenantId: payment.tenant_id,
        locationId: payment.location_id,
        connectAccountId: payment.connect_account_id,
        // Unique per refund REQUEST; stable across retries of that request.
        idempotencyKey: refundIdempotencyKey(payment.id, refund.id),
      },
      chargeId: payment.charge_id ?? payment.id,
      amount: { amount: refund.amount_cents, currency: payment.currency },
      reason: input.reason,
    });
  } catch (err) {
    if (isDefinitiveRailFailure(err)) {
      await driver.finalizeRefund(refund.id, "failed").catch(() => null);
      throw err;
    }
    // Ambiguous: keep the refund pending (its amount stays reserved); the
    // client retries with the SAME refundId and the rail dedupes on it.
    throw new PaymentOutcomeUnknownError(
      "The payment provider did not confirm the refund. Retry the same refund.",
      refund.id,
    );
  }

  const updated = await driver.finalizeRefund(refund.id, "succeeded");

  // If all tenders on the order are fully refunded, mark the order refunded.
  const all = await driver.listPaymentsForOrder(payment.order_id);
  const allRefunded =
    all.length > 0 && all.every((p) => p.status === "refunded");
  if (allRefunded) await driver.updateOrderStatus(payment.order_id, "refunded");

  return updated;
}

/** Rail idempotency key for one refund request of one payment. */
export function refundIdempotencyKey(paymentId: string, refundId: string): string {
  return `refund_${paymentId}_${refundId}`;
}

/**
 * Mark the order `paid` once captured/pending tenders cover the total. Pending
 * crypto tenders count toward coverage so the cashier isn't blocked; the
 * watcher/webhook later flips them to captured. Never downgrades a paid order.
 */
async function maybeMarkOrderPaid(orderId: string): Promise<void> {
  const driver = getPosDriver();
  const order = await driver.getOrder(orderId);
  if (!order) return;
  if (order.status === "refunded" || order.status === "voided") return;

  const payments = await driver.listPaymentsForOrder(orderId);
  const settled = settledCents(payments);
  if (settled >= order.totals.total_cents && order.status !== "paid") {
    await driver.updateOrderStatus(orderId, "paid");
  }
}
