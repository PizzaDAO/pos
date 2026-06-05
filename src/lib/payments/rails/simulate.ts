/**
 * Shared simulation helpers for payment rails (Phase 2).
 *
 * When a rail has no live credentials it falls back to these deterministic
 * helpers so the full checkout flow works end-to-end in the preview without any
 * secrets. The ids are clearly prefixed `sim_` so they are never mistaken for
 * real provider ids in logs or receipts.
 */
import type { PaymentRailKey } from "../PaymentRail";

/** Deterministic-ish unique id for a simulated charge/intent. */
export function simId(prefix: string): string {
  const rand =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().replace(/-/g, "").slice(0, 16)
      : Math.random().toString(36).slice(2, 18);
  return `sim_${prefix}_${rand}`;
}

/** A simulated 0x… transaction hash for crypto rails. */
export function simTxHash(): string {
  const hex =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().replace(/-/g, "")
      : Math.random().toString(16).slice(2);
  return `0x${(hex + hex).slice(0, 64)}`;
}

/** Marker stored on every simulated charge's `raw` payload. */
export function simRaw(
  rail: PaymentRailKey | "cash",
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { simulated: true, rail, ...extra };
}
