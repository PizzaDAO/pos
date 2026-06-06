/**
 * Subscription billing — /api/billing (Phase 6, Stripe Billing).
 *
 * OUR revenue: tenants subscribe to a plan tier. Separate from Connect (the
 * tenant's own card revenue). Real Stripe Checkout is behind an env guard
 * (isBillingConfigured); with no keys/prices a SIMULATED subscription is created
 * in the mock driver so the plan picker + gating + /platform billing all work.
 *
 * GET  ?tenantId=  → plans catalogue + the tenant's current subscription +
 *      resolved entitlements + simulated flag.
 * POST { action, tenantId, tier?, status? }:
 *   subscribe → start/switch a subscription (returns checkoutUrl in real mode)
 *   set_status → advance a SIMULATED subscription's lifecycle (demo dunning)
 */
import { NextResponse } from "next/server";
import { getPosDriver, type PlanTier, type SubscriptionStatus } from "@/lib/db";
import { getPlans } from "@/lib/saas/plans";
import { resolveEntitlements } from "@/lib/saas/entitlements";
import { subscribeTenant, isBillingSimulated } from "@/lib/billing/service";
import { getCurrentUser } from "@/lib/auth/session";
import { recordAudit } from "@/lib/security";

export const runtime = "nodejs";

/** Best-effort tenant-scoped audit of a subscription/billing change. */
async function auditBilling(tenantId: string, detail: string): Promise<void> {
  const actor = await getCurrentUser();
  await recordAudit({
    actor: {
      id: actor?.id ?? "system",
      label: actor?.email ?? "billing",
    },
    action: "subscription_change",
    tenantId,
    detail,
  });
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const tenantId = searchParams.get("tenantId");
  const driver = getPosDriver();
  const plans = getPlans();
  const subscription = tenantId ? await driver.getSubscription(tenantId) : null;
  const entitlements = resolveEntitlements(subscription);
  return NextResponse.json({
    plans,
    subscription,
    entitlements,
    simulated: isBillingSimulated(),
  });
}

interface BillingBody {
  action: "subscribe" | "set_status";
  tenantId?: string;
  tier?: PlanTier;
  status?: SubscriptionStatus;
}

export async function POST(request: Request) {
  let body: BillingBody;
  try {
    body = (await request.json()) as BillingBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (!body.tenantId) {
    return NextResponse.json(
      { error: "tenantId is required." },
      { status: 422 },
    );
  }
  const driver = getPosDriver();

  try {
    if (body.action === "set_status") {
      if (!body.status) {
        return NextResponse.json(
          { error: "status is required." },
          { status: 422 },
        );
      }
      const updated = await driver.advanceSubscriptionStatus(
        body.tenantId,
        body.status,
      );
      if (!updated) {
        return NextResponse.json(
          { error: "No subscription to update." },
          { status: 404 },
        );
      }
      await auditBilling(
        body.tenantId,
        `Subscription status advanced to ${body.status}.`,
      );
      return NextResponse.json({ subscription: updated });
    }

    // subscribe
    if (!body.tier) {
      return NextResponse.json({ error: "tier is required." }, { status: 422 });
    }
    const tenant = await driver.getTenant(body.tenantId);
    if (!tenant) {
      return NextResponse.json({ error: "Tenant not found." }, { status: 404 });
    }
    const existing = await driver.getSubscription(body.tenantId);

    // Already subscribed? Switching tier is a tier change, not a new checkout.
    if (existing && existing.tier !== body.tier) {
      const switched = await driver.changeSubscriptionTier(
        body.tenantId,
        body.tier,
      );
      // Mark the plan step complete on the wizard if mid-onboarding.
      await driver.completeOnboardingStep(body.tenantId, "plan");
      await auditBilling(
        body.tenantId,
        `Subscription tier changed ${existing.tier} → ${body.tier}.`,
      );
      return NextResponse.json({
        subscription: switched,
        checkoutUrl: null,
        simulated: isBillingSimulated(),
      });
    }
    if (existing && existing.tier === body.tier) {
      await driver.completeOnboardingStep(body.tenantId, "plan");
      return NextResponse.json({
        subscription: existing,
        checkoutUrl: null,
        simulated: isBillingSimulated(),
      });
    }

    const origin = new URL(request.url).origin;
    // Resolve the owner email for a real Stripe customer (best-effort).
    const ownerEmail = `owner+${tenant.slug}@example.com`;
    const result = await subscribeTenant({
      tenantId: body.tenantId,
      tier: body.tier,
      ownerEmail,
      existing,
      successUrl: `${origin}/signup?tenant=${body.tenantId}&billing=success`,
      cancelUrl: `${origin}/signup?tenant=${body.tenantId}&billing=cancel`,
    });
    const subscription = await driver.upsertSubscription(result.subscription);
    await driver.completeOnboardingStep(body.tenantId, "plan");
    await auditBilling(
      body.tenantId,
      `Subscribed to ${body.tier} plan${result.simulated ? " (simulated)" : ""}.`,
    );

    return NextResponse.json({
      subscription,
      checkoutUrl: result.checkoutUrl,
      simulated: result.simulated,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Billing action failed." },
      { status: 500 },
    );
  }
}
