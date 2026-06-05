/**
 * Plan gating / entitlements (Phase 6).
 *
 * A single server-side source of truth for "what is this tenant allowed to do",
 * derived from their subscription tier + lifecycle status. Both the API routes
 * and the UI (`useEntitlements`) consult this so gating is consistent.
 *
 * Two layers:
 *   1. PLAN — the tier's feature flags + numeric limits (`@/lib/saas/plans`).
 *   2. STATUS — a `canceled` subscription downgrades to a read-only/blocked
 *      state regardless of tier (dunning + lapse handling).
 *
 * Pure functions over the persisted subscription; no env reads, no I/O.
 */
import type {
  Plan,
  PlanEntitlements,
  Subscription,
} from "@/lib/db/saas-types";
import { DEFAULT_TIER, getPlan } from "./plans";

/**
 * The resolved entitlement set for a tenant. `active` is false when the
 * subscription has lapsed (canceled) — features that require an active sub are
 * blocked even if the (former) tier allowed them.
 */
export interface Entitlements {
  tier: Plan["tier"];
  plan_name: string;
  /** Subscription is in good standing (trialing / active / past_due-grace). */
  active: boolean;
  /** Effective feature flags + limits after applying status. */
  entitlements: PlanEntitlements;
  /** True while in dunning (past_due) — a warning, not yet a block. */
  past_due: boolean;
  status: Subscription["status"] | "none";
}

/** Entitlements granted to a tenant with NO subscription yet (pre-checkout). */
function noSubscriptionEntitlements(): Entitlements {
  // Before subscribing, a tenant gets the Starter feature set so they can finish
  // onboarding (add their first location, set up a menu) — but online ordering /
  // advanced features stay gated until they pick a plan.
  const plan = getPlan(DEFAULT_TIER);
  return {
    tier: plan.tier,
    plan_name: plan.name,
    active: true,
    past_due: false,
    status: "none",
    entitlements: { ...plan.entitlements },
  };
}

/**
 * Compute the effective entitlements for a tenant from its subscription row.
 * A `canceled` subscription collapses all feature flags off + limits to the
 * current footprint's floor (read-only-ish), modelling a lapsed account.
 */
export function resolveEntitlements(
  subscription: Subscription | null,
): Entitlements {
  if (!subscription) return noSubscriptionEntitlements();

  const plan = getPlan(subscription.tier);
  const inGoodStanding =
    subscription.status === "trialing" ||
    subscription.status === "active" ||
    subscription.status === "past_due";

  if (!inGoodStanding) {
    // Canceled / lapsed: block paid features, clamp limits to 1 location.
    return {
      tier: plan.tier,
      plan_name: plan.name,
      active: false,
      past_due: false,
      status: subscription.status,
      entitlements: {
        max_locations: 1,
        online_ordering: false,
        advanced_reports: false,
        delivery: false,
        max_staff: 5,
      },
    };
  }

  return {
    tier: plan.tier,
    plan_name: plan.name,
    active: true,
    past_due: subscription.status === "past_due",
    status: subscription.status,
    entitlements: { ...plan.entitlements },
  };
}

/** Result of a gating check: allowed, or a reason the action is blocked. */
export interface GateResult {
  allowed: boolean;
  reason?: string;
}

const ok: GateResult = { allowed: true };

/** Can the tenant add another location given their current count? */
export function canAddLocation(
  ent: Entitlements,
  currentLocationCount: number,
): GateResult {
  if (!ent.active) {
    return {
      allowed: false,
      reason: "Subscription is inactive. Reactivate to add locations.",
    };
  }
  const max = ent.entitlements.max_locations;
  if (currentLocationCount >= max) {
    return {
      allowed: false,
      reason:
        max === 1
          ? `The ${ent.plan_name} plan includes a single location. Upgrade to add more.`
          : `The ${ent.plan_name} plan includes ${max} locations. Upgrade to add more.`,
    };
  }
  return ok;
}

/** Can the tenant add another staff seat given their current count? */
export function canAddStaff(
  ent: Entitlements,
  currentStaffCount: number,
): GateResult {
  if (!ent.active) {
    return { allowed: false, reason: "Subscription is inactive." };
  }
  const max = ent.entitlements.max_staff;
  if (currentStaffCount >= max) {
    return {
      allowed: false,
      reason: `The ${ent.plan_name} plan includes ${max} staff seats. Upgrade for more.`,
    };
  }
  return ok;
}

/** Is online ordering (/shop checkout) permitted on this plan? */
export function canUseOnlineOrdering(ent: Entitlements): GateResult {
  if (!ent.active) {
    return { allowed: false, reason: "Subscription is inactive." };
  }
  if (!ent.entitlements.online_ordering) {
    return {
      allowed: false,
      reason: `Online ordering requires the Pro plan or higher. The ${ent.plan_name} plan does not include it.`,
    };
  }
  return ok;
}

/** Are advanced reports (rollup / payment-mix / export) permitted? */
export function canUseAdvancedReports(ent: Entitlements): GateResult {
  if (!ent.active) {
    return { allowed: false, reason: "Subscription is inactive." };
  }
  if (!ent.entitlements.advanced_reports) {
    return {
      allowed: false,
      reason: `Advanced reports require the Pro plan or higher. The ${ent.plan_name} plan does not include them.`,
    };
  }
  return ok;
}
