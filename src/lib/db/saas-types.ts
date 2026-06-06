/**
 * Self-serve SaaS layer domain types (Phase 6).
 *
 * Mirrors the intended Supabase tables for the platform/billing layer described
 * in PLAN.md:
 *   - `subscriptions` (Stripe Billing — OUR revenue from tenants)
 *   - `plans` (subscription tiers + entitlements)
 *   - `tenant_onboarding` (wizard progress/status per tenant)
 *   - `audit_log` (platform-operator actions, incl. support impersonation)
 *
 * Kept DB-agnostic so the in-memory mock driver and a future Supabase driver
 * share the same shapes. All money is integer minor units (cents) — never floats.
 *
 * Two revenue streams, never conflated:
 *   1. SUBSCRIPTION (this file / Stripe Billing) — we charge the tenant.
 *   2. Per-order platform fee (Connect application_fee, Phase 2) — taken off the
 *      tenant's card revenue, which settles to THEIR connected account.
 */

// ----------------------------------------------------------------------------
// Plans / tiers + entitlements
// ----------------------------------------------------------------------------

/** Stable identifier for a subscription tier. */
export type PlanTier = "starter" | "pro" | "multi";

/**
 * Feature entitlements a plan grants. The entitlement check (`@/lib/saas`) reads
 * these to gate features. `Infinity` is allowed for unlimited numeric limits and
 * is JSON-serialised as `null` over the wire (see `serializeLimit`).
 */
export interface PlanEntitlements {
  /** Max locations the tenant may operate (Infinity = unlimited). */
  max_locations: number;
  /** Whether customer online ordering (/shop) is enabled. */
  online_ordering: boolean;
  /** Whether advanced reports (rollup, payment-mix, export) are enabled. */
  advanced_reports: boolean;
  /** Whether delivery (the DeliveryProvider surface) is enabled. */
  delivery: boolean;
  /** Max staff seats (Infinity = unlimited). */
  max_staff: number;
}

/** A subscription plan/tier offered to tenants. Price is integer cents/month. */
export interface Plan {
  tier: PlanTier;
  name: string;
  /** One-line marketing description. */
  blurb: string;
  /** Monthly price in integer cents (USD). */
  price_cents: number;
  /** Free-trial length in days applied on first subscribe. */
  trial_days: number;
  entitlements: PlanEntitlements;
  /**
   * Stripe Price id used in REAL billing mode. Resolved from env
   * (STRIPE_PRICE_<TIER>) at runtime; null when unkeyed (simulated mode).
   */
  stripe_price_id: string | null;
}

// ----------------------------------------------------------------------------
// Subscriptions (Stripe Billing — our revenue)
// ----------------------------------------------------------------------------

/**
 * Subscription lifecycle. `trialing` and `active` are "good standing";
 * `past_due` enters dunning; `canceled` ends service.
 *   trialing → active → past_due → (active | canceled)
 */
export type SubscriptionStatus =
  | "trialing"
  | "active"
  | "past_due"
  | "canceled";

/**
 * A tenant's subscription to the platform. One per tenant. In REAL mode the
 * `stripe_*` ids link to a Stripe Customer + Subscription; in SIMULATED mode
 * those are deterministic `sim_*` ids and the lifecycle is advanced in-memory.
 */
export interface Subscription {
  id: string;
  tenant_id: string;
  tier: PlanTier;
  status: SubscriptionStatus;
  /** ISO end of the current period (renewal/expiry). */
  current_period_end: string;
  /** ISO end of trial (null once converted / never on a no-trial plan). */
  trial_end: string | null;
  /** Whether the tenant requested cancellation at period end. */
  cancel_at_period_end: boolean;
  /** Simulated billing (no live Stripe keys)? */
  simulated: boolean;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  created_at: string;
  updated_at: string;
}

// ----------------------------------------------------------------------------
// Onboarding wizard state
// ----------------------------------------------------------------------------

/** Ordered steps of the self-serve onboarding wizard. */
export type OnboardingStep =
  | "business" // create tenant + owner user
  | "location" // add first location
  | "connect" // Stripe Connect onboarding
  | "menu" // import a template menu / quick-add
  | "plan" // pick a subscription plan
  | "go_live"; // finalize — tenant becomes active

export const ONBOARDING_STEPS: readonly OnboardingStep[] = [
  "business",
  "location",
  "connect",
  "menu",
  "plan",
  "go_live",
] as const;

/**
 * Persisted onboarding progress for a tenant. `completed_steps` lets the wizard
 * resume; `live` is set once the tenant goes live (status flips to active).
 */
export interface TenantOnboarding {
  tenant_id: string;
  /** Which step the wizard should resume at. */
  current_step: OnboardingStep;
  completed_steps: OnboardingStep[];
  live: boolean;
  created_at: string;
  updated_at: string;
}

// ----------------------------------------------------------------------------
// Audit log (platform-operator actions, incl. impersonation)
// ----------------------------------------------------------------------------

/**
 * Category of an audited action. Beyond the original platform-operator actions
 * (impersonation, tenant lifecycle), Phase 7 hardening broadens coverage to
 * other sensitive, tenant-scoped operations: staff/admin sign-in, role &
 * membership changes, payment refunds/voids, menu 86 (availability), Stripe
 * Connect changes, and subscription/billing changes. Every entry is written
 * through the existing append-only `audit_log` table and stays tenant-scoped
 * (the `tenant_id` column), so `/platform` surfaces a single traceable trail.
 */
export type AuditAction =
  // Platform-operator actions (original).
  | "impersonate_start"
  | "impersonate_end"
  | "tenant_suspend"
  | "tenant_reactivate"
  | "subscription_override"
  // Auth / access (Phase 7).
  | "auth_sign_in"
  | "staff_pin_switch"
  | "membership_change"
  // Money (Phase 7).
  | "payment_refund"
  | "payment_void"
  // Menu / catalogue (Phase 7).
  | "menu_86"
  // Tenant lifecycle / integrations (Phase 7).
  | "connect_change"
  | "subscription_change"
  | "tenant_go_live";

/**
 * An append-only audit entry written when a platform operator takes a
 * sensitive action (notably support impersonation — "view as tenant"). Surfaced
 * read-only in /platform so impersonation is always traceable.
 */
export interface AuditLogEntry {
  id: string;
  /** Platform-admin user id who performed the action. */
  actor_user_id: string;
  /** Human label for the actor (email) captured at write time. */
  actor_label: string;
  action: AuditAction;
  /** Target tenant id, when the action targets a tenant. */
  tenant_id: string | null;
  /** Free-form context (e.g. reason, session id). */
  detail: string | null;
  created_at: string;
}

// ----------------------------------------------------------------------------
// Tenant signup input
// ----------------------------------------------------------------------------

/** Payload to create a brand-new tenant + its owner user (wizard step 1). */
export interface CreateTenantInput {
  /** Business (tenant) display name. */
  businessName: string;
  /** Owner user's email (modelled as a User + owner Membership). */
  ownerEmail: string;
}

/** A first location to create during onboarding (wizard step 2). */
export interface CreateLocationInput {
  tenant_id: string;
  name: string;
  timezone?: string;
  address?: string | null;
}

/**
 * A platform-level view row for the super-admin tenant list. Aggregates a
 * tenant's health: subscription state, location count, and recent order volume
 * (derived from mock order data).
 */
export interface TenantHealth {
  tenant_id: string;
  name: string;
  slug: string;
  status: string;
  location_count: number;
  /** Orders placed in the trailing window (derived from mock data). */
  recent_order_count: number;
  recent_gross_cents: number;
  subscription: Subscription | null;
  onboarding: TenantOnboarding | null;
  connected: boolean;
}

/**
 * Serialise a numeric limit for JSON transport: Infinity → null (which the
 * client renders as "Unlimited"). Mirrored by `deserializeLimit`.
 */
export function serializeLimit(n: number): number | null {
  return Number.isFinite(n) ? n : null;
}

/** Inverse of `serializeLimit`: null → Infinity. */
export function deserializeLimit(n: number | null): number {
  return n === null ? Infinity : n;
}
