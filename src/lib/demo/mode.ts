/**
 * Training / demo mode (Phase 7).
 *
 * The platform already runs entirely on the seeded in-memory mock driver today,
 * so EVERY order placed in the current build is non-production "demo" data. This
 * module formalizes that into an explicit, documented flag a tenant can flip to
 * train staff without real orders once live services are wired.
 *
 * Semantics (documented in docs/PRODUCTION_READINESS.md):
 *  - `TRAINING_MODE=1` (or the mock driver being active) => the environment is
 *    NOT taking real money/orders. Surfaces should badge "TRAINING".
 *  - Training is ALSO on whenever payments would be simulated (Stripe secret key
 *    unset — the same `isStripeConfigured()` check every rail uses to decide to
 *    simulate), even on the live Supabase driver, so a half-wired production never
 *    looks like it is taking real money.
 *  - In training mode, payment rails run simulated and orders are seed/disposable
 *    — exactly the current zero-env behaviour, now nameable + assertable.
 *
 * Lazy env read, no throw on unset, safe to import anywhere.
 */
import { getPosDriver } from "@/lib/db";
import { isStripeConfigured } from "@/lib/payments/env";

/** Banner copy: mock driver or explicit `TRAINING_MODE` (nothing is real). */
export const TRAINING_BANNER =
  "TRAINING MODE — orders and payments are simulated";

/**
 * Banner copy when ONLY Stripe is unconfigured (live driver, no flag): cash is
 * still real and crypto rails go live on their own keys, so claim just cards.
 */
export const TRAINING_BANNER_STRIPE =
  "TRAINING MODE — card payments are simulated (Stripe not configured)";

/** Why training mode is on (null when off). */
export type TrainingReason = "flag" | "mock" | "stripe-unset" | null;

/** True when `TRAINING_MODE` is explicitly enabled via env. */
export function isTrainingModeEnv(): boolean {
  const v = (process.env.TRAINING_MODE ?? "").toLowerCase();
  return v === "1" || v === "true" || v === "on" || v === "yes";
}

/**
 * Whether the running environment is in training/demo mode. True when either the
 * `TRAINING_MODE` env flag is set, the active data driver is the mock/seed
 * driver (no live DB), OR payments would be simulated (no Stripe secret key).
 */
export function isTrainingMode(): boolean {
  if (isTrainingModeEnv()) return true;
  if (!isStripeConfigured()) return true;
  try {
    return getPosDriver().name === "mock";
  } catch {
    return false;
  }
}

export interface DemoModeInfo {
  trainingMode: boolean;
  driver: "mock" | "supabase";
  /** True when payments run simulated (no Stripe secret key). */
  paymentsSimulated: boolean;
  /** Why training mode is on; the flag/mock reasons take precedence. */
  reason: TrainingReason;
  /** Customer/staff-facing banner copy when in training mode. */
  banner: string | null;
}

/** A small status object for surfaces/health endpoints to render a badge. */
export function demoModeInfo(): DemoModeInfo {
  let driver: "mock" | "supabase" = "mock";
  try {
    driver = getPosDriver().name;
  } catch {
    driver = "mock";
  }
  const paymentsSimulated = !isStripeConfigured();
  const reason: TrainingReason = isTrainingModeEnv()
    ? "flag"
    : driver === "mock"
      ? "mock"
      : paymentsSimulated
        ? "stripe-unset"
        : null;
  return {
    trainingMode: reason !== null,
    driver,
    paymentsSimulated,
    reason,
    banner:
      reason === null
        ? null
        : reason === "stripe-unset"
          ? TRAINING_BANNER_STRIPE
          : TRAINING_BANNER,
  };
}
