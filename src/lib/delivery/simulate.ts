/**
 * Shared simulation helpers for delivery providers (Phase 4).
 *
 * When a provider has no live credentials it falls back to these deterministic
 * helpers so the full delivery flow works end-to-end in the preview without any
 * secrets. Ids are clearly prefixed `sim_` so they're never mistaken for real
 * provider ids in logs or tracking refs.
 */
import type { DeliveryProviderKey } from "./DeliveryProvider";

/** Unique-ish id for a simulated delivery/quote handle. */
export function simDeliveryId(prefix: string): string {
  const rand =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().replace(/-/g, "").slice(0, 16)
      : Math.random().toString(36).slice(2, 18);
  return `sim_${prefix}_${rand}`;
}

/** A made-up but plausible driver, derived deterministically from a seed. */
export function simDriver(seed: string): { name: string; phone: string } {
  const names = ["Sam R.", "Alex P.", "Jordan T.", "Casey M.", "Riley K."];
  let h = 0;
  for (let i = 0; i < seed.length; i += 1) h = (h * 31 + seed.charCodeAt(i)) | 0;
  const idx = Math.abs(h) % names.length;
  const last4 = String(1000 + (Math.abs(h) % 9000));
  return { name: names[idx] ?? "Sam R.", phone: `555-01${last4}` };
}

/** Marker stored on every simulated delivery's tracking ref. */
export function simTrackingRef(provider: DeliveryProviderKey): string {
  return `sim://${provider}/track/${simDeliveryId("trk").slice(4)}`;
}
