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
 * still be in flight). It holds the tender's refund lock (also taken by every
 * replay of a pending card refund) and, for a till refund request, its
 * execution claim; the release is a compare-and-set on the entry still being
 * pending, so a refund confirmed meanwhile is never undone. A dry run only
 * reports what Stripe shows (the back office then asks for that outcome).
 */
import { getPosDriver, type Payment, type PaymentRefund } from "@/lib/db";
import type { AdjustmentRecord } from "@/lib/db/adjustment-types";
import { captureError } from "@/lib/observability";
import { refreshRefundRecord } from "@/lib/adjustments/service";
import { stripeGet } from "./providers/stripe-client";
import { isPastIdempotencyWindow, maybeMarkOrderRefunded } from "./service";

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
  /** Unix seconds. */
  created?: number;
  metadata?: Record<string, string> | null;
}

export type ResolveOutcome = "confirmed" | "released" | "ref_recorded";

export interface ResolveResult {
  /** What was done (or, for a dry run, what would be done). */
  outcome: ResolveOutcome;
  /** True for a dry run: Stripe was asked, nothing was changed. */
  dryRun?: boolean;
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

/** The entry's Stripe refund must not predate the refund it confirms (clock skew allowed). */
const CREATED_SKEW_MS = 60_000;

/** A refund entry the resolver may act on (throws a RefundResolveError otherwise). */
function resolvableEntry(payment: Payment, refundId: string, now: number): PaymentRefund {
  const entry = (payment.refunds ?? []).find((r) => r.request_id === refundId);
  if (!entry) throw new RefundResolveError("not_found", "No such refund on this payment.", 404);
  if (entry.state !== "pending" && entry.processor_ref) {
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
  return entry;
}

/** Someone confirmed or released the refund while we were looking it up. */
function changedMeanwhile(): RefundResolveError {
  return new RefundResolveError(
    "in_progress",
    "This refund changed while it was being looked up (a till finished it): refresh and check again.",
    409,
  );
}

/**
 * Look a stuck card refund up at Stripe and confirm or release it (see the file
 * header). Throws RefundResolveError for every refusal; Stripe / network errors
 * propagate (nothing was changed).
 *
 * Races: the per-tender refund lock (also taken by every replay of a pending
 * card refund in refundPayment) keeps a till retry from calling Stripe while
 * this runs; on top of that the release is a compare-and-set (only while the
 * entry is STILL pending), so a refund confirmed meanwhile is never undone.
 */
export async function resolveStuckCardRefund(input: {
  tenantId: string;
  paymentId: string;
  refundId: string;
  stripeRefundId?: string;
  /** Only look it up and say what would happen (the UI's "Check Stripe"). */
  dryRun?: boolean;
  /** The outcome the manager confirmed in the UI: refused if Stripe now says otherwise. */
  expect?: ResolveOutcome;
  now?: number;
}): Promise<ResolveResult> {
  const driver = getPosDriver();
  const now = input.now ?? Date.now();
  const first = await driver.getPayment(input.paymentId);
  if (!first || first.tenant_id !== input.tenantId) {
    throw new RefundResolveError("not_found", "Payment not found.", 404);
  }
  if (!isLiveCardTender(first)) {
    throw new RefundResolveError("not_card", "Only live card refunds are resolved at Stripe.", 422);
  }
  resolvableEntry(first, input.refundId, now);

  const owner = `resolve:${globalThis.crypto.randomUUID()}`;
  if (!(await driver.takePaymentRefundLock(first.id, owner, new Date(Date.now() + CLAIM_MS).toISOString()))) {
    throw new RefundResolveError("in_progress", "This payment's refund is being processed right now: try again in a moment.", 409);
  }
  let record: AdjustmentRecord | null = null;
  let result: ResolveResult | null = null;
  try {
    const requestId = requestIdOf(input.refundId);
    record = requestId
      ? ((await driver.listOrderAdjustments(first.order_id)).find((r) => r.id === requestId) ?? null)
      : null;
    if (record && !(await driver.claimOrderAdjustment(first.order_id, record.id, new Date(Date.now() + CLAIM_MS).toISOString()))) {
      record = null; // not ours to refresh
      throw new RefundResolveError("in_progress", "This refund is being processed right now: try again in a moment.", 409);
    }
    // Under the lock: the entry as it is NOW.
    const payment = (await driver.getPayment(first.id)) ?? first;
    const entry = resolvableEntry(payment, input.refundId, now);
    const pending = entry.state === "pending";

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
    if (found && input.stripeRefundId) {
      // A re_ id given by hand must be a refund made AFTER this one was asked for
      // (never an older refund of the same charge).
      const at = Date.parse(entry.at);
      if (typeof found.created !== "number" || !Number.isFinite(at) || found.created * 1000 < at - CREATED_SKEW_MS) {
        throw new RefundResolveError("mismatch", "That Stripe refund was made before this refund was asked for.", 409);
      }
    }
    const proposed: ResolveOutcome = pending ? (live ? "confirmed" : "released") : "ref_recorded";
    if (!pending && !live) {
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
    if (input.dryRun) {
      result = { outcome: proposed, dryRun: true, stripeRefund: view, payment };
    } else if (input.expect && input.expect !== proposed) {
      throw new RefundResolveError(
        "mismatch",
        `Stripe now says this refund should be ${proposed}, not ${input.expect}: check it again.`,
        409,
      );
    } else if (pending) {
      if (live) {
        const confirmed = await driver.confirmPaymentRefund(payment.id, input.refundId, found!.id);
        if (!confirmed) throw changedMeanwhile();
        await maybeMarkOrderRefunded(payment.order_id);
        result = { outcome: "confirmed", stripeRefund: view, payment };
      } else {
        // Failed / canceled at Stripe, or never made: nothing was returned.
        // Compare-and-set: only while it is STILL pending.
        if (!(await driver.releasePendingPaymentRefund(payment.id, input.refundId, { tombstone: true }))) {
          throw changedMeanwhile();
        }
        result = { outcome: "released", stripeRefund: view, payment };
      }
    } else {
      // Confirmed earlier without a Stripe id.
      await driver.setRefundProcessorRef?.(payment.id, input.refundId, found!.id);
      result = { outcome: "ref_recorded", stripeRefund: view, payment };
    }
  } finally {
    // Re-derive the request from the tenders (and release its claim).
    if (record) {
      const rec = record;
      await refreshRefundRecord(
        first.order_id,
        rec.id,
        result && !result.dryRun ? { resolved_at: new Date(now).toISOString(), resolved: result.outcome } : undefined,
      ).catch((err) => captureError(err, { scope: "refund-resolve", requestId: rec.id }));
    }
    await driver
      .releasePaymentRefundLock(first.id, owner)
      .catch((err) => captureError(err, { scope: "refund-resolve-unlock", paymentId: first.id }));
  }
  return { ...result!, payment: (await driver.getPayment(first.id)) ?? first };
}

export interface StuckCardRefund {
  paymentId: string;
  orderId: string;
  locationId: string;
  refundId: string;
  amountCents: number;
  currency: string;
  at: string;
  /** pending: the outcome at Stripe is unknown; no_ref: recorded without a Stripe id. */
  kind: "pending" | "no_ref";
  /** Older than Stripe's idempotency window: POS will no longer retry it by itself. */
  pastWindow: boolean;
}

/** Card refunds the back office should resolve (older than RESOLVE_MIN_AGE_MS). */
export async function listStuckCardRefunds(
  tenantId: string,
  locationId: string | null,
  now = Date.now(),
): Promise<StuckCardRefund[]> {
  const tenders = await getPosDriver().listCardTendersWithOpenRefunds(tenantId, locationId, 100);
  const out: StuckCardRefund[] = [];
  for (const p of tenders) {
    if (!isLiveCardTender(p)) continue;
    for (const e of p.refunds ?? []) {
      if (!e.request_id) continue;
      const kind = e.state === "pending" ? "pending" : !e.processor_ref ? "no_ref" : null;
      if (!kind) continue;
      const at = Date.parse(e.at);
      if (Number.isFinite(at) && now - at < RESOLVE_MIN_AGE_MS) continue;
      out.push({
        paymentId: p.id,
        orderId: p.order_id,
        locationId: p.location_id,
        refundId: e.request_id,
        amountCents: e.amount_cents,
        currency: p.currency,
        at: e.at,
        kind,
        pastWindow: isPastIdempotencyWindow(e, now),
      });
    }
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}
