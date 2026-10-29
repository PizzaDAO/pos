/**
 * `/shop/{slug}` — legacy single-slug storefront URL + tenant landing.
 *
 * Storefronts now live at `/shop/{tenantSlug}/{locationSlug}` because location
 * slugs are only unique within a tenant. This route keeps old links working:
 *
 *   1. `slug` is a LOCATION slug held by exactly one location → redirect to its
 *      canonical two-segment URL.
 *   2. Several tenants share that location slug → render a chooser (never pick
 *      one arbitrarily).
 *   3. Otherwise `slug` is a TENANT slug → redirect to its only location, or
 *      list its locations.
 *   4. Nothing matches → 404.
 *
 * (The dynamic segment is named `tenant` to share the `[tenant]` directory with
 * the canonical route; here it may hold either kind of slug.)
 */
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getPosDriver, type Location, type Tenant } from "@/lib/db";
import { storefrontPath } from "@/lib/shop/storefront";

export const metadata: Metadata = {
  title: "Choose a store",
  robots: { index: false, follow: true },
};

export const dynamic = "force-dynamic";

interface Choice {
  location: Location;
  tenant: Tenant;
}

export default async function LegacyShopPage({
  params,
}: {
  params: Promise<{ tenant: string }>;
}) {
  const { tenant: slug } = await params;
  const driver = getPosDriver();

  let choices: Choice[] = [];
  const byLocation = await driver.listLocationsBySlug(slug);
  if (byLocation.length > 0) {
    const resolved = await Promise.all(
      byLocation.map(async (location) => ({
        location,
        tenant: await driver.getTenant(location.tenant_id),
      })),
    );
    choices = resolved.filter((c): c is Choice => c.tenant !== null);
  } else {
    const tenant = await driver.getTenantBySlug(slug);
    if (tenant) {
      const locations = await driver.listLocations(tenant.id);
      choices = locations.map((location) => ({ location, tenant }));
    }
  }

  if (choices.length === 0) notFound();
  if (choices.length === 1 && choices[0]) {
    const only = choices[0];
    redirect(
      storefrontPath({
        tenantSlug: only.tenant.slug,
        locationSlug: only.location.slug,
      }),
    );
  }

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
