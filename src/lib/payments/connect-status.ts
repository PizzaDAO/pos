/**
 * Pure Connect-account status helpers (no DB / network). Kept separate from
 * `connect.ts` so the DB drivers can use them without an import cycle.
 */
import type { ConnectAccount } from "@/lib/db/payment-types";
import { isStripeConfigured } from "./env";

/**
 * Whether Connect ACCOUNT MANAGEMENT (create / link / refresh / webhook sync) is
 * simulated: only when there is no Stripe key. Deliberately NOT tied to training
 * mode, which only simulates card CHARGES (`cardRailsSimulated`): with a real key
 * a stored real `acct_` row must never be touched by simulation.
 */
export function isSimulated(): boolean {
  return !isStripeConfigured();
}

/** Thrown when a simulated account would replace a stored real one. */
export class SimulatedAccountOverwriteError extends Error {
  constructor() {
    super("Refusing to overwrite a real Stripe connected account with a simulated one.");
    this.name = "SimulatedAccountOverwriteError";
  }
}

/**
 * Driver-level guard: no code path may upsert a simulated account over a stored
 * row whose account_id isn't `acct_sim_...`.
 */
export function assertNoSimulatedOverwrite(
  existing: Pick<ConnectAccount, "account_id"> | null | undefined,
  incoming: Pick<ConnectAccount, "account_id" | "simulated">,
): void {
  if (
    existing &&
    !existing.account_id.startsWith("acct_sim_") &&
    (incoming.simulated || incoming.account_id.startsWith("acct_sim_"))
  ) {
    throw new SimulatedAccountOverwriteError();
  }
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
