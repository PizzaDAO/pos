/**
 * Stripe online rail — card-not-present payments via Stripe Connect.
 *
 * Built now (Phase 2) and reused heavily by the customer shop in Phase 4. Same
 * Connect + application-fee model as the Terminal rail, but card-not-present:
 *  - `createCharge` creates a PaymentIntent on the tenant's CONNECTED account
 *    with `automatic_payment_methods` and `application_fee_amount`. The client
 *    confirms it with Stripe.js using the returned `client_secret`
 *    (`raw.clientSecret`); a confirmation webhook captures it.
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
import { getDefaultPlatformFee, isStripeConfigured } from "../env";
import { computeApplicationFeeCents } from "../fees";
import {
  mapIntentStatus,
  stripeGet,
  stripeRequest,
} from "../providers/stripe-client";
import { simId, simRaw } from "./simulate";

const KEY = "stripe_online" as const;

function feeForTender(amount: number, tip: number): number {
  const { bps, flatCents } = getDefaultPlatformFee();
  return computeApplicationFeeCents({
    amountCents: amount + tip,
    feeBps: bps,
    feeFlatCents: flatCents,
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

    if (!isStripeConfigured()) {
      return {
        rail: KEY,
        chargeId: simId("pi_online"),
        status: req.capture === false ? "authorized" : "captured",
        amount,
        raw: simRaw(KEY, {
          applicationFeeCents: fee,
          tipCents: tip,
          clientSecret: `${simId("seti")}_secret`,
        }),
      };
    }

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
        metadata: { ...req.metadata, tip_cents: String(tip) },
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
      raw: {
        applicationFeeCents: fee,
        tipCents: tip,
        clientSecret: intent.client_secret,
        stripeStatus: intent.status,
      },
    };
  },

  async capture(req: CaptureRequest): Promise<ChargeResult> {
    const amount = req.amount ?? { amount: 0, currency: "USD" };
    if (!isStripeConfigured()) {
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
    if (!isStripeConfigured()) {
      return { refundId: simId("re_online"), status: "refunded", amount };
    }
    const refund = await stripeRequest<{ id: string; status: string }>(
      "/refunds",
      {
        payment_intent: req.chargeId,
        amount: req.amount?.amount,
        reason: req.reason,
        refund_application_fee: true,
        reverse_transfer: true,
      },
      { stripeAccount: req.context.connectAccountId ?? undefined },
    );
    return {
      refundId: refund.id,
      status: refund.status === "succeeded" ? "refunded" : "pending",
      amount,
    };
  },

  async status(context: PaymentContext, chargeId: string) {
    if (!isStripeConfigured()) return "captured" as const;
    const intent = await stripeGet<{ status: string }>(
      `/payment_intents/${chargeId}`,
      { stripeAccount: context.connectAccountId ?? undefined },
    );
    return mapIntentStatus(intent.status);
  },
};
