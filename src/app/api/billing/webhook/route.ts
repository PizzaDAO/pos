/**
 * Stripe Billing webhook — POST /api/billing/webhook (Phase 6).
 *
 * Receives subscription lifecycle events (checkout.session.completed,
 * customer.subscription.updated/deleted, invoice.payment_failed → dunning) and
 * reconciles the persisted subscription via the DB abstraction. In real billing
 * mode this verified webhook is the only writer of a subscription's tier.
 *
 * Signature verification uses STRIPE_BILLING_WEBHOOK_SECRET. With no secret
 * (default, incl. preview) the route is a guarded no-op that returns 200 so the
 * deployment is healthy without any billing configuration — the simulated path
 * advances subscription lifecycle in-app instead.
 */
import { NextResponse } from "next/server";
import { verifyStripeWebhook } from "@/lib/payments/providers/stripe-client";
import { getBillingWebhookSecret } from "@/lib/billing/env";
import { applyBillingEvent, type BillingEvent } from "@/lib/billing/webhook";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const secret = getBillingWebhookSecret();
  const raw = await request.text();

  // No billing secret configured → simulated mode. Acknowledge so the endpoint
  // is healthy; lifecycle is driven in-app, not by Stripe.
  if (!secret) {
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

  // The ONLY place a real subscription's tier/status is written.
  await applyBillingEvent(event);

  return NextResponse.json({ received: true });
}
