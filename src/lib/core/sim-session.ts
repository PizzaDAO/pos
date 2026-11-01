/**
 * Simulated payment-session completion (zero-env preview, CI, TRAINING_MODE).
 *
 * A simulated `/v1` payment session has a local pay page (`/pay/sim/{id}`) whose
 * button POSTs `/api/payment-sessions/{id}/simulate`. This module is the only
 * thing that button can do: capture the session's SIMULATED tender. It refuses
 * (404) unless the deployment is in simulated card mode AND the session itself
 * was created simulated, so it can never settle a real Stripe session or fake a
 * payment on a deployment that takes real cards.
 */
import { getPosDriver } from "@/lib/db";
import type { PaymentSessionRow } from "@/lib/db/payment-types";
import { cardRailsSimulated } from "@/lib/payments/env";
import { applyRailStatus } from "@/lib/payments/service";
import { simulatedSessionsAllowed } from "./payment-sessions";

/** The session, only if it is a live simulated one on a simulated deployment. */
export async function getSimulatedSession(
  id: string,
): Promise<PaymentSessionRow | null> {
  if (!cardRailsSimulated()) return null;
  const row = await getPosDriver().getPaymentSession(id);
  // Same rule as creating one: a simulated link only works on a mock deployment,
  // or non-production for the demo tenant (see simulatedSessionsAllowed).
  return row && row.simulated && simulatedSessionsAllowed(row.tenant_id) ? row : null;
}

export type SimulateOutcome =
  | { ok: true; row: PaymentSessionRow }
  | { ok: false; reason: "not_found" | "not_open" | "expired" };

/** Capture the simulated tender behind an open, unexpired simulated session. */
export async function completeSimulatedSession(
  id: string,
  now: Date = new Date(),
): Promise<SimulateOutcome> {
  const row = await getSimulatedSession(id);
  if (!row) return { ok: false, reason: "not_found" };
  if (row.status !== "open") return { ok: false, reason: "not_open" };
  if (Date.parse(row.expires_at) <= now.getTime()) {
    return { ok: false, reason: "expired" };
  }
  const driver = getPosDriver();
  const tender = (await driver.listPaymentsForOrder(row.order_id)).find(
    (p) =>
      p.simulated &&
      p.rail === "stripe_online" &&
      p.raw?.checkout_session_id === row.stripe_session_id,
  );
  if (!tender || tender.status !== "requires_action") {
    return { ok: false, reason: "not_open" };
  }
  await applyRailStatus(tender.id, "captured", {
    chargeId: `sim_pi_${tender.id.slice(0, 8)}`,
  });
  return { ok: true, row: (await driver.getPaymentSession(id)) ?? row };
}
