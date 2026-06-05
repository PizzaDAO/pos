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
    .filter((p) => p.status !== "failed" && p.status !== "canceled")
    .reduce((sum, p) => sum + p.amount_cents, 0);
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

  // Idempotency guard: a tender with this id already exists → return it.
  const existing = await driver.getPayment(input.paymentId);
  if (existing) return existing;

  const rail = requirePaymentRail(input.rail);
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
  const updated = await driver.upsertPayment({ ...payment, status });
  await maybeMarkOrderPaid(payment.order_id);
  return updated;
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
