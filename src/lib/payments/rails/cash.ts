/**
 * Cash rail — fully real, no external dependency.
 *
 * Cash is captured instantly. Tender entry + change-due math lives in the UI;
 * the change is passed through `metadata.cashTenderedCents` so the persisted
 * payment row records what the customer handed over and the change given back.
 * There is nothing to authorize/capture asynchronously, so `capture` is a no-op
 * that echoes the charge, and refunds always "succeed" (cash back from drawer).
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
import { simId } from "./simulate";

export const cashRail: PaymentRail = {
  key: "cash",

  async quote(req: QuoteRequest): Promise<Quote> {
    const total = req.tip
      ? { amount: req.amount.amount + req.tip.amount, currency: req.amount.currency }
      : req.amount;
    // Cash carries no platform application fee.
    return { rail: "cash", total };
  },

  async createCharge(req: CreateChargeRequest): Promise<ChargeResult> {
    const amount = req.tip
      ? { amount: req.amount.amount + req.tip.amount, currency: req.amount.currency }
      : req.amount;
    const tendered = Number(req.metadata?.cashTenderedCents ?? amount.amount);
    const change = Math.max(0, tendered - amount.amount);
    return {
      rail: "cash",
      // Idempotency key doubles as the charge id so retries map to one tender.
      chargeId: req.context.idempotencyKey || simId("cash"),
      status: "captured",
      amount,
      raw: {
        cashTenderedCents: tendered,
        cashChangeCents: change,
      },
    };
  },

  async capture(req: CaptureRequest): Promise<ChargeResult> {
    return {
      rail: "cash",
      chargeId: req.chargeId,
      status: "captured",
      amount: req.amount ?? { amount: 0, currency: "USD" },
    };
  },

  async refund(req: RefundRequest): Promise<RefundResult> {
    return {
      refundId: simId("cashrefund"),
      status: "refunded",
      amount: req.amount ?? { amount: 0, currency: "USD" },
    };
  },

  async status(_context: PaymentContext, _chargeId: string) {
    return "captured" as const;
  },
};
