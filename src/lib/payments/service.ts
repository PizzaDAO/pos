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
import type { PaymentRailKey } from "./PaymentRail";
import { requirePaymentRail } from "./registry";
import { mapIntentStatus, stripeGet, stripeRequest } from "./providers/stripe-client";
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

  const saved = await driver.upsertPayment(payment);
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
  opts: { raw?: Record<string, unknown> } = {},
): Promise<Payment | null> {
  const driver = getPosDriver();
  const payment = await driver.getPayment(paymentId);
  if (!payment) return null;

  let saved = payment;
  const locked =
    payment.status === "refunded" ||
    (payment.status === "captured" && status !== "refunded");
  if (!locked && (status !== payment.status || opts.raw)) {
    saved = await driver.upsertPayment({
      ...payment,
      status,
      raw: opts.raw ? { ...(payment.raw ?? {}), ...opts.raw } : payment.raw,
      updated_at: nowIso(),
    });
  }
  await maybeMarkOrderPaid(payment.order_id);
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
    // Nothing to ask the rail, but make sure the order caught up.
    await maybeMarkOrderPaid(payment.order_id);
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

  return applyRailStatus(payment.id, status);
}

/** True for a real (non-simulated) Stripe PaymentIntent tender. */
function isRealIntentTender(p: Payment): boolean {
  return (
    p.rail === "stripe_online" &&
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
}): Promise<(Payment & { replayed?: boolean; refundedNowCents?: number }) | null> {
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
  if (allRefunded) await driver.updateOrderStatus(payment.order_id, "refunded");

  return { ...updated, refundedNowCents: refundAmount };
}

/**
 * Mark the order `paid` once SETTLED (authorized/captured) tenders cover the
 * amount due. Only a `draft` or `placed` order moves to `paid`: a late
 * settlement (webhook, slow crypto) must never regress an order that has already
 * progressed (`in_kitchen`, `ready`, `completed`, ...). Never downgrades.
 */
async function maybeMarkOrderPaid(orderId: string): Promise<void> {
  const driver = getPosDriver();
  const order = await driver.getOrder(orderId);
  if (!order) return;

  const payments = await listOrderCurrencyPayments(order);
  if (settledCents(payments) < orderDueCents(order)) return;

  if (order.status === "draft" || order.status === "placed") {
    await driver.updateOrderStatus(orderId, "paid");
  } else if (order.status !== "paid") {
    console.info(
      `[payments] order ${orderId} settled while ${order.status}; status left unchanged`,
    );
  }
}
