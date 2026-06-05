/**
 * Stripe Connect onboarding (Phase 2 scaffold).
 *
 * Tenants complete Connect onboarding to get a connected account; card charges
 * are created on behalf of that account (see the Stripe rails) so funds settle
 * to the TENANT, never to us. We take a per-order platform fee via
 * `application_fee_amount` and bill subscription separately (Phase 6).
 *
 * REAL path (STRIPE_SECRET_KEY set): creates an Express connected account + an
 * Account Link to start hosted onboarding, and reads account status.
 *
 * SIMULATED path (no key, incl. preview): returns a deterministic `acct_sim_…`
 * account that reports `connected` so the admin UI + card rails work end-to-end.
 * Connect status is persisted via the DB abstraction (mock driver) in the route.
 */
import type { ConnectAccount, ConnectStatus } from "@/lib/db/payment-types";
import { getStripeConfig, isStripeConfigured } from "./env";
import { stripeGet, stripeRequest } from "./providers/stripe-client";

function nowIso(): string {
  return new Date().toISOString();
}

/** Build a fresh simulated connected account (already "connected"). */
export function simulatedConnectAccount(tenantId: string): ConnectAccount {
  return {
    tenant_id: tenantId,
    account_id: `acct_sim_${tenantId.replace(/-/g, "").slice(0, 16)}`,
    status: "connected",
    charges_enabled: true,
    payouts_enabled: true,
    details_submitted: true,
    simulated: true,
    created_at: nowIso(),
    updated_at: nowIso(),
  };
}

function deriveStatus(acct: {
  charges_enabled?: boolean;
  payouts_enabled?: boolean;
  details_submitted?: boolean;
}): ConnectStatus {
  if (acct.charges_enabled && acct.payouts_enabled) return "connected";
  if (acct.details_submitted) return "pending";
  return "not_started";
}

/**
 * Create (or simulate) a connected account for a tenant and return its row.
 * In real mode also creates the Express account; the Account Link is generated
 * separately by `createAccountLink` so the route can hand the URL to the client.
 */
export async function createConnectAccount(
  tenantId: string,
): Promise<ConnectAccount> {
  if (!isStripeConfigured()) {
    return { ...simulatedConnectAccount(tenantId), status: "pending", charges_enabled: false, payouts_enabled: false, details_submitted: false };
  }
  const acct = await stripeRequest<{
    id: string;
    charges_enabled?: boolean;
    payouts_enabled?: boolean;
    details_submitted?: boolean;
  }>("/accounts", {
    type: "express",
    metadata: { tenant_id: tenantId },
  });
  return {
    tenant_id: tenantId,
    account_id: acct.id,
    status: deriveStatus(acct),
    charges_enabled: acct.charges_enabled ?? false,
    payouts_enabled: acct.payouts_enabled ?? false,
    details_submitted: acct.details_submitted ?? false,
    simulated: false,
    created_at: nowIso(),
    updated_at: nowIso(),
  };
}

/**
 * Create a hosted onboarding Account Link. Returns a URL the tenant visits to
 * complete KYC. In simulated mode returns a local return URL that immediately
 * marks the account connected.
 */
export async function createAccountLink(
  accountId: string,
  returnUrl: string,
  refreshUrl: string,
): Promise<string> {
  if (!isStripeConfigured()) {
    return `${returnUrl}?simulated=1`;
  }
  const link = await stripeRequest<{ url: string }>("/account_links", {
    account: accountId,
    type: "account_onboarding",
    return_url: returnUrl,
    refresh_url: refreshUrl,
  });
  return link.url;
}

/** Read the live status of a connected account. */
export async function fetchConnectStatus(
  tenantId: string,
  accountId: string,
): Promise<ConnectAccount> {
  if (!isStripeConfigured() || accountId.startsWith("acct_sim_")) {
    return simulatedConnectAccount(tenantId);
  }
  const acct = await stripeGet<{
    id: string;
    charges_enabled?: boolean;
    payouts_enabled?: boolean;
    details_submitted?: boolean;
  }>(`/accounts/${accountId}`);
  return {
    tenant_id: tenantId,
    account_id: acct.id,
    status: deriveStatus(acct),
    charges_enabled: acct.charges_enabled ?? false,
    payouts_enabled: acct.payouts_enabled ?? false,
    details_submitted: acct.details_submitted ?? false,
    simulated: false,
    created_at: nowIso(),
    updated_at: nowIso(),
  };
}

/** Whether the platform is using simulated rails (no Stripe key). */
export function isSimulated(): boolean {
  return !isStripeConfigured();
}

export { getStripeConfig };
