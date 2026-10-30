/**
 * Stripe Terminal rail -- in-store card-present payments via Stripe Connect,
 * SERVER-DRIVEN (plans/terminal-card-reader.md).
 *
 * REAL path (a Stripe key and not training mode):
 *  - `createCharge` creates the PaymentIntent on the tenant's CONNECTED account
 *    (`Stripe-Account`, direct charge) with `payment_method_types: ['card_present']`
 *    and `capture_method: automatic`. It does NOT confirm it: the PI is handed to
 *    the reader by `process_payment_intent` (see `terminal/flow.ts`), and the READER
 *    collects the card and confirms. Stripe says never to confirm card_present
 *    server-side.
 *  - `application_fee_amount` is computed on the PRE-TIP amount in EVERY tip mode
 *    (product decision): the platform takes no fee on tips. (An on-reader tip is
 *    not even known when the PI is created.)
 *  - Reader tips arrive in `amount_details.tip.amount`; flow.ts records them.
 *
 * OFFLINE: card needs internet. Stripe's offline mode requires the native iOS /
 * Android / React Native Terminal SDK and is NOT supported by server-driven or
 * Terminal JS (docs.stripe.com/terminal/features/operate-offline/overview), so a
 * web POS is cash-only while offline. There is no store-and-forward here.
 *
 * SIMULATED path (no key, training mode, or the mock driver): no Stripe call
 * ever. With a `reader_id` in the metadata (the reader flow) the tender is created
 * `requires_action` and settled by the simulated reader buttons; without one
 * (legacy direct `takePayment`) it approves instantly with a `sim_` id.
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
} from "../env";
import { computeApplicationFeeCents, stripeRefundParams } from "../fees";
import {
  mapIntentStatus,
  stripeGet,
  stripeRequest,
} from "../providers/stripe-client";
import { simId, simRaw } from "./simulate";

const KEY = "stripe_terminal" as const;

/**
 * Platform fee for a tender: ALWAYS on the pre-tip amount, whatever the tip mode
 * (a reader tip is unknown at PaymentIntent creation, and the decision is that
 * tips carry no platform fee anywhere).
 */
function feeForTender(amount: number): number {
  const { bps, flatCents } = getDefaultPlatformFee();
  return computeApplicationFeeCents({
    amountCents: amount,
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
    const fee = feeForTender(req.amount.amount);
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
    const tipMode = req.metadata?.tip_mode;
    const readerId = req.metadata?.reader_id;
    const fee = feeForTender(req.amount.amount);

    if (cardRailsSimulated()) {
      if (readerId) {
        // Reader flow: waits for the simulated reader (approve / decline).
        return {
          rail: KEY,
          chargeId: simId("pi_terminal"),
          status: "requires_action",
          amount,
          raw: simRaw(KEY, {
            applicationFeeCents: fee,
            tipCents: tip,
            reader_id: readerId,
            tip_mode: tipMode ?? null,
            stripeStatus: "requires_payment_method",
            process_attempts: 0,
          }),
        };
      }
      // Legacy direct call without a reader: instant simulated approval.
      return {
        rail: KEY,
        chargeId: simId("pi_terminal"),
        status: req.capture === false ? "authorized" : "captured",
        amount,
        raw: simRaw(KEY, { applicationFeeCents: fee, tipCents: tip }),
      };
    }

    // Real Connect charge on the tenant's connected account.
    assertLiveKeyAllowed();
    const { description, ...piMetadata } = req.metadata ?? {};
    const intent = await stripeRequest<{ id: string; status: string }>(
      "/payment_intents",
      {
        amount: amount.amount,
        currency: amount.currency.toLowerCase(),
        payment_method_types: ["card_present"],
        capture_method: req.capture === false ? "manual" : "automatic",
        application_fee_amount: fee > 0 ? fee : undefined,
        description: description || undefined,
        metadata: {
          ...piMetadata,
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
      raw: {
        applicationFeeCents: fee,
        tipCents: tip,
        stripeStatus: intent.status,
        reader_id: readerId ?? null,
        tip_mode: tipMode ?? null,
        process_attempts: 0,
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
      return { refundId: simId("re_terminal"), status: "refunded", amount };
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
