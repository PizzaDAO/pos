/**
 * Per-location storefront (Phase 4). Server component: resolves the public
 * location slug via the DB abstraction, then renders the mobile-first
 * customer-facing client. A bad slug 404s. No env vars required.
 */
import { notFound } from "next/navigation";
import { getPosDriver } from "@/lib/db";
import { ShopClient } from "./components/shop-client";

export default async function ShopPage({
  params,
}: {
  params: Promise<{ location: string }>;
}) {
  const { location: slug } = await params;
  const driver = getPosDriver();
  const location = await driver.getLocationBySlug(slug);
  if (!location) notFound();

  return <ShopClient slug={slug} locationName={location.name} />;
}
