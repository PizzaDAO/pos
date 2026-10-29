/**
 * Pure Connect-account status helpers (no DB / network). Kept separate from
 * `connect.ts` so the DB drivers can use them without an import cycle.
 */
import type { ConnectAccount } from "@/lib/db/payment-types";
import { isStripeConfigured } from "./env";

/** Whether the platform is using simulated rails (no Stripe key). */
export function isSimulated(): boolean {
  return !isStripeConfigured();
}

/** True for a stored account that was simulated (never a real Stripe account). */
export function isSimulatedAccount(
  account: Pick<ConnectAccount, "account_id" | "simulated"> | null | undefined,
): boolean {
  return (
    !!account && (account.simulated || account.account_id.startsWith("acct_sim_"))
  );
}

/**
 * The stored account as it should be treated right now. When Stripe is
 * configured a simulated `acct_sim_…` row (left over from onboarding before the
 * key was set) is NOT a real account: treat it as not connected so it is never
 * shown as connected or passed to real Stripe as a connected-account id.
 */
export function effectiveConnectAccount(
  account: ConnectAccount | null,
): ConnectAccount | null {
  if (account && !isSimulated() && isSimulatedAccount(account)) return null;
  return account;
}

/** Platform tenant-health "connected" flag, using the effective account. */
export function isConnectedForHealth(account: ConnectAccount | null): boolean {
  return effectiveConnectAccount(account)?.status === "connected";
}
