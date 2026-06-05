/**
 * Rail registration (Phase 2).
 *
 * Importing this module registers every payment rail into the registry. It is
 * idempotent (registering the same key twice just overwrites) and side-effect
 * only. Server code that needs a rail imports `@/lib/payments` (the barrel),
 * which imports this, so `requirePaymentRail(key)` always resolves.
 */
import { registerPaymentRail } from "../registry";
import { cashRail } from "./cash";
import { stripeTerminalRail } from "./stripe-terminal";
import { stripeOnlineRail } from "./stripe-online";
import { cryptoOnchainUsdcRail } from "./crypto-onchain-usdc";
import { cryptoCoinbaseRail } from "./crypto-coinbase";

let registered = false;

/** Register all rails once. Safe to call repeatedly. */
export function registerAllRails(): void {
  if (registered) return;
  registerPaymentRail(cashRail);
  registerPaymentRail(stripeTerminalRail);
  registerPaymentRail(stripeOnlineRail);
  registerPaymentRail(cryptoOnchainUsdcRail);
  registerPaymentRail(cryptoCoinbaseRail);
  registered = true;
}

// Register on import so any consumer of the barrel gets a populated registry.
registerAllRails();

export {
  cashRail,
  stripeTerminalRail,
  stripeOnlineRail,
  cryptoOnchainUsdcRail,
  cryptoCoinbaseRail,
};
