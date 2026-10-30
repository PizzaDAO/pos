/**
 * Apply a VERIFIED Stripe Billing event to the persisted subscription.
 *
 * This is the only place a REAL subscription's tier/status is set. Every
 * relevant event re-fetches the subscription from Stripe and applies its
 * CURRENT state (tier derived from its Stripe Price, falling back to the
 * `tier` metadata our server set) — never the possibly-stale event payload.
 * Callers must verify the signature first (see the billing webhook route).
 */
import {
  getPosDriver,
  type PlanTier,
  type Subscription,
  type SubscriptionStatus,
} from "@/lib/db";
import { tierForPriceId } from "./service";
import { stripeGet } from "@/lib/payments/providers/stripe-client";

export interface BillingEvent {
  type?: string;
  /** Unix seconds when Stripe created the event (recorded, informational). */
  created?: number;
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

/**
 * Checkout completed but payment is still processing (e.g. bank debits):
 * don't treat it as a paid subscription until Stripe says so.
 */
function checkoutIsPaid(obj: Obj): boolean {
  const ps = asStr(obj.payment_status);
  return ps === "paid" || ps === "no_payment_required";
}

/** First subscription item (newer API versions carry the period there). */
function firstItem(obj: Obj): Obj | undefined {
  const data = asObj(obj.items)?.data;
  return Array.isArray(data) ? asObj(data[0]) : undefined;
}

/** The Stripe subscription id an event refers to, if any. */
function subscriptionIdOf(type: string, obj: Obj): string | null {
  if (type.startsWith("customer.subscription.")) return asStr(obj.id);
  const direct = asStr(obj.subscription);
  if (direct) return direct;
  const details =
    asObj(obj.subscription_details) ??
    asObj(asObj(obj.parent)?.subscription_details);
  return asStr(details?.subscription);
}

/** Checkout Session events the billing webhook handles. */
const SESSION_EVENTS = new Set([
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
  "checkout.session.expired",
]);

/** Fetch the CURRENT subscription from Stripe (authoritative state). */
export type SubscriptionFetcher = (subscriptionId: string) => Promise<Obj>;

const fetchFromStripe: SubscriptionFetcher = (id) =>
  stripeGet<Obj>(`/subscriptions/${encodeURIComponent(id)}`);

/**
 * Apply a verified billing event. For every subscription / invoice / paid
 * checkout event the subscription is RE-FETCHED from Stripe and that current
 * state (tier from its Price, status, period, cancel flag) is applied — so
 * out-of-order or replayed deliveries can never roll state back, and no
 * cross-type ordering guard is needed. A fetch failure throws (the webhook
 * answers 5xx and Stripe retries).
 */
export async function applyBillingEvent(
  event: BillingEvent,
  fetchSubscription: SubscriptionFetcher = fetchFromStripe,
): Promise<Subscription | null> {
  const driver = getPosDriver();
  const type = event.type ?? "";
  const obj = event.data?.object ?? {};

  const relevant =
    type.startsWith("customer.subscription.") ||
    type.startsWith("invoice.") ||
    SESSION_EVENTS.has(type);
  if (!relevant) return null;
  const isSession = type.startsWith("checkout.session.");

  // checkout.session.*: accepted ONLY for the session the billing route
  // recorded as the tenant's open one — a second (double-subscribe) or stale
  // session can never activate or overwrite the plan.
  let sessionTenant: string | null = null;
  let sessionId: string | null = null;
  if (isSession) {
    sessionId = asStr(obj.id);
    sessionTenant = tenantIdOf(obj);
    if (!sessionId || !sessionTenant) return null;
    const pending = await driver.getPendingBillingCheckout(sessionTenant);
    if (!pending || pending.session_id !== sessionId) return null;
    if (
      type === "checkout.session.expired" ||
      type === "checkout.session.async_payment_failed"
    ) {
      // The open session can no longer be paid: allow a new checkout.
      await driver.clearPendingBillingCheckout(sessionTenant, sessionId);
      return null;
    }
    if (!checkoutIsPaid(obj)) return null;
  }

  const subscriptionId = subscriptionIdOf(type, obj);
  if (!subscriptionId) return null;
  const live = await fetchSubscription(subscriptionId);

  // Tenant: our server-set metadata on the subscription (then the event).
  const tenantId = tenantIdOf(live) ?? tenantIdOf(obj);
  if (!tenantId) return null;
  // A recorded session must belong to the subscription's tenant.
  if (isSession && tenantId !== sessionTenant) return null;
  const existing = await driver.getSubscription(tenantId);
  if (
    existing?.stripe_subscription_id &&
    existing.stripe_subscription_id !== subscriptionId &&
    !isSession
  ) {
    // An event for a different (e.g. superseded) subscription — ignore.
    return existing;
  }

  const tier = tierOf(live) ?? tierOf(obj) ?? existing?.tier ?? null;
  if (!tier) return existing;
  const now = new Date().toISOString();
  const status =
    mapStripeSubscriptionStatus(String(live.status ?? "")) ??
    existing?.status ??
    "past_due";

  const row: Subscription = {
    id: existing?.id ?? `sub_${tenantId}`,
    tenant_id: tenantId,
    tier,
    status,
    current_period_end:
      isoFromUnix(live.current_period_end) ??
      isoFromUnix(firstItem(live)?.current_period_end) ??
      existing?.current_period_end ??
      now,
    trial_end: isoFromUnix(live.trial_end),
    cancel_at_period_end: live.cancel_at_period_end === true,
    simulated: false,
    stripe_customer_id:
      asStr(live.customer) ??
      asStr(obj.customer) ??
      existing?.stripe_customer_id ??
      null,
    stripe_subscription_id: subscriptionId,
    last_event_created:
      typeof event.created === "number"
        ? event.created
        : (existing?.last_event_created ?? null),
    created_at: existing?.created_at ?? now,
    updated_at: now,
  };
  const saved = await driver.upsertSubscription(row);
  if (isSession && sessionId) {
    // That checkout is done: the next subscribe starts fresh.
    await driver.clearPendingBillingCheckout(tenantId, sessionId);
    // Plan step of the signup wizard completes once Stripe confirms payment.
    await driver.completeOnboardingStep(tenantId, "plan").catch(() => null);
  }
  return saved;
}
