/**
 * Delivery-zone resolution (Phase 4) — the gate that decides whether an address
 * is deliverable and at what fee/ETA. PURE functions over store-config zones so
 * both the in-house provider AND the storefront's address-entry validation share
 * one source of truth (no provider-specific geocoding in the core).
 *
 * Matching is by postal code (exact, case/space-insensitive). Real geo-fencing
 * (polygons / drive-radius) is a later concern; postal-code zones are enough for
 * the pilot and keep the mock deterministic with no external service.
 */
import type { DeliveryAddress, DeliveryZone } from "@/lib/db";

/** Normalize a postal code for comparison (trim, upper, strip spaces). */
export function normalizePostal(code: string): string {
  return code.trim().toUpperCase().replace(/\s+/g, "");
}

/** The zone serving an address, or null if out of every zone. */
export function resolveZone(
  zones: DeliveryZone[],
  address: Pick<DeliveryAddress, "postal_code">,
): DeliveryZone | null {
  const target = normalizePostal(address.postal_code);
  if (!target) return null;
  return (
    zones.find((z) =>
      z.postal_codes.some((p) => normalizePostal(p) === target),
    ) ?? null
  );
}

export type ZoneCheck =
  | { ok: true; zone: DeliveryZone }
  | { ok: false; reason: "out_of_zone" | "below_minimum"; zone?: DeliveryZone };

/**
 * Decide whether a delivery to `address` is allowed given the order subtotal.
 * Returns the serving zone on success, or a typed rejection (out of zone, or in
 * zone but below its minimum subtotal) so the UI can show a precise message.
 */
export function checkDeliverable(
  zones: DeliveryZone[],
  address: Pick<DeliveryAddress, "postal_code">,
  subtotalCents: number,
): ZoneCheck {
  const zone = resolveZone(zones, address);
  if (!zone) return { ok: false, reason: "out_of_zone" };
  if (subtotalCents < zone.min_subtotal_cents) {
    return { ok: false, reason: "below_minimum", zone };
  }
  return { ok: true, zone };
}
