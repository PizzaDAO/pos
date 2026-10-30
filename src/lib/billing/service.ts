/**
 * Subscription billing service (Phase 6) — Stripe Billing, env-guarded.
 *
 * This is OUR revenue: we charge each tenant a monthly subscription. It is
 * completely separate from Connect (the tenant's own card revenue).
 *
 * REAL path (isBillingConfigured()): creates a Stripe Customer + a Checkout
 * Session in subscription mode for the chosen Price; a webhook later flips the
 * persisted subscription to `active`. Implemented against the thin Stripe REST
 * client (no SDK) so the bundle still builds with zero env vars.
 *
 * SIMULATED path (default, incl. preview): builds a deterministic in-memory
 * subscription (trialing → active) with `sim_*` ids and NO external calls, so
 * the plan picker + gating + /platform billing overview all work credential-free.
 *
 * Persistence is via the DB abstraction (mock driver) in the calling route; this
 * module only builds subscription rows / talks to Stripe.
 */
import type { PlanTier, Subscription } from "@/lib/db/saas-types";
import { getPlan, getPlans } from "@/lib/saas/plans";
import {
  stripeGet,
  stripeRequest,
} from "@/lib/payments/providers/stripe-client";
import { isBillingConfigured, isBillingSimulated } from "./env";

function nowIso(): string {
  return new Date().toISOString();
}

function addDays(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

/** Stable simulated id derived from a tenant id (deterministic for previews). */
function simId(prefix: string, tenantId: string): string {
  return `${prefix}_sim_${tenantId.replace(/-/g, "").slice(0, 16)}`;
}

/**
 * Build a SIMULATED subscription row for a tenant on a tier. Starts in
 * `trialing` if the plan has a trial, else `active`. period end = 1 month out.
 */
export function simulatedSubscription(
  tenantId: string,
  tier: PlanTier,
): Subscription {
  const plan = getPlan(tier);
  const trialing = plan.trial_days > 0;
  return {
    id: simId("sub", tenantId),
    tenant_id: tenantId,
    tier,
    status: trialing ? "trialing" : "active",
    current_period_end: addDays(trialing ? plan.trial_days : 30),
    trial_end: trialing ? addDays(plan.trial_days) : null,
    cancel_at_period_end: false,
    simulated: true,
    stripe_customer_id: simId("cus", tenantId),
    stripe_subscription_id: simId("sub_stripe", tenantId),
    created_at: nowIso(),
    updated_at: nowIso(),
  };
}

/** The plan tier whose Stripe Price id is `priceId`, or null if unknown. */
export function tierForPriceId(priceId: unknown): PlanTier | null {
  if (typeof priceId !== "string" || !priceId) return null;
  return getPlans().find((p) => p.stripe_price_id === priceId)?.tier ?? null;
}

/**
 * REAL mode: ask Stripe to move an existing subscription to another tier's
 * Price. The local tier is NOT changed here — it is applied only when the
 * signed `customer.subscription.updated` webhook arrives (see
 * `applyBillingEvent`), so a tenant can never upgrade without Stripe billing it.
 */
export async function requestStripeTierChange(input: {
  tenantId: string;
  stripeSubscriptionId: string;
  tier: PlanTier;
}): Promise<void> {
  const plan = getPlan(input.tier);
  if (!plan.stripe_price_id) {
    throw new Error(`No Stripe Price configured for the ${plan.name} plan.`);
  }
  const sub = await stripeGet<{ items?: { data?: { id: string }[] } }>(
    `/subscriptions/${encodeURIComponent(input.stripeSubscriptionId)}`,
  );
  const itemId = sub.items?.data?.[0]?.id;
  if (!itemId) throw new Error("Stripe subscription has no items.");
  await stripeRequest(
    `/subscriptions/${encodeURIComponent(input.stripeSubscriptionId)}`,
    {
      "items[0][id]": itemId,
      "items[0][price]": plan.stripe_price_id,
      proration_behavior: "create_prorations",
      "metadata[tenant_id]": input.tenantId,
      "metadata[tier]": input.tier,
    },
  );
}

/** Result of starting a subscription. */
export interface SubscribeResult {
  /**
   * Simulated: the ready subscription to persist. REAL: null — nothing that
   * grants a tier is persisted until the verified billing webhook confirms it.
   */
  subscription: Subscription | null;
  /** Hosted Stripe Checkout URL in REAL mode; null when simulated. */
  checkoutUrl: string | null;
  simulated: boolean;
  /** REAL only: the Checkout Session opened (recorded as the pending one). */
  checkoutSession?: { id: string; expiresAt: string };
}

/**
 * Subscribe a tenant to a tier. In simulated mode returns a ready subscription;
 * in real mode creates a Stripe Customer + Checkout Session and returns its URL.
 * Real mode persists NOTHING locally: the subscription row (tier + status) is
 * created by the signed billing webhook once Stripe confirms checkout.
 */
export async function subscribeTenant(input: {
  tenantId: string;
  tier: PlanTier;
  ownerEmail: string;
  existing?: Subscription | null;
  successUrl: string;
  cancelUrl: string;
}): Promise<SubscribeResult> {
  if (isBillingSimulated()) {
    return {
      subscription: simulatedSubscription(input.tenantId, input.tier),
      checkoutUrl: null,
      simulated: true,
    };
  }

  const plan = getPlan(input.tier);
  if (!plan.stripe_price_id) {
    throw new Error(`No Stripe Price configured for the ${plan.name} plan.`);
  }

  // Reuse the existing Stripe customer when re-subscribing/changing plans.
  let customerId = input.existing?.stripe_customer_id ?? null;
  if (!customerId) {
    const customer = await stripeRequest<{ id: string }>("/customers", {
      email: input.ownerEmail,
      metadata: { tenant_id: input.tenantId },
    });
    customerId = customer.id;
  }

  const session = await stripeRequest<{
    id: string;
    url: string;
    expires_at?: number;
  }>(
    "/checkout/sessions",
    {
      mode: "subscription",
      customer: customerId,
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      "line_items[0][price]": plan.stripe_price_id,
      "line_items[0][quantity]": 1,
      "subscription_data[trial_period_days]": plan.trial_days,
      "subscription_data[metadata][tenant_id]": input.tenantId,
      "subscription_data[metadata][tier]": input.tier,
      "metadata[tenant_id]": input.tenantId,
      "metadata[tier]": input.tier,
    },
  );

  return {
    subscription: null,
    checkoutUrl: session.url,
    simulated: false,
    checkoutSession: {
      id: session.id,
      // Stripe's default session lifetime is 24h.
      expiresAt: new Date(
        typeof session.expires_at === "number"
          ? session.expires_at * 1000
          : Date.now() + 24 * 60 * 60 * 1000,
      ).toISOString(),
    },
  };
}

/**
 * Expire an open Checkout Session at Stripe so it can no longer be paid.
 * Throws if Stripe refuses (e.g. the session already completed).
 */
export async function expireBillingCheckout(sessionId: string): Promise<void> {
  await stripeRequest(
    `/checkout/sessions/${encodeURIComponent(sessionId)}/expire`,
    {},
  );
}

export { isBillingConfigured, isBillingSimulated };
