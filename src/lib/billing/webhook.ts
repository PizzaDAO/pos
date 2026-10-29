/**
 * Apply a VERIFIED Stripe Billing event to the persisted subscription.
 *
 * This is the only place a REAL subscription's tier is set: checkout
 * completion creates the row, and `customer.subscription.created/updated`
 * apply the tier derived from the subscription's Stripe Price (falling back to
 * the `tier` metadata our server set on the Checkout Session / subscription).
 * Callers must verify the signature first (see the billing webhook route).
 */
import {
  getPosDriver,
  type PlanTier,
  type Subscription,
  type SubscriptionStatus,
} from "@/lib/db";
import { tierForPriceId } from "./service";

export interface BillingEvent {
  type?: string;
  data?: { object?: Record<string, unknown> };
}

const TIERS: PlanTier[] = ["starter", "pro", "multi"];

/**
 * Map a Stripe subscription status to ours. Not-yet-paid statuses (e.g.
 * `incomplete`) must NOT grant an active plan; unknown statuses return null
 * (leave the stored status unchanged) instead of defaulting to active.
 */
export function mapStripeSubscriptionStatus(
  stripeStatus: string,
): SubscriptionStatus | null {
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

type Obj = Record<string, unknown>;
const asObj = (v: unknown): Obj | undefined =>
  v && typeof v === "object" ? (v as Obj) : undefined;
const asStr = (v: unknown): string | null =>
  typeof v === "string" && v ? v : null;

/** tenant_id from the object, or (invoices) from its subscription details. */
function tenantIdOf(obj: Obj): string | null {
  const direct = asStr(asObj(obj.metadata)?.tenant_id);
  if (direct) return direct;
  const details =
    asObj(obj.subscription_details) ??
    asObj(asObj(obj.parent)?.subscription_details);
  return asStr(asObj(details?.metadata)?.tenant_id);
}

/** Tier from the subscription's first item Price, else trusted metadata. */
function tierOf(obj: Obj): PlanTier | null {
  const items = asObj(obj.items)?.data;
  if (Array.isArray(items)) {
    const price = asObj(asObj(items[0])?.price);
    const fromPrice = tierForPriceId(price?.id);
    if (fromPrice) return fromPrice;
  }
  const meta = asStr(asObj(obj.metadata)?.tier);
  return meta && TIERS.includes(meta as PlanTier) ? (meta as PlanTier) : null;
}

function isoFromUnix(v: unknown): string | null {
  return typeof v === "number" && Number.isFinite(v)
    ? new Date(v * 1000).toISOString()
    : null;
}

export async function applyBillingEvent(
  event: BillingEvent,
): Promise<Subscription | null> {
  const driver = getPosDriver();
  const obj = event.data?.object ?? {};
  const tenantId = tenantIdOf(obj);
  if (!tenantId) return null;
  const existing = await driver.getSubscription(tenantId);
  const now = new Date().toISOString();

  switch (event.type) {
    case "checkout.session.completed":
    case "customer.subscription.created":
    case "customer.subscription.updated": {
      const isSession = event.type === "checkout.session.completed";
      const tier = tierOf(obj) ?? existing?.tier ?? null;
      if (!tier) return existing;
      const status: SubscriptionStatus | null = isSession
        ? // Checkout completed: trial or paid; the subscription.* events
          // that follow carry the precise status.
          (existing?.status ?? "active")
        : mapStripeSubscriptionStatus(String(obj.status ?? ""));
      const row: Subscription = {
        id: existing?.id ?? `sub_${tenantId}`,
        tenant_id: tenantId,
        tier,
        status: status ?? existing?.status ?? "past_due",
        current_period_end:
          isoFromUnix(obj.current_period_end) ??
          existing?.current_period_end ??
          now,
        trial_end: isSession
          ? (existing?.trial_end ?? null)
          : isoFromUnix(obj.trial_end),
        cancel_at_period_end: isSession
          ? (existing?.cancel_at_period_end ?? false)
          : obj.cancel_at_period_end === true,
        simulated: false,
        stripe_customer_id:
          asStr(obj.customer) ?? existing?.stripe_customer_id ?? null,
        stripe_subscription_id:
          (isSession ? asStr(obj.subscription) : asStr(obj.id)) ??
          existing?.stripe_subscription_id ??
          null,
        created_at: existing?.created_at ?? now,
        updated_at: now,
      };
      const saved = await driver.upsertSubscription(row);
      if (isSession) {
        // Plan step of the signup wizard completes once Stripe confirms.
        await driver.completeOnboardingStep(tenantId, "plan").catch(() => null);
      }
      return saved;
    }
    case "invoice.payment_failed":
      return existing
        ? driver.advanceSubscriptionStatus(tenantId, "past_due")
        : null;
    case "customer.subscription.deleted":
      return existing
        ? driver.advanceSubscriptionStatus(tenantId, "canceled")
        : null;
    case "invoice.paid":
      return existing
        ? driver.advanceSubscriptionStatus(tenantId, "active")
        : null;
    default:
      return existing;
  }
}
