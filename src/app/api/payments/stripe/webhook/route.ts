/**
 * Stripe webhook handler (Phase 2).
 *
 * POST /api/payments/stripe/webhook — receives PaymentIntent lifecycle events
 * (payment_intent.succeeded / .payment_failed / .canceled) and updates the
 * matching tender's status via the DB abstraction, then marks the order paid if
 * covered. The raw body signature is verified with STRIPE_WEBHOOK_SECRET when
 * present; with no secret the handler is a no-op (200) so the route is harmless
 * in the preview. We match the tender by the PaymentIntent id (charge_id).
 *
 * Also handles the Connect event `account.updated`: the connected account's
 * onboarding/charges status is synced onto our connect_accounts row (matched by
 * Stripe account id) so card payments unlock as soon as KYC completes.
 */
import { NextResponse } from "next/server";
import { getPosDriver } from "@/lib/db";
import type { PaymentStatus } from "@/lib/db";
import { verifyStripeWebhook, mapIntentStatus } from "@/lib/payments/providers/stripe-client";
import { isStripeConfigured } from "@/lib/payments/env";
import { refreshPaymentStatus } from "@/lib/payments/service";
import { deriveStatus } from "@/lib/payments/connect";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const rawBody = await request.text();

  // No secret configured → simulated/no-op; acknowledge so retries stop.
  if (!isStripeConfigured()) {
    return NextResponse.json({ received: true, simulated: true });
  }

  const signature = request.headers.get("stripe-signature");
  if (!verifyStripeWebhook(rawBody, signature)) {
    return NextResponse.json(
      { error: "Invalid signature." },
      { status: 400 },
    );
  }

  let event: {
    type?: string;
    data?: {
      object?: {
        id?: string;
        status?: string;
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
    return NextResponse.json({ received: true });
  }

  const intentId = event.data?.object?.id;
  if (!intentId) return NextResponse.json({ received: true });

  // Find the tender by its Stripe PaymentIntent id and update its status, then
  // re-evaluate the order's paid state.
  const driver = getPosDriver();
  const stripeStatus = event.data?.object?.status ?? "";
  const mapped: PaymentStatus = mapIntentStatus(stripeStatus);

  const matched = await driver.getPaymentByChargeId(intentId);
  if (matched) {
    await driver.upsertPayment({ ...matched, status: mapped });
    await refreshPaymentStatus(matched.id);
  }

  return NextResponse.json({ received: true });
}
