/**
 * Subscription-billing environment guard (Phase 6).
 *
 * Stripe BILLING (we charge tenants a subscription) is distinct from Stripe
 * CONNECT (tenants charge their customers). Billing reuses the same
 * STRIPE_SECRET_KEY but additionally needs Price ids per tier to run REAL
 * Checkout/Subscription flows. With no key — or no price ids — the whole billing
 * layer runs SIMULATED: subscriptions live in the mock driver and lifecycle is
 * advanced in-memory, so previews work credential-free.
 *
 * Nothing here reads env at module load; every read is lazy inside a function.
 */
import { isStripeConfigured } from "@/lib/payments/env";

/**
 * Billing is "real" only when Stripe is configured AND at least one tier Price
 * id is present. Otherwise the simulated path is used. Kept conservative so a
 * half-configured environment doesn't attempt real charges.
 */
export function isBillingConfigured(): boolean {
  if (!isStripeConfigured()) return false;
  return Boolean(
    process.env.STRIPE_PRICE_STARTER ||
      process.env.STRIPE_PRICE_PRO ||
      process.env.STRIPE_PRICE_MULTI,
  );
}

/** Webhook secret for the Stripe Billing webhook (separate from payments). */
export function getBillingWebhookSecret(): string | null {
  return process.env.STRIPE_BILLING_WEBHOOK_SECRET ?? null;
}

/** True when running the simulated billing path (no live keys/prices). */
export function isBillingSimulated(): boolean {
  return !isBillingConfigured();
}
