/**
 * Payment rail registry.
 *
 * Maps each `PaymentRailKey` to its implementation. Phase 0 ships an EMPTY
 * registry (all keys unimplemented) — implementations register themselves in
 * Phase 2. The keys are declared up front so tenant config (which rails a
 * pizzeria accepts) and the UI can reference them today.
 */

import type { PaymentRail, PaymentRailKey } from "./PaymentRail";

/** All rail keys the platform knows about, in display order. */
export const PAYMENT_RAIL_KEYS: readonly PaymentRailKey[] = [
  "cash",
  "stripe_terminal",
  "stripe_online",
  "crypto_onchain_usdc",
  "crypto_coinbase",
] as const;

/** Human-readable labels for UI/config surfaces. */
export const PAYMENT_RAIL_LABELS: Record<PaymentRailKey, string> = {
  cash: "Cash",
  stripe_terminal: "Card — Stripe Terminal (in-store)",
  stripe_online: "Card — Stripe (online)",
  crypto_onchain_usdc: "Crypto — Onchain USDC (Base)",
  crypto_coinbase: "Crypto — Coinbase Commerce",
};

/** Empty in Phase 0. Phase 2 populates this via `registerPaymentRail`. */
const registry = new Map<PaymentRailKey, PaymentRail>();

export function registerPaymentRail(rail: PaymentRail): void {
  registry.set(rail.key, rail);
}

/** Returns the implementation for a rail, or undefined if not yet implemented. */
export function getPaymentRail(key: PaymentRailKey): PaymentRail | undefined {
  return registry.get(key);
}

/** Returns the implementation, throwing if the rail is not registered. */
export function requirePaymentRail(key: PaymentRailKey): PaymentRail {
  const rail = registry.get(key);
  if (!rail) {
    throw new Error(`Payment rail not implemented: ${key}`);
  }
  return rail;
}

export function isPaymentRailAvailable(key: PaymentRailKey): boolean {
  return registry.has(key);
}
