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
 *  - In training mode, payment rails run simulated and orders are seed/disposable
 *    — exactly the current zero-env behaviour, now nameable + assertable.
 *
 * Lazy env read, no throw on unset, safe to import anywhere.
 */
import { getPosDriver } from "@/lib/db";

/** True when `TRAINING_MODE` is explicitly enabled via env. */
export function isTrainingModeEnv(): boolean {
  const v = (process.env.TRAINING_MODE ?? "").toLowerCase();
  return v === "1" || v === "true" || v === "on" || v === "yes";
}

/**
 * Whether the running environment is in training/demo mode. True when either the
 * `TRAINING_MODE` env flag is set, OR the active data driver is the mock/seed
 * driver (no live DB) — in which case nothing is real production data.
 */
export function isTrainingMode(): boolean {
  if (isTrainingModeEnv()) return true;
  try {
    return getPosDriver().name === "mock";
  } catch {
    return false;
  }
}

export interface DemoModeInfo {
  trainingMode: boolean;
  driver: "mock" | "supabase";
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
  const trainingMode = isTrainingModeEnv() || driver === "mock";
  return {
    trainingMode,
    driver,
    banner: trainingMode
      ? "TRAINING MODE — orders and payments are simulated and not charged."
      : null,
  };
}
