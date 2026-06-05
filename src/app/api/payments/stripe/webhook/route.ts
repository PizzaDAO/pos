/**
 * Stripe webhook handler (Phase 2).
 *
 * POST /api/payments/stripe/webhook — receives PaymentIntent lifecycle events
 * (payment_intent.succeeded / .payment_failed / .canceled) and updates the
 * matching tender's status via the DB abstraction, then marks the order paid if
 * covered. The raw body signature is verified with STRIPE_WEBHOOK_SECRET when
 * present; with no secret the handler is a no-op (200) so the route is harmless
 * in the preview. We match the tender by the PaymentIntent id (charge_id).
 */
import { NextResponse } from "next/server";
import { getPosDriver } from "@/lib/db";
import type { PaymentStatus } from "@/lib/db";
import { verifyStripeWebhook, mapIntentStatus } from "@/lib/payments/providers/stripe-client";
import { isStripeConfigured } from "@/lib/payments/env";
import { refreshPaymentStatus } from "@/lib/payments/service";

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

  let event: { type?: string; data?: { object?: { id?: string; status?: string } } };
  try {
    event = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
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
