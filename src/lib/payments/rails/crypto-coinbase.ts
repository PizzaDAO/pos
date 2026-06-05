/**
 * Coinbase Commerce rail — hosted crypto checkout.
 *
 * REAL path (COINBASE_COMMERCE_API_KEY set): `createCharge` creates a Commerce
 * charge (fixed price in the order's fiat currency) and returns its hosted URL +
 * charge code. The charge starts `pending`; a Coinbase webhook
 * (`/api/payments/coinbase/webhook`, signature-verified) flips it to `captured`
 * on `charge:confirmed`/`charge:resolved`. `status` polls the charge timeline.
 *
 * SIMULATED path (no key, incl. preview): returns a sim hosted URL and
 * auto-confirms after a short delay so the flow completes without Coinbase.
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
import { isCoinbaseConfigured } from "../env";
import {
  createCoinbaseCharge,
  getCoinbaseCharge,
  mapCoinbaseStatus,
} from "../providers/coinbase-client";
import { simId, simRaw } from "./simulate";

const KEY = "crypto_coinbase" as const;
const SIM_CONFIRM_MS = 6_000;

const simCreatedAt = new Map<string, number>();

export const cryptoCoinbaseRail: PaymentRail = {
  key: KEY,

  async quote(req: QuoteRequest): Promise<Quote> {
    const tip = req.tip?.amount ?? 0;
    return {
      rail: KEY,
      total: { amount: req.amount.amount + tip, currency: req.amount.currency },
    };
  },

  async createCharge(req: CreateChargeRequest): Promise<ChargeResult> {
    const tip = req.tip?.amount ?? 0;
    const amount = {
      amount: req.amount.amount + tip,
      currency: req.amount.currency,
    };

    if (!isCoinbaseConfigured()) {
      const chargeId = simId("cbcommerce");
      simCreatedAt.set(chargeId, Date.now());
      return {
        rail: KEY,
        chargeId,
        status: "pending",
        amount,
        raw: simRaw(KEY, {
          hostedUrl: `https://commerce.coinbase.com/checkout/${chargeId}`,
          confirmsAfterMs: SIM_CONFIRM_MS,
        }),
      };
    }

    const charge = await createCoinbaseCharge({
      name: "Pizza order",
      description: `Order ${req.metadata?.orderNumber ?? ""}`.trim(),
      amount: (amount.amount / 100).toFixed(2),
      currency: amount.currency,
      metadata: { ...req.metadata, idempotency_key: req.context.idempotencyKey },
      idempotencyKey: req.context.idempotencyKey,
    });

    return {
      rail: KEY,
      chargeId: charge.id,
      status: "pending",
      amount,
      raw: {
        code: charge.code,
        hostedUrl: charge.hosted_url,
      },
    };
  },

  async capture(req: CaptureRequest): Promise<ChargeResult> {
    const status = await this.status(req.context, req.chargeId);
    return {
      rail: KEY,
      chargeId: req.chargeId,
      status,
      amount: req.amount ?? { amount: 0, currency: "USD" },
    };
  },

  async refund(req: RefundRequest): Promise<RefundResult> {
    // Commerce refunds are issued from the Coinbase dashboard / a separate
    // transfer in v1; we record the refund intent here.
    return {
      refundId: simId("cb_refund"),
      status: "refunded",
      amount: req.amount ?? { amount: 0, currency: "USD" },
    };
  },

  async status(_context: PaymentContext, chargeId: string) {
    if (!isCoinbaseConfigured()) {
      const created = simCreatedAt.get(chargeId);
      if (created === undefined) return "pending" as const;
      return Date.now() - created >= SIM_CONFIRM_MS
        ? ("captured" as const)
        : ("pending" as const);
    }
    const charge = await getCoinbaseCharge(chargeId);
    const last = charge.timeline.at(-1)?.status;
    return mapCoinbaseStatus(last);
  },
};
