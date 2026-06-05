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

/** Map a Stripe subscription status to ours. */
function mapStatus(stripeStatus: string): SubscriptionStatus {
  switch (stripeStatus) {
    case "trialing":
      return "trialing";
    case "active":
      return "active";
    case "past_due":
    case "unpaid":
      return "past_due";
    case "canceled":
    case "incomplete_expired":
      return "canceled";
    default:
      return "active";
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

  const sig = request.headers.get("stripe-signature");
  if (!verifyStripeWebhook(raw, sig)) {
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
      const status =
        event.type === "invoice.payment_failed"
          ? "past_due"
          : event.type === "customer.subscription.deleted"
            ? "canceled"
            : mapStatus(String(obj.status ?? "active"));
      await driver.advanceSubscriptionStatus(tenantId, status);
    }
  }

  return NextResponse.json({ received: true });
}
