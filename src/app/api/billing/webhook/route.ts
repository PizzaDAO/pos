/**
 * Stripe Billing webhook — POST /api/billing/webhook (Phase 6).
 *
 * Receives subscription lifecycle events (checkout.session.completed,
 * customer.subscription.updated/deleted, invoice.payment_failed → dunning) and
 * reconciles the persisted subscription via the DB abstraction.
 *
 * Signature verification uses STRIPE_BILLING_WEBHOOK_SECRET. With no secret
 * (default, incl. preview) the route is a guarded no-op that returns 200 so the
 * deployment is healthy without any billing configuration — the simulated path
 * advances subscription lifecycle in-app instead.
 */
import { NextResponse } from "next/server";
import { getPosDriver, type SubscriptionStatus } from "@/lib/db";
import { verifyStripeWebhook } from "@/lib/payments/providers/stripe-client";
import { getBillingWebhookSecret } from "@/lib/billing/env";

export const runtime = "nodejs";

/**
 * Map a Stripe subscription status to ours. Not-yet-paid statuses (e.g.
 * `incomplete`) must NOT grant an active plan; unknown statuses return null
 * (leave the stored status unchanged) instead of defaulting to active.
 */
function mapStatus(stripeStatus: string): SubscriptionStatus | null {
  switch (stripeStatus) {
    case "trialing":
      return "trialing";
    case "active":
      return "active";
    case "past_due":
    case "unpaid":
    case "incomplete":
      return "past_due";
    case "canceled":
    case "incomplete_expired":
      return "canceled";
    default:
      return null;
  }
}

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

  let event: { type?: string; data?: { object?: Record<string, unknown> } };
  try {
    event = JSON.parse(raw) as typeof event;
  } catch {
    return NextResponse.json({ error: "Invalid payload." }, { status: 400 });
  }

  const driver = getPosDriver();
  const obj = event.data?.object ?? {};
  const tenantId =
    ((obj.metadata as Record<string, string> | undefined)?.tenant_id ?? null) ||
    null;

  if (tenantId) {
    const existing = await driver.getSubscription(tenantId);
    if (existing) {
      let status: SubscriptionStatus | null;
      switch (event.type) {
        case "invoice.payment_failed":
          status = "past_due";
          break;
        case "customer.subscription.deleted":
          status = "canceled";
          break;
        case "checkout.session.completed":
        case "invoice.paid":
          status = "active";
          break;
        default:
          status = mapStatus(String(obj.status ?? ""));
      }
      if (status) await driver.advanceSubscriptionStatus(tenantId, status);
    }
  }

  return NextResponse.json({ received: true });
}
