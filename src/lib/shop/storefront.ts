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

/** Next.js page `searchParams` shape. */
export type PageSearchParams = Record<string, string | string[] | undefined>;

/**
 * `path` with the request's query string carried over — legacy storefront /
 * tracking redirects must keep e.g. `?utm_source=…` or `?checkout=…`.
 */
export function withSearchParams(
  path: string,
  searchParams: PageSearchParams | URLSearchParams | null | undefined,
): string {
  if (!searchParams) return path;
  const qs = new URLSearchParams();
  if (searchParams instanceof URLSearchParams) {
    searchParams.forEach((v, k) => qs.append(k, v));
  } else {
    for (const [k, v] of Object.entries(searchParams)) {
      if (Array.isArray(v)) for (const x of v) qs.append(k, x);
      else if (typeof v === "string") qs.append(k, v);
    }
  }
  const s = qs.toString();
  if (!s) return path;
  return `${path}${path.includes("?") ? "&" : "?"}${s}`;
}
