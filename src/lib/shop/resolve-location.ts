/**
 * Server-side storefront location resolution (public /shop routes).
 *
 * The tenant is ALWAYS derived from the resolved location row — never from a
 * client-supplied tenant id. Preferred input is the `{tenantSlug,
 * locationSlug}` pair (unambiguous). A bare legacy `locationSlug` is accepted
 * only when exactly one location across all tenants has that slug; when several
 * tenants share it the caller gets 409 (ambiguous) instead of a random tenant.
 */
import { getPosDriver, type Location } from "@/lib/db";

export type ResolveLocationResult =
  | { ok: true; location: Location }
  | { ok: false; status: 400 | 404 | 409; error: string };

export async function resolveStorefrontLocation(input: {
  tenantSlug?: unknown;
  locationSlug?: unknown;
}): Promise<ResolveLocationResult> {
  const tenantSlug =
    typeof input.tenantSlug === "string" && input.tenantSlug
      ? input.tenantSlug
      : null;
  const locationSlug =
    typeof input.locationSlug === "string" && input.locationSlug
      ? input.locationSlug
      : null;
  if (!locationSlug) {
    return { ok: false, status: 400, error: "locationSlug is required." };
  }
  const driver = getPosDriver();
  if (tenantSlug) {
    const location = await driver.getLocationBySlugs(tenantSlug, locationSlug);
    return location
      ? { ok: true, location }
      : { ok: false, status: 404, error: "Location not found." };
  }
  // Legacy single-slug addressing: only when unambiguous.
  const matches = await driver.listLocationsBySlug(locationSlug);
  if (matches.length === 1 && matches[0]) {
    return { ok: true, location: matches[0] };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      status: 409,
      error: "Several stores share this address; include the tenant slug.",
    };
  }
  return { ok: false, status: 404, error: "Location not found." };
}
