/**
 * Per-location storefront (Phase 4). Server component: resolves the public
 * `/shop/{tenantSlug}/{locationSlug}` pair via the DB abstraction, then renders
 * the mobile-first customer-facing client. Location slugs are only unique
 * within a tenant, so the tenant slug is part of every storefront URL. A bad
 * pair 404s. No env vars required.
 */
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getPosDriver } from "@/lib/db";
import { storefrontPath } from "@/lib/shop/storefront";
import { ShopClient } from "./components/shop-client";

type Params = Promise<{ tenant: string; location: string }>;

/**
 * Per-storefront metadata (indexable). Resolves the location name for the title
 * + OG/Twitter cards. A bad slug yields generic "not found" metadata; the page
 * itself 404s. No env vars required.
 */
export async function generateMetadata({
  params,
}: {
  params: Params;
}): Promise<Metadata> {
  const { tenant: tenantSlug, location: locationSlug } = await params;
  const location = await getPosDriver().getLocationBySlugs(
    tenantSlug,
    locationSlug,
  );
  if (!location) {
    return { title: "Store not found", robots: { index: false } };
  }
  // NB: keep the literal phrase "Order online" out of the <title> — the
  // storefront body renders that exact text and the e2e suite asserts it via a
  // strict getByText, which would otherwise match both the title and the body.
  const title = `${location.name} — Pizza pickup & delivery`;
  const description = `Order pizza from ${location.name} for pickup or delivery. Build your own, half-and-half, and more.`;
  const url = storefrontPath({ tenantSlug, locationSlug });
  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: {
      type: "website",
      title,
      description,
      url,
      images: [{ url: "/og.png", width: 1200, height: 630, alt: location.name }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: ["/og.png"],
    },
  };
}

export default async function ShopPage({ params }: { params: Params }) {
  const { tenant: tenantSlug, location: locationSlug } = await params;
  const location = await getPosDriver().getLocationBySlugs(
    tenantSlug,
    locationSlug,
  );
  if (!location) notFound();

  return (
    <ShopClient
      store={{ tenantSlug, locationSlug }}
      locationName={location.name}
    />
  );
}
