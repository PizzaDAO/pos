/**
 * `/shop/{slug}` — legacy single-slug storefront URL + tenant landing.
 *
 * Storefronts now live at `/shop/{tenantSlug}/{locationSlug}` because location
 * slugs are only unique within a tenant. This route keeps old links working:
 *
 *   1. `slug` is a TENANT slug (globally unique) → that tenant wins: redirect
 *      to its only location, or list its locations.
 *   2. Otherwise `slug` is a legacy LOCATION slug held by exactly one location
 *      → redirect to its canonical two-segment URL; several tenants share it
 *      → chooser (never pick one arbitrarily).
 *   3. The slug matches a tenant AND another tenant's location → one chooser
 *      with both (never auto-redirect).
 *   4. Nothing matches → 404.
 *
 * (The dynamic segment is named `tenant` to share the `[tenant]` directory with
 * the canonical route; here it may hold either kind of slug.)
 */
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { storefrontPath } from "@/lib/shop/storefront";
import { resolveLegacyShopSlug } from "@/lib/shop/resolve-location";

export const metadata: Metadata = {
  title: "Choose a store",
  robots: { index: false, follow: true },
};

export const dynamic = "force-dynamic";

export default async function LegacyShopPage({
  params,
}: {
  params: Promise<{ tenant: string }>;
}) {
  const { tenant: slug } = await params;
  const resolved = await resolveLegacyShopSlug(slug);
  if (resolved.kind === "none") notFound();
  if (resolved.kind === "redirect") redirect(resolved.path);
  const choices = resolved.choices;

  return (
    <main id="main-content" className="mx-auto max-w-xl px-4 py-10">
      <h1 className="mb-2 text-2xl font-bold tracking-tight">Choose a store</h1>
      <p className="mb-6 text-sm text-muted-foreground">
        More than one store matches this address. Pick the one you want to
        order from.
      </p>
      <ul className="space-y-2">
        {choices.map(({ location, tenant }) => (
          <li key={location.id}>
            <Link
              href={storefrontPath({
                tenantSlug: tenant.slug,
                locationSlug: location.slug,
              })}
              className="block rounded-lg border p-4 hover:bg-muted"
            >
              <div className="font-medium">{location.name}</div>
              <div className="text-sm text-muted-foreground">
                {tenant.name}
                {location.address ? ` · ${location.address}` : ""}
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
