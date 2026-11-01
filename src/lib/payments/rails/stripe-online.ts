/**
 * Stripe online rail — card-not-present payments via Stripe Connect.
 *
 * Built now (Phase 2) and reused heavily by the customer shop in Phase 4. Same
 * Connect + application-fee model as the Terminal rail, but card-not-present:
 *  - `createCharge` creates a PaymentIntent on the tenant's CONNECTED account
 *    with `automatic_payment_methods` and `application_fee_amount`. The client
 *    confirms it with Stripe.js using the returned `client_secret`
 *    (`ChargeResult.clientSecret`, returned to the caller, never persisted); a confirmation webhook captures it.
 *
 * REAL path is guarded by STRIPE_SECRET_KEY. With no key (default, incl.
 * preview) it simulates instant approval so the terminal flow works end-to-end.
 */
import type {
  CaptureRequest,
  ChargeResult,
  CreateChargeRequest,
  PaymentContext,
  PaymentRail,
  Quote,
  QuoteRequest,
  RefundRequest,
  RefundResult,
} from "../PaymentRail";
import {
  assertLiveKeyAllowed,
  cardRailsSimulated,
  getDefaultPlatformFee,
  isStripeLiveKey,
} from "../env";
import { computeApplicationFeeCents, stripeRefundParams } from "../fees";
import {
  mapIntentStatus,
  stripeGet,
  stripeRequest,
} from "../providers/stripe-client";
import { simId, simRaw } from "./simulate";

const KEY = "stripe_online" as const;

/**
 * Platform application fee for a tender. Computed on the BASE amount only: tips
 * are the staff's, not revenue the platform takes a cut of (same policy as the
 * terminal rail and GAPS). `tip` is accepted so call sites state it, but it is
 * deliberately NOT part of the fee base. (Before pos-v1-gaps this charged the fee
 * on amount + tip; that was the only behaviour change to the shop checkout.)
 */
export function feeForTender(amount: number, _tip: number): number {
  const { bps, flatCents } = getDefaultPlatformFee();
  return computeApplicationFeeCents({
    amountCents: amount,
    feeBps: bps,
    feeFlatCents: flatCents,
  });
}

// ---------------------------------------------------------------------------
// Stripe Checkout (hosted pay links for /v1 payment sessions)
// ---------------------------------------------------------------------------

export interface CheckoutSessionParams {
  /** Our tender id (payments.id): rides on the PaymentIntent for webhook matching. */
  paymentId: string;
  orderId: string;
  tenantId: string;
  connectAccountId: string;
  currency: string;
  /** Base amount (food), cents. */
  amountCents: number;
  tipCents: number;
  applicationFeeCents: number;
  successUrl: string;
  cancelUrl: string;
  /** Unix seconds. */
  expiresAt: number;
  customerEmail?: string | null;
  description: string;
}

export interface StripeCheckoutSession {
  id: string;
  url: string | null;
  status: "open" | "complete" | "expired" | string;
  payment_status?: string;
  payment_intent?: string | null;
  amount_total?: number | null;
  currency?: string | null;
  expires_at: number;
  livemode?: boolean;
}

/**
 * Create a Checkout Session on the tenant's CONNECTED account (direct charge:
 * `Stripe-Account` header, application fee on the PaymentIntent). Card only so
 * capture stays synchronous (wallets ride on card). The PaymentIntent carries
 * `payment_id` metadata, which is how the existing `payment_intent.succeeded`
 * webhook finds the tender (Stripe creates the PaymentIntent only when the payer
 * confirms, so there is no charge id to store earlier).
 *
 * CALLER MUST HAVE PASSED `assertSessionChargeAllowed` (the safety gate); this
 * function additionally refuses to run in simulated mode.
 */
export async function createCheckoutSession(
  p: CheckoutSessionParams,
): Promise<StripeCheckoutSession> {
  if (cardRailsSimulated()) {
    throw new Error("createCheckoutSession called in simulated mode.");
  }
  const currency = p.currency.toLowerCase();
  const lineItems: Record<string, unknown>[] = [
    {
      price_data: {
        currency,
        unit_amount: p.amountCents,
        product_data: { name: p.description },
      },
      quantity: 1,
    },
  ];
  if (p.tipCents > 0) {
    lineItems.push({
      price_data: {
        currency,
        unit_amount: p.tipCents,
        product_data: { name: "Tip" },
      },
      quantity: 1,
    });
  }
  return stripeRequest<StripeCheckoutSession>(
    "/checkout/sessions",
    {
      mode: "payment",
      payment_method_types: ["card"],
      line_items: lineItems,
      success_url: p.successUrl,
      cancel_url: p.cancelUrl,
      expires_at: p.expiresAt,
      customer_email: p.customerEmail ?? undefined,
      client_reference_id: p.paymentId,
      metadata: {
        payment_id: p.paymentId,
        order_id: p.orderId,
        tenant_id: p.tenantId,
      },
      payment_intent_data: {
        application_fee_amount:
          p.applicationFeeCents > 0 ? p.applicationFeeCents : undefined,
        metadata: {
          payment_id: p.paymentId,
          order_id: p.orderId,
          tenant_id: p.tenantId,
          tip_cents: String(p.tipCents),
        },
      },
    },
    {
      stripeAccount: p.connectAccountId,
      // One session per tender: a retry of the same tender never makes a second.
      idempotencyKey: `cs_${p.paymentId}`,
    },
  );
}

/** Expire an open Checkout Session (throws if it already completed/expired). */
export async function expireCheckoutSession(
  sessionId: string,
  connectAccountId: string | null,
): Promise<StripeCheckoutSession> {
  return stripeRequest<StripeCheckoutSession>(
    `/checkout/sessions/${sessionId}/expire`,
    {},
    { stripeAccount: connectAccountId },
  );
}

export async function getCheckoutSession(
  sessionId: string,
  connectAccountId: string | null,
): Promise<StripeCheckoutSession> {
  return stripeGet<StripeCheckoutSession>(`/checkout/sessions/${sessionId}`, {
    stripeAccount: connectAccountId,
  });
}

export const stripeOnlineRail: PaymentRail = {
  key: KEY,

  async quote(req: QuoteRequest): Promise<Quote> {
    const tip = req.tip?.amount ?? 0;
    const fee = feeForTender(req.amount.amount, tip);
    return {
      rail: KEY,
      total: { amount: req.amount.amount + tip, currency: req.amount.currency },
      applicationFee: { amount: fee, currency: req.amount.currency },
    };
  },

  async createCharge(req: CreateChargeRequest): Promise<ChargeResult> {
    const tip = req.tip?.amount ?? 0;
    const amount = {
      amount: req.amount.amount + tip,
      currency: req.amount.currency,
    };
    const fee = feeForTender(req.amount.amount, tip);

    if (cardRailsSimulated()) {
      return {
        rail: KEY,
        chargeId: simId("pi_online"),
        status: req.capture === false ? "authorized" : "captured",
        amount,
        clientSecret: `${simId("seti")}_secret`,
        raw: simRaw(KEY, { applicationFeeCents: fee, tipCents: tip }),
      };
    }

    assertLiveKeyAllowed();
    const intent = await stripeRequest<{
      id: string;
      status: string;
      client_secret: string;
    }>(
      "/payment_intents",
      {
        amount: amount.amount,
        currency: amount.currency.toLowerCase(),
        automatic_payment_methods: { enabled: true },
        capture_method: req.capture === false ? "manual" : "automatic",
        application_fee_amount: fee > 0 ? fee : undefined,
        metadata: {
          ...req.metadata,
          tip_cents: String(tip),
          payment_id: req.context.idempotencyKey,
          tenant_id: req.context.tenantId,
        },
      },
      {
        stripeAccount: req.context.connectAccountId ?? undefined,
        idempotencyKey: req.context.idempotencyKey,
      },
    );

    return {
      rail: KEY,
      chargeId: intent.id,
      status: mapIntentStatus(intent.status),
      amount,
      // The client_secret goes to the caller only; it is never stored in `raw`.
      clientSecret: intent.client_secret,
      raw: {
        applicationFeeCents: fee,
        tipCents: tip,
        stripeStatus: intent.status,
        // Test vs live: the sweeper only touches tenders of its own mode.
        livemode: isStripeLiveKey(),
      },
    };
  },

  async capture(req: CaptureRequest): Promise<ChargeResult> {
    const amount = req.amount ?? { amount: 0, currency: "USD" };
    if (cardRailsSimulated()) {
      return { rail: KEY, chargeId: req.chargeId, status: "captured", amount };
    }
    const intent = await stripeRequest<{ id: string; status: string }>(
      `/payment_intents/${req.chargeId}/capture`,
      req.amount ? { amount_to_capture: req.amount.amount } : {},
      { stripeAccount: req.context.connectAccountId ?? undefined },
    );
    return {
      rail: KEY,
      chargeId: intent.id,
      status: mapIntentStatus(intent.status),
      amount,
    };
  },

  async refund(req: RefundRequest): Promise<RefundResult> {
    const amount = req.amount ?? { amount: 0, currency: "USD" };
    if (cardRailsSimulated()) {
      return { refundId: simId("re_online"), status: "refunded", amount };
    }
    const refund = await stripeRequest<{ id: string; status: string }>(
      "/refunds",
      stripeRefundParams({
        chargeId: req.chargeId,
        amountCents: req.amount?.amount,
        reason: req.reason,
      }),
      {
        stripeAccount: req.context.connectAccountId ?? undefined,
        // Unique per refund request (see refundPayment).
        idempotencyKey: req.context.idempotencyKey,
      },
    );
    return {
      refundId: refund.id,
      status: refund.status === "succeeded" ? "refunded" : "pending",
      amount,
    };
  },

  async status(context: PaymentContext, chargeId: string) {
    if (cardRailsSimulated()) return "captured" as const;
    const intent = await stripeGet<{ status: string }>(
      `/payment_intents/${chargeId}`,
      { stripeAccount: context.connectAccountId ?? undefined },
    );
    return mapIntentStatus(intent.status);
  },
};
