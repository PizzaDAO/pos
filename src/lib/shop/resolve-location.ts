/**
 * Server-side storefront location resolution (public /shop routes).
 *
 * The tenant is ALWAYS derived from the resolved location row — never from a
 * client-supplied tenant id. Preferred input is the `{tenantSlug,
 * locationSlug}` pair (unambiguous). A bare legacy `locationSlug` is accepted
 * only when exactly one location across all tenants has that slug; when several
 * tenants share it the caller gets 409 (ambiguous) instead of a random tenant.
 */
import { getPosDriver, type Location, type Tenant } from "@/lib/db";
import { storefrontPath } from "./storefront";

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

export interface StoreChoice {
  location: Location;
  tenant: Tenant;
}

export type LegacySlugResolution =
  | { kind: "none" }
  | { kind: "redirect"; path: string }
  | { kind: "choose"; choices: StoreChoice[] };

/**
 * Resolve the legacy single-segment `/shop/{slug}`. A TENANT slug (globally
 * unique) wins: redirect to its only location or list its locations. A bare
 * legacy LOCATION slug redirects only when exactly one location has it. When
 * the slug is a tenant's AND another tenant's location slug, everything is
 * shown in one chooser — never an arbitrary redirect.
 */
export async function resolveLegacyShopSlug(
  slug: string,
): Promise<LegacySlugResolution> {
  const driver = getPosDriver();
  const [tenant, byLocation] = await Promise.all([
    driver.getTenantBySlug(slug),
    driver.listLocationsBySlug(slug),
  ]);
  const tenantChoices: StoreChoice[] = tenant
    ? (await driver.listLocations(tenant.id)).map((location) => ({
        location,
        tenant,
      }))
    : [];
  const otherTenantLocations = (
    await Promise.all(
      byLocation
        .filter((l) => !tenant || l.tenant_id !== tenant.id)
        .map(async (location) => ({
          location,
          tenant: await driver.getTenant(location.tenant_id),
        })),
    )
  ).filter((c): c is StoreChoice => c.tenant !== null);

  const ambiguous = Boolean(tenant) && otherTenantLocations.length > 0;
  const choices = tenant
    ? [...tenantChoices, ...otherTenantLocations]
    : otherTenantLocations;

  if (choices.length === 0) return { kind: "none" };
  const only = choices[0];
  if (choices.length === 1 && only && !ambiguous) {
    return {
      kind: "redirect",
      path: storefrontPath({
        tenantSlug: only.tenant.slug,
        locationSlug: only.location.slug,
      }),
    };
  }
  return { kind: "choose", choices };
}
