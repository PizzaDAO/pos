/**
 * Stored-value rails (`gift_card`, `store_credit`).
 *
 * A redemption is NOT a charge: the card is debited and the tender written in
 * one transaction by the stored-value writer (src/lib/giftcards,
 * `redeemStoredValue`), so `createCharge` refuses (nothing may reach these rails
 * through the generic takePayment path). `refund` is the part the payment
 * service uses: refunding a gift card tender credits the value back to the card
 * it came from (idempotent on the refund's idempotency key). The tender's
 * `charge_id` is the redeem ledger row id.
 */
import type {
  CaptureRequest,
  ChargeResult,
  PaymentContext,
  PaymentRail,
  Quote,
  QuoteRequest,
  RefundRequest,
  RefundResult,
} from "../PaymentRail";

function storedValueRail(key: "gift_card" | "store_credit"): PaymentRail {
  return {
    key,

    async quote(req: QuoteRequest): Promise<Quote> {
      return { rail: key, total: req.amount };
    },

    async createCharge(): Promise<ChargeResult> {
      throw new Error("Gift cards and store credit are redeemed through /api/gift-cards/redeem.");
    },

    async capture(req: CaptureRequest): Promise<ChargeResult> {
      return {
        rail: key,
        chargeId: req.chargeId,
        status: "captured",
        amount: req.amount ?? { amount: 0, currency: "USD" },
      };
    },

    async refund(req: RefundRequest): Promise<RefundResult> {
      const { getStoredValueStore } = await import("@/lib/giftcards/store");
      const store = await getStoredValueStore();
      const redeemed = await store.getLedgerEntry(req.chargeId);
      if (!redeemed || redeemed.kind !== "redeem" || redeemed.tenant_id !== req.context.tenantId) {
        throw new Error("Gift card redemption not found for this payment.");
      }
      const amount = req.amount?.amount ?? -redeemed.amount_cents;
      const credited = await store.credit({
        tenantId: redeemed.tenant_id,
        accountId: redeemed.account_id,
        locationId: req.context.locationId,
        kind: "refund",
        amountCents: amount,
        key: req.context.idempotencyKey,
        orderId: redeemed.order_id,
        paymentId: redeemed.payment_id,
        reason: req.reason ?? null,
      });
      if (!credited.ok) throw new Error(`Could not return the value to the card (${credited.reason}).`);
      return {
        refundId: credited.entry?.id ?? req.context.idempotencyKey,
        status: "refunded",
        amount: { amount, currency: req.amount?.currency ?? "USD" },
      };
    },

    async status(_context: PaymentContext, _chargeId: string) {
      return "captured" as const;
    },
  };
}

export const giftCardRail = storedValueRail("gift_card");
export const storeCreditRail = storedValueRail("store_credit");
