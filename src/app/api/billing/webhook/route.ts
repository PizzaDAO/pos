/**
 * Stripe Billing webhook — POST /api/billing/webhook (Phase 6).
 *
 * Receives subscription lifecycle events (checkout.session.completed,
 * customer.subscription.updated/deleted, invoice.payment_failed → dunning) and
 * reconciles the persisted subscription via the DB abstraction. In real billing
 * mode this verified webhook is the only writer of a subscription's tier.
 *
 * Signature verification uses STRIPE_BILLING_WEBHOOK_SECRET. With no secret
 * AND billing simulated (default, incl. preview) the route is a guarded no-op
 * that returns 200 so the deployment is healthy without any billing
 * configuration — the simulated path advances subscription lifecycle in-app.
 * With REAL billing configured but no secret it answers 503 (and logs) so
 * Stripe keeps retrying until the secret is set.
 */
import { NextResponse } from "next/server";
import { verifyStripeWebhook } from "@/lib/payments/providers/stripe-client";
import {
  getBillingWebhookSecret,
  isBillingConfigured,
} from "@/lib/billing/env";
import { childLogger } from "@/lib/observability";
import { applyBillingEvent, type BillingEvent } from "@/lib/billing/webhook";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const secret = getBillingWebhookSecret();
  const raw = await request.text();

  if (!secret) {
    // REAL billing (live keys + prices) but no webhook secret: a deploy
    // misconfiguration. Never ack as "simulated" — Stripe would drop the event
    // and paid checkouts would never activate. Answer 5xx (Stripe retries) and
    // log loudly.
    if (isBillingConfigured()) {
      childLogger({ route: "POST /api/billing/webhook" }).error(
        "billing_webhook_secret_missing",
        {
          detail:
            "STRIPE_BILLING_WEBHOOK_SECRET is unset while real billing is configured; refusing the event.",
        },
      );
      return NextResponse.json(
        { error: "Billing webhook is not configured." },
        { status: 503 },
      );
    }
    // Simulated mode. Acknowledge so the endpoint is healthy; lifecycle is
    // driven in-app, not by Stripe.
    return NextResponse.json({ received: true, simulated: true });
  }

  // Verify against the BILLING endpoint's own signing secret (not the Connect
  // payments secret), with Stripe's timestamp tolerance.
  const sig = request.headers.get("stripe-signature");
  if (!verifyStripeWebhook(raw, sig, secret)) {
    return NextResponse.json({ error: "Invalid signature." }, { status: 400 });
  }

  let event: BillingEvent;
  try {
    event = JSON.parse(raw) as BillingEvent;
  } catch {
    return NextResponse.json({ error: "Invalid payload." }, { status: 400 });
  }

  // The ONLY place a real subscription's tier/status is written. It re-fetches
  // the subscription from Stripe; on failure answer 5xx so Stripe retries.
  try {
    await applyBillingEvent(event);
  } catch {
    return NextResponse.json({ error: "Could not apply event." }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}
