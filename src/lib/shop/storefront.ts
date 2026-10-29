/**
 * Storefront addressing (client + server safe, pure).
 *
 * `locations.slug` is unique only WITHIN a tenant (DB: unique (tenant_id,
 * slug)), while `tenants.slug` is globally unique — so a public storefront is
 * always addressed by BOTH: `/shop/{tenantSlug}/{locationSlug}`.
 */
export interface StorefrontRef {
  tenantSlug: string;
  locationSlug: string;
}

/** Canonical public URL path of a storefront. */
export function storefrontPath(ref: StorefrontRef): string {
  return `/shop/${encodeURIComponent(ref.tenantSlug)}/${encodeURIComponent(ref.locationSlug)}`;
}

/** Stable key for per-storefront client state (cart binding, query keys). */
export function storefrontKey(ref: StorefrontRef): string {
  return `${ref.tenantSlug}/${ref.locationSlug}`;
}
