/**
 * Training-mode gate for ANONYMOUS online (storefront) payments (audit H3).
 *
 * In training mode the card rails simulate (`cardRailsSimulated()`), and an
 * unconfigured crypto rail simulates too, so a simulated online tender settles
 * as `captured` with no money. On the mock driver that is the point (demo/dev).
 * On a LIVE database it is not: any anonymous visitor could put "paid" orders on
 * a real pizzeria's KDS, deplete its inventory and dispatch a delivery.
 *
 * So on a live (non-mock) driver a SIMULATED online tender is refused unless the
 * tenant is the seeded demo tenant (Tony's Pizza) or is listed in
 * `TRAINING_ONLINE_TENANTS` (comma-separated tenant ids, default empty). A rail
 * that would really charge (a configured key outside training) is never touched,
 * and staff-side tenders (in-store, cash) do not go through this gate.
 *
 * Lazy env reads; safe to import anywhere on the server.
 */
import { DEMO_TENANT_ID } from "@/lib/db/seed-data";
import type { PaymentRailKey } from "@/lib/payments/PaymentRail";
import {
  cardRailsSimulated,
  isCoinbaseConfigured,
  isOnchainConfigured,
  usingMockDriver,
} from "@/lib/payments/env";

/** Machine code returned to the storefront when online payment is refused. */
export const ONLINE_PAYMENT_UNAVAILABLE_CODE = "online_payment_unavailable";

/** Customer-facing copy for a refused online payment. */
export const ONLINE_PAYMENT_UNAVAILABLE_MESSAGE =
  "Online payment is unavailable at this store right now. Please order in person or by phone.";

/** Tenants (besides the demo tenant) allowed to take simulated online payments. */
export function trainingOnlineTenants(): Set<string> {
  return new Set(
    (process.env.TRAINING_ONLINE_TENANTS ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** Whether this online rail would settle SIMULATED (no real money) right now. */
export function onlineRailSimulated(rail: PaymentRailKey | "cash"): boolean {
  switch (rail) {
    case "stripe_online":
      return cardRailsSimulated();
    case "crypto_onchain_usdc":
      return !isOnchainConfigured();
    case "crypto_coinbase":
      return !isCoinbaseConfigured();
    default:
      return false; // cash is staff-only; other rails are not online rails
  }
}

/** True when this tenant may take simulated online payments on a live database. */
export function tenantAllowsSimulatedOnline(tenantId: string): boolean {
  const id = tenantId.trim().toLowerCase();
  return id === DEMO_TENANT_ID || trainingOnlineTenants().has(id);
}

/**
 * Whether an anonymous online tender on `rail` may be taken for `tenantId`.
 * False only on a live driver, for a simulated rail, at a tenant that is not
 * the demo tenant or allow-listed.
 */
export function onlinePaymentAllowed(
  tenantId: string,
  rail: PaymentRailKey | "cash",
): boolean {
  if (rail === "cash") return true;
  if (!onlineRailSimulated(rail)) return true;
  if (usingMockDriver()) return true;
  return tenantAllowsSimulatedOnline(tenantId);
}

const CUSTOMER_ONLINE_RAILS: readonly PaymentRailKey[] = [
  "stripe_online",
  "crypto_onchain_usdc",
  "crypto_coinbase",
];

/**
 * Whether ANY customer online rail could be paid at this tenant. Used to refuse
 * order intake up front (so the customer never builds an order nobody can pay).
 * Per-rail availability (keys, card readiness) is still checked at payment time.
 */
export function anyOnlinePaymentAllowed(tenantId: string): boolean {
  return CUSTOMER_ONLINE_RAILS.some((r) => onlinePaymentAllowed(tenantId, r));
}
