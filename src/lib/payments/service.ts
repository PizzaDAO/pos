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
import type { PaymentRailKey } from "./PaymentRail";
import { requirePaymentRail } from "./registry";
import { railChargesApplicationFee } from "./fees";
import { CardPaymentsNotReadyError } from "./connect";
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

/** Remaining unpaid balance on an order, in cents (never negative). */
export async function getOrderBalance(order: Order): Promise<number> {
  const driver = getPosDriver();
  const payments = await driver.listPaymentsForOrder(order.id);
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
  const payments = await getPosDriver().listPaymentsForOrder(order.id);
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
    isStripeConfigured() &&
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

/** Refund a captured tender (full or partial) and persist the refunded amount. */
export async function refundPayment(input: {
  paymentId: string;
  amountCents?: number;
  reason?: string;
}): Promise<Payment | null> {
  const driver = getPosDriver();
  const payment = await driver.getPayment(input.paymentId);
  if (!payment) return null;

  const rail = requirePaymentRail(payment.rail);
  const refundAmount = input.amountCents ?? payment.amount_cents + payment.tip_cents;

  const result = await rail.refund({
    context: {
      tenantId: payment.tenant_id,
      locationId: payment.location_id,
      connectAccountId: payment.connect_account_id,
      idempotencyKey: `refund_${payment.id}`,
    },
    chargeId: payment.charge_id ?? payment.id,
    amount: { amount: refundAmount, currency: payment.currency },
    reason: input.reason,
    fullRefund:
      payment.refunded_cents + refundAmount >=
      payment.amount_cents + payment.tip_cents,
  });

  const refundedTotal = payment.refunded_cents + result.amount.amount;
  const fullyRefunded = refundedTotal >= payment.amount_cents + payment.tip_cents;

  const updated = await driver.upsertPayment({
    ...payment,
    status: fullyRefunded ? "refunded" : payment.status,
    refunded_cents: refundedTotal,
  });

  // If all tenders on the order are fully refunded, mark the order refunded.
  const all = await driver.listPaymentsForOrder(payment.order_id);
  const allRefunded =
    all.length > 0 && all.every((p) => p.status === "refunded");
  if (allRefunded) await driver.updateOrderStatus(payment.order_id, "refunded");

  return updated;
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

  const payments = await driver.listPaymentsForOrder(orderId);
  if (settledCents(payments) < orderDueCents(order)) return;

  if (order.status === "draft" || order.status === "placed") {
    await driver.updateOrderStatus(orderId, "paid");
  } else if (order.status !== "paid") {
    console.info(
      `[payments] order ${orderId} settled while ${order.status}; status left unchanged`,
    );
  }
}
