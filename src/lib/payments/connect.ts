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
import { getPosDriver } from "@/lib/db";
import { cardRailsSimulated, getStripeConfig } from "./env";
import {
  effectiveConnectAccount,
  isSimulated,
  isSimulatedAccount,
} from "./connect-status";
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

export function deriveStatus(acct: {
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
  if (cardRailsSimulated()) {
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
  if (cardRailsSimulated()) {
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
  if (cardRailsSimulated() || accountId.startsWith("acct_sim_")) {
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

export const CARD_NOT_READY_MESSAGE =
  "Card payments aren't set up for this pizzeria yet — finish Stripe onboarding in Admin → Payments.";

/** Thrown when a card operation would run without a usable connected account. */
export class CardPaymentsNotReadyError extends Error {
  constructor() {
    super(CARD_NOT_READY_MESSAGE);
    this.name = "CardPaymentsNotReadyError";
  }
}

/** Min age of a not-ready status before the UI hint re-checks Stripe. */
export const STALE_REFRESH_MS = 5 * 60_000;

type CardGate = { ok: true; accountId: string | null } | { ok: false };

/**
 * Shared card-readiness evaluation.
 *
 * REAL mode (Stripe configured): the tenant MUST have a real (non-simulated)
 * account with `charges_enabled`. If the stored flag is false and `refresh` is
 * set, the live status is fetched from Stripe ONCE and persisted before
 * re-checking (onboarding may have finished since the last stored status).
 * SIMULATED mode: always ok; returns the stored id or null (no Stripe call).
 */
async function evaluateCardGate(
  tenantId: string | null | undefined,
  refresh: boolean | "throttled",
): Promise<CardGate> {
  const driver = getPosDriver();
  const stored = tenantId ? await driver.getConnectAccount(tenantId) : null;
  if (isSimulated()) return { ok: true, accountId: stored?.account_id ?? null };
  let account = effectiveConnectAccount(stored);
  if (!account) return { ok: false };
  // "throttled": refresh at most once per STALE_REFRESH_MS per tenant (the
  // stored updated_at is bumped by every upsert, even when nothing changed).
  const due =
    refresh === true ||
    (refresh === "throttled" &&
      Date.now() - new Date(account.updated_at).getTime() > STALE_REFRESH_MS);
  if (!account.charges_enabled && due) {
    try {
      const fresh = await fetchConnectStatus(account.tenant_id, account.account_id);
      account = await driver.upsertConnectAccount(fresh);
    } catch {
      // Keep the stored (not-ready) status if the refresh fails.
    }
  }
  if (!account.charges_enabled) return { ok: false };
  return { ok: true, accountId: account.account_id };
}

/**
 * Resolve the connected-account id a card rail may charge on behalf of.
 *
 * REAL mode: throws CardPaymentsNotReadyError unless the tenant has a
 * charges-enabled real account, so nothing card-related ever runs on the
 * platform account ("we never custody tenant card funds"). A stale
 * `charges_enabled: false` is refreshed from Stripe once. SIMULATED mode:
 * returns the stored id or null, exactly as before.
 */
export async function resolveCardConnectAccountId(
  tenantId: string | null | undefined,
): Promise<string | null> {
  const gate = await evaluateCardGate(tenantId, true);
  if (!gate.ok) throw new CardPaymentsNotReadyError();
  return gate.accountId;
}

/**
 * Whether card tender can be offered for a tenant right now (UI hint; never
 * exposes the account id). Uses the stored status; a stored not-ready real
 * account older than STALE_REFRESH_MS is re-checked with Stripe (one call per
 * tenant per window, errors swallowed) so a hidden Card can recover after
 * onboarding completes. Always true in simulated mode.
 */
export async function isCardReady(tenantId: string): Promise<boolean> {
  return (await evaluateCardGate(tenantId, "throttled")).ok;
}

export {
  getStripeConfig,
  effectiveConnectAccount,
  isSimulated,
  isSimulatedAccount,
};
