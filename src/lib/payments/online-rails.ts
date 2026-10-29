/**
 * Rails an ONLINE (customer-placed) order may be paid with. `stripe_terminal` is
 * card-present and never valid online. `cash` is staff-only (see the payments
 * route). Crypto/card rails are only offered when they are genuinely configured,
 * or when the whole environment is a simulation (no money can be at stake).
 */
import type { PaymentRailKey } from "./PaymentRail";
import {
  cardRailsSimulated,
  isCoinbaseConfigured,
  isOnchainConfigured,
} from "./env";

export const ONLINE_ORDER_RAILS: readonly (PaymentRailKey | "cash")[] = [
  "stripe_online",
  "crypto_onchain_usdc",
  "crypto_coinbase",
  "cash",
];

export function isOnlineOrderRail(rail: string): boolean {
  return (ONLINE_ORDER_RAILS as readonly string[]).includes(rail);
}

/**
 * Whether a non-cash online rail may run right now. A rail with no live
 * credentials simulates and auto-confirms, so it is only allowed when the whole
 * environment is a simulation (`cardRailsSimulated`: no Stripe key, training
 * flag or mock driver); otherwise an anonymous caller could "pay" for free.
 */
export function onlineRailAvailable(rail: PaymentRailKey | "cash"): boolean {
  switch (rail) {
    case "cash":
      return true;
    case "stripe_online":
      return true; // gated separately by card readiness / the connect gate
    case "crypto_onchain_usdc":
      return isOnchainConfigured() || cardRailsSimulated();
    case "crypto_coinbase":
      return isCoinbaseConfigured() || cardRailsSimulated();
    default:
      return false;
  }
}
