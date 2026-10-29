/**
 * Stripe webhook handler -- the CONNECT endpoint (events on connected accounts;
 * secret STRIPE_WEBHOOK_SECRET).
 *
 * POST /api/payments/stripe/webhook -- receives PaymentIntent lifecycle events
 * and settles the matching tender through `applyRailStatus` (which also marks
 * the order paid once covered). Hardening:
 *  - the signature is verified with a 5-minute timestamp tolerance and accepts
 *    any of several `v1` entries (secret rotation);
 *  - the event must carry `account` and it must equal the tender's
 *    `connect_account_id` (a valid event for some other account can't settle it);
 *  - the PaymentIntent amount + currency must equal the tender's;
 *  - only the event types below are acted on; everything else is a 200 no-op.
 * With no Stripe key the handler is a no-op (200) so the route is harmless in the
 * preview. We match the tender by PaymentIntent id (charge_id), falling back to
 * `metadata.payment_id`.
 *
 *   payment_intent.succeeded       -> captured
 *   payment_intent.processing      -> pending
 *   payment_intent.payment_failed  -> requires_action (+ raw.last_error)
 *   payment_intent.canceled        -> canceled
 *
 * Also handles the Connect event `account.updated`: the connected account's
 * onboarding/charges status is synced onto our connect_accounts row (matched by
 * Stripe account id) so card payments unlock as soon as KYC completes.
 */
import { NextResponse } from "next/server";
import { getPosDriver } from "@/lib/db";
import type { PaymentStatus } from "@/lib/db";
import {
  STRIPE_WEBHOOK_TOLERANCE_SEC,
  verifyStripeWebhook,
} from "@/lib/payments/providers/stripe-client";
import { isStripeConfigured } from "@/lib/payments/env";
import { applyRailStatus } from "@/lib/payments/service";
import { deriveStatus, fetchConnectStatus } from "@/lib/payments/connect";
import { captureError } from "@/lib/observability";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const rawBody = await request.text();

  // No secret configured → simulated/no-op; acknowledge so retries stop.
  if (!isStripeConfigured()) {
    return NextResponse.json({ received: true, simulated: true });
  }

  const signature = request.headers.get("stripe-signature");
  if (
    !verifyStripeWebhook(rawBody, signature, undefined, {
      toleranceSec: STRIPE_WEBHOOK_TOLERANCE_SEC,
    })
  ) {
    return NextResponse.json(
      { error: "Invalid signature." },
      { status: 400 },
    );
  }

  let event: {
    type?: string;
    /** Unix seconds the event was created. */
    created?: number;
    /** Connected account the event happened on (Connect events). */
    account?: string;
    data?: {
      object?: {
        id?: string;
        status?: string;
        amount?: number;
        currency?: string;
        metadata?: Record<string, string>;
        last_payment_error?: { message?: string } | null;
        charges_enabled?: boolean;
        payouts_enabled?: boolean;
        details_submitted?: boolean;
      };
    };
  };
  try {
    event = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  // Connect: sync a connected account's status (account.updated).
  if (event.type === "account.updated") {
    const acct = event.data?.object;
    if (acct?.id) {
      const driver = getPosDriver();
      const row = await driver.getConnectAccountByAccountId(acct.id);
      if (row) {
        // Events can arrive out of order: prefer the account's CURRENT state
        // from Stripe over the event payload.
        try {
          const fresh = await fetchConnectStatus(row.tenant_id, row.account_id);
          await driver.upsertConnectAccount({ ...fresh, created_at: row.created_at });
        } catch {
          // Fetch failed: only trust the payload if it is not older than what
          // we already stored.
          const eventMs = (event.created ?? 0) * 1000;
          if (eventMs >= new Date(row.updated_at).getTime()) {
            const flags = {
              charges_enabled: acct.charges_enabled ?? false,
              payouts_enabled: acct.payouts_enabled ?? false,
              details_submitted: acct.details_submitted ?? false,
            };
            await driver.upsertConnectAccount({
              ...row,
              ...flags,
              status: deriveStatus(flags),
              simulated: false,
            });
          }
        }
      }
    }
    return NextResponse.json({ received: true });
  }

  const INTENT_STATUS: Record<string, PaymentStatus> = {
    "payment_intent.succeeded": "captured",
    "payment_intent.processing": "pending",
    "payment_intent.payment_failed": "requires_action",
    "payment_intent.canceled": "canceled",
  };
  const mapped = event.type ? INTENT_STATUS[event.type] : undefined;
  const intent = event.data?.object;
  // Unknown event types, or a malformed intent event, are acknowledged and ignored.
  if (!mapped || !intent?.id) return NextResponse.json({ received: true });

  // Connect events always name the account they happened on.
  if (!event.account) {
    return NextResponse.json({ received: true, ignored: "no_account" });
  }

  const driver = getPosDriver();
  const matched =
    (await driver.getPaymentByChargeId(intent.id)) ??
    (intent.metadata?.payment_id
      ? await driver.getPayment(intent.metadata.payment_id)
      : null);

  // Unknown tender: ack with 200 (a retry may arrive before the row exists).
  if (!matched || (matched.charge_id && matched.charge_id !== intent.id)) {
    console.info(`[stripe-webhook] ${event.type} for unknown intent ${intent.id}`);
    return NextResponse.json({ received: true, ignored: "unknown_payment" });
  }

  if (event.account !== matched.connect_account_id) {
    captureError(new Error("stripe webhook account mismatch"), {
      scope: "stripe-webhook",
      paymentId: matched.id,
      eventAccount: event.account,
    });
    return NextResponse.json({ received: true, ignored: "account_mismatch" });
  }

  const expectedAmount = matched.amount_cents + matched.tip_cents;
  if (
    intent.amount !== expectedAmount ||
    (intent.currency ?? "").toLowerCase() !== matched.currency.toLowerCase()
  ) {
    captureError(new Error("stripe webhook amount/currency mismatch"), {
      scope: "stripe-webhook",
      paymentId: matched.id,
      expectedAmount,
      eventAmount: intent.amount,
    });
    return NextResponse.json({ received: true, ignored: "amount_mismatch" });
  }

  await applyRailStatus(
    matched.id,
    mapped,
    mapped === "requires_action"
      ? { raw: { last_error: intent.last_payment_error?.message ?? null } }
      : {},
  );

  return NextResponse.json({ received: true });
}
