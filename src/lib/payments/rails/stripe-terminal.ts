/**
 * Stripe Terminal rail — in-store card-present payments via Stripe Connect.
 *
 * REAL path (when STRIPE_SECRET_KEY is set):
 *  - `quote` computes the platform application fee for the tender.
 *  - `createCharge` creates a PaymentIntent on the tenant's CONNECTED account
 *    (`Stripe-Account` header) with `payment_method_types: ['card_present']`,
 *    `application_fee_amount` (our platform fee), and `capture_method` =
 *    automatic|manual. In a real terminal the reader collects the card and
 *    `process_payment_intent` is called from the Terminal SDK on the device;
 *    here we create the intent and (for capture=true) confirm it server-side.
 *  - Connection tokens for the reader SDK are minted by
 *    `/api/payments/stripe/connection-token`.
 *
 * OFFLINE store-and-forward (documented stub): Stripe Terminal readers queue
 * card-present transactions in the reader's secure element when the network is
 * down and forward them on reconnect. Constraints: per-transaction cap +
 * forwarding window, card-present only, NO offline refunds, and the MERCHANT
 * carries decline risk. In this codebase the offline queue (IndexedDB) records
 * the intended tender; on reconnect the same idempotency-keyed `createCharge`
 * runs, mirroring the reader's forward-on-reconnect semantics. Real reader
 * store-and-forward is configured on the physical device in the field phase.
 *
 * SIMULATED path (no key, incl. preview): approves instantly with a `sim_` id.
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

const KEY = "stripe_terminal" as const;

function feeForTender(amount: number, tip: number): number {
  const { bps, flatCents } = getDefaultPlatformFee();
  return computeApplicationFeeCents({
    amountCents: amount + tip,
    feeBps: bps,
    feeFlatCents: flatCents,
  });
}

export const stripeTerminalRail: PaymentRail = {
  key: KEY,

  async quote(req: QuoteRequest): Promise<Quote> {
    const tip = req.tip?.amount ?? 0;
    const total = {
      amount: req.amount.amount + tip,
      currency: req.amount.currency,
    };
    const fee = feeForTender(req.amount.amount, tip);
    return {
      rail: KEY,
      total,
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
      // Simulated approval — reader present, instant capture.
      return {
        rail: KEY,
        chargeId: simId("pi_terminal"),
        status: req.capture === false ? "authorized" : "captured",
        amount,
        raw: simRaw(KEY, { applicationFeeCents: fee, tipCents: tip }),
      };
    }

    // Real Connect charge on the tenant's connected account.
    const intent = await stripeRequest<{ id: string; status: string }>(
      "/payment_intents",
      {
        amount: amount.amount,
        currency: amount.currency.toLowerCase(),
        payment_method_types: ["card_present"],
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
      raw: { applicationFeeCents: fee, tipCents: tip, stripeStatus: intent.status },
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
      return { refundId: simId("re_terminal"), status: "refunded", amount };
    }
    const refund = await stripeRequest<{ id: string; status: string }>(
      "/refunds",
      {
        payment_intent: req.chargeId,
        amount: req.amount?.amount,
        reason: req.reason,
        // Refund the platform fee proportionally back to the platform.
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
