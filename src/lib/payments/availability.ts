/**
 * Which payment rails are usable right now (server-only).
 *
 * A rail with live keys is always available. An unkeyed (simulated) rail is
 * available only per `simulatedRailsAllowed`: in the zero-env demo, or for
 * STAFF tenders when ALLOW_SIMULATED_PAYMENTS=true. The storefront uses
 * `publicOnlineRails()` to hide rails that would be refused and to refuse an
 * order before it is created when no online rail can take it.
 */
import { getPosDriver } from "@/lib/db";
import { isSupabaseAuthConfigured } from "@/lib/auth/supabase-server";
import type { PaymentRailKey } from "./PaymentRail";
import { railIsSimulated } from "./service";
import { simulatedRailsAllowed } from "./simulation";

/** Rails an anonymous storefront customer may use (no cash / card-present). */
export const PUBLIC_RAILS: PaymentRailKey[] = [
  "stripe_online",
  "crypto_onchain_usdc",
  "crypto_coinbase",
];

export function railAvailable(
  rail: PaymentRailKey,
  opts: { staff: boolean },
): boolean {
  if (!railIsSimulated(rail)) return true;
  return simulatedRailsAllowed({
    driverName: getPosDriver().name,
    realAuth: isSupabaseAuthConfigured(),
    allowFlag: process.env.ALLOW_SIMULATED_PAYMENTS,
    staff: opts.staff,
  });
}

/** Online rails an anonymous customer can actually pay with right now. */
export function publicOnlineRails(): PaymentRailKey[] {
  return PUBLIC_RAILS.filter((r) => railAvailable(r, { staff: false }));
}

/** Readiness summary of simulated-payment policy (for /api/ready). */
export function simulatedPaymentsPolicy() {
  const demo = simulatedRailsAllowed({
    driverName: getPosDriver().name,
    realAuth: isSupabaseAuthConfigured(),
  });
  const flag = process.env.ALLOW_SIMULATED_PAYMENTS === "true";
  return {
    /** ALLOW_SIMULATED_PAYMENTS=true is set. */
    allowSimulatedPaymentsFlag: flag,
    /** Unkeyed rails accepted for terminal staff tenders. */
    simulatedAllowedForStaff: demo || flag,
    /** Unkeyed rails accepted for anonymous online checkout (demo only). */
    simulatedAllowedForCustomers: demo,
    /** Online rails a customer can use right now. */
    onlineRails: publicOnlineRails(),
  };
}
