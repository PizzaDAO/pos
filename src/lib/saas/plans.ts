/**
 * Subscription plan catalogue (Phase 6).
 *
 * The three tiers tenants subscribe to (OUR revenue via Stripe Billing) and the
 * feature entitlements each grants. Plan gating reads `plan.entitlements` to
 * allow/deny actions (e.g. adding a location beyond `max_locations`, toggling
 * online ordering, viewing advanced reports).
 *
 * In REAL billing mode each tier maps to a Stripe Price via env
 * (STRIPE_PRICE_STARTER / _PRO / _MULTI). Those reads happen lazily here so the
 * bundle still builds with no env vars; when unset the price id is null and the
 * billing layer runs SIMULATED.
 */
import type { Plan, PlanTier } from "@/lib/db/saas-types";

/** Resolve a tier's Stripe Price id from env (null in simulated mode). */
function priceIdFor(tier: PlanTier): string | null {
  switch (tier) {
    case "starter":
      return process.env.STRIPE_PRICE_STARTER ?? null;
    case "pro":
      return process.env.STRIPE_PRICE_PRO ?? null;
    case "multi":
      return process.env.STRIPE_PRICE_MULTI ?? null;
  }
}

/**
 * The plan catalogue. Built fresh per call so the (lazy) env-derived price ids
 * reflect the current environment — never read at module load.
 */
export function getPlans(): Plan[] {
  return [
    {
      tier: "starter",
      name: "Starter",
      blurb: "One location, in-store POS + kitchen display. Get selling fast.",
      price_cents: 4900,
      trial_days: 14,
      stripe_price_id: priceIdForSafe("starter"),
      entitlements: {
        max_locations: 1,
        online_ordering: false,
        advanced_reports: false,
        delivery: false,
        max_staff: 5,
      },
    },
    {
      tier: "pro",
      name: "Pro",
      blurb:
        "Online ordering + delivery + advanced reports. Up to 3 locations.",
      price_cents: 9900,
      trial_days: 14,
      stripe_price_id: priceIdForSafe("pro"),
      entitlements: {
        max_locations: 3,
        online_ordering: true,
        advanced_reports: true,
        delivery: true,
        max_staff: 25,
      },
    },
    {
      tier: "multi",
      name: "Multi-location",
      blurb: "Unlimited locations + staff. Everything in Pro, at scale.",
      price_cents: 19900,
      trial_days: 14,
      stripe_price_id: priceIdForSafe("multi"),
      entitlements: {
        max_locations: Infinity,
        online_ordering: true,
        advanced_reports: true,
        delivery: true,
        max_staff: Infinity,
      },
    },
  ];
}

/** Defensive wrapper so a thrown env read can never break the catalogue. */
function priceIdForSafe(tier: PlanTier): string | null {
  try {
    return priceIdFor(tier);
  } catch {
    return null;
  }
}

/** Look up a plan by tier, or throw if unknown. */
export function getPlan(tier: PlanTier): Plan {
  const plan = getPlans().find((p) => p.tier === tier);
  if (!plan) throw new Error(`Unknown plan tier: ${tier}`);
  return plan;
}

/** The default tier a brand-new tenant lands on before choosing. */
export const DEFAULT_TIER: PlanTier = "starter";
