/**
 * Manual resolution of a CARD refund stuck `pending` (Stripe kept answering an
 * idempotency_error, never answered, or the entry outlived Stripe's 24 h
 * idempotency window). An owner / manager asks; the server looks the refund up
 * AT STRIPE (never asks Stripe to refund again) and records what Stripe says:
 *
 *  - Stripe has it (succeeded / pending / requires_action) for the same amount:
 *    the entry is CONFIRMED with its `re_` id (a later failure still arrives
 *    through the refund.failed webhook).
 *  - Stripe has it failed / canceled, or has no such refund at all: the entry is
 *    RELEASED with a tombstone (the money is held again; a resume mints the next
 *    refund id, the old idempotency key is never reused).
 *  - Anything else (another amount, a refund of another charge): nothing
 *    changes; alerted for a human.
 *
 * Lookup: by `stripeRefundId` (a `re_` id staff found in the Stripe dashboard),
 * else by listing the PaymentIntent's refunds and matching the metadata POS
 * sent (`refund_id` = our refund id). A confirmed entry with no Stripe id (an
 * old replay we may no longer repeat) gets its id the same way.
 *
 * Never runs on an entry younger than RESOLVE_MIN_AGE_MS (its Stripe call may
 * still be in flight), and holds the refund request's execution claim while it
 * works, so a till resuming the same request cannot race it.
 */
import { getPosDriver, type Payment, type PaymentRefund } from "@/lib/db";
import { captureError } from "@/lib/observability";
import { refreshRefundRecord } from "@/lib/adjustments/service";
import { stripeGet } from "./providers/stripe-client";
import { maybeMarkOrderRefunded } from "./service";

/** An entry younger than this may still have its Stripe call in flight. */
export const RESOLVE_MIN_AGE_MS = 5 * 60_000;
/** How long the resolution holds the request's execution claim. */
const CLAIM_MS = 2 * 60_000;
/** Refund list pages read per lookup (100 each). */
const MAX_PAGES = 10;

export class RefundResolveError extends Error {
  constructor(
    readonly code:
      | "not_found"
      | "not_card"
      | "already_resolved"
      | "too_recent"
      | "in_progress"
      | "mismatch"
      | "not_at_stripe",
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "RefundResolveError";
  }
}

interface StripeRefund {
  id: string;
  status: string;
  amount: number;
  payment_intent?: string | null;
  metadata?: Record<string, string> | null;
}

export interface ResolveResult {
  outcome: "confirmed" | "released" | "ref_recorded";
  /** The Stripe refund found (null: Stripe has none for this refund id). */
  stripeRefund: { id: string; status: string; amount: number } | null;
  payment: Payment;
}

function isLiveCardTender(p: Payment): boolean {
  return (
    (p.rail === "stripe_terminal" || p.rail === "stripe_online") &&
    !p.simulated &&
    !!p.charge_id &&
    !p.charge_id.startsWith("sim_") &&
    !!p.connect_account_id &&
    !p.connect_account_id.startsWith("acct_sim_")
  );
}

/** The adjustment request a per-tender refund id belongs to (`<request>_<8 hex>_<n>`). */
function requestIdOf(refundId: string): string | null {
  const id = refundId.replace(/_[0-9a-zA-Z]{1,8}_\d+$/, "");
  return id !== refundId ? id : null;
}

async function findStripeRefund(
  payment: Payment,
  entry: PaymentRefund,
  refundId: string,
  stripeRefundId: string | undefined,
): Promise<StripeRefund | null> {
  const opts = { stripeAccount: payment.connect_account_id };
  if (stripeRefundId) {
    const r = await stripeGet<StripeRefund>(`/refunds/${encodeURIComponent(stripeRefundId)}`, opts);
    if (r.payment_intent !== payment.charge_id) {
      throw new RefundResolveError("mismatch", "That Stripe refund belongs to another payment.", 409);
    }
    const tagged = r.metadata?.refund_id;
    // A refund POS made carries our id; one made by hand in the dashboard has
    // none. Never one POS made for ANOTHER refund, nor one already recorded.
    if ((tagged && tagged !== refundId) ||
        (payment.refunds ?? []).some((e) => e !== entry && e.processor_ref === r.id)) {
      throw new RefundResolveError("mismatch", "That Stripe refund is recorded for another refund.", 409);
    }
    return r;
  }
  let after = "";
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const list = await stripeGet<{ data: StripeRefund[]; has_more: boolean }>(
      `/refunds?payment_intent=${encodeURIComponent(payment.charge_id!)}&limit=100${after}`,
      opts,
    );
    const hit = list.data.find(
      (r) =>
        r.metadata?.refund_id === refundId &&
        (!r.metadata?.payment_id || r.metadata.payment_id === payment.id),
    );
    if (hit) return hit;
    if (!list.has_more || list.data.length === 0) return null;
    after = `&starting_after=${encodeURIComponent(list.data[list.data.length - 1]!.id)}`;
  }
  // Too many refunds to be sure there is none: never release on a guess.
  throw new RefundResolveError(
    "in_progress",
    "This payment has too many refunds at Stripe to look this one up: give its re_ id.",
    409,
  );
}

/**
 * Look a stuck card refund up at Stripe and confirm or release it (see the file
 * header). Throws RefundResolveError for every refusal; Stripe / network errors
 * propagate (nothing was changed).
 */
export async function resolveStuckCardRefund(input: {
  tenantId: string;
  paymentId: string;
  refundId: string;
  stripeRefundId?: string;
  now?: number;
}): Promise<ResolveResult> {
  const driver = getPosDriver();
  const now = input.now ?? Date.now();
  const payment = await driver.getPayment(input.paymentId);
  if (!payment || payment.tenant_id !== input.tenantId) {
    throw new RefundResolveError("not_found", "Payment not found.", 404);
  }
  if (!isLiveCardTender(payment)) {
    throw new RefundResolveError("not_card", "Only live card refunds are resolved at Stripe.", 422);
  }
  const entry = (payment.refunds ?? []).find((r) => r.request_id === input.refundId);
  if (!entry) throw new RefundResolveError("not_found", "No such refund on this payment.", 404);
  const pending = entry.state === "pending";
  if (!pending && entry.processor_ref) {
    throw new RefundResolveError("already_resolved", "This refund is already recorded with its Stripe id.", 409);
  }
  const at = Date.parse(entry.at);
  if (Number.isFinite(at) && now - at < RESOLVE_MIN_AGE_MS) {
    throw new RefundResolveError(
      "too_recent",
      "This refund was asked for only minutes ago: wait for it, then try again.",
      409,
    );
  }

  const requestId = requestIdOf(input.refundId);
  const record = requestId
    ? ((await driver.listOrderAdjustments(payment.order_id)).find((r) => r.id === requestId) ?? null)
    : null;
  if (record) {
    const until = new Date(now + CLAIM_MS).toISOString();
    if (!(await driver.claimOrderAdjustment(payment.order_id, record.id, until))) {
      throw new RefundResolveError("in_progress", "This refund is being processed right now: try again in a moment.", 409);
    }
  }

  let result: ResolveResult | null = null;
  try {
    const found = await findStripeRefund(payment, entry, input.refundId, input.stripeRefundId);
    const view = found ? { id: found.id, status: found.status, amount: found.amount } : null;
    const live = !!found && ["succeeded", "pending", "requires_action"].includes(found.status);
    if (found && live && found.amount !== entry.amount_cents) {
      captureError(new Error("stuck refund: Stripe refund amount differs"), {
        scope: "refund-resolve",
        paymentId: payment.id,
        refundId: input.refundId,
        stripeRefundId: found.id,
      });
      throw new RefundResolveError(
        "mismatch",
        `Stripe refunded ${found.amount}¢ but POS reserved ${entry.amount_cents}¢: correct it by hand.`,
        409,
      );
    }
    if (pending) {
      if (live) {
        await driver.confirmPaymentRefund(payment.id, input.refundId, found!.id);
        await maybeMarkOrderRefunded(payment.order_id);
        result = { outcome: "confirmed", stripeRefund: view, payment };
      } else {
        // Failed / canceled at Stripe, or never made: nothing was returned.
        await driver.releasePaymentRefund(payment.id, entry.amount_cents, input.refundId, {
          tombstone: true,
        });
        result = { outcome: "released", stripeRefund: view, payment };
      }
    } else {
      // Confirmed earlier without a Stripe id.
      if (!live) {
        captureError(new Error("refund recorded as done but Stripe has no live refund"), {
          scope: "refund-resolve",
          paymentId: payment.id,
          refundId: input.refundId,
          stripeStatus: found?.status ?? null,
        });
        throw new RefundResolveError(
          "not_at_stripe",
          found
            ? `Stripe shows this refund ${found.status}: the money was NOT returned. Refund it another way.`
            : "Stripe has no refund for this: the money was NOT returned. Refund it another way.",
          409,
        );
      }
      await driver.setRefundProcessorRef?.(payment.id, input.refundId, found!.id);
      result = { outcome: "ref_recorded", stripeRefund: view, payment };
    }
  } finally {
    // Re-derive the request from the tenders (and release the claim).
    if (record) {
      await refreshRefundRecord(
        payment.order_id,
        record.id,
        result ? { resolved_at: new Date(now).toISOString(), resolved: result.outcome } : undefined,
      ).catch((err) => captureError(err, { scope: "refund-resolve", requestId: record.id }));
    }
  }
  return { ...result!, payment: (await driver.getPayment(payment.id)) ?? payment };
}
