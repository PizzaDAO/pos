/**
 * Legacy tracking URL `/shop/{locationSlug}/track/{orderId}` → redirect to the
 * canonical `/shop/{tenantSlug}/{locationSlug}/track/{orderId}`.
 *
 * The storefront is derived from the ORDER (its stored tenant + location), not
 * from the legacy slug in the URL, so an ambiguous location slug can't send the
 * customer to another tenant's store. ("track" is a reserved location slug.)
 */
import { notFound, redirect } from "next/navigation";
import { getPosDriver } from "@/lib/db";
import { storefrontPath } from "@/lib/shop/storefront";

export const dynamic = "force-dynamic";

export default async function LegacyTrackPage({
  params,
}: {
  params: Promise<{ tenant: string; orderId: string }>;
}) {
  const { orderId } = await params;
  const driver = getPosDriver();
  const order = await driver.getOrder(orderId).catch(() => null);
  if (!order) notFound();
  const [tenant, locations] = await Promise.all([
    driver.getTenant(order.tenant_id),
    driver.listLocations(order.tenant_id),
  ]);
  const location = locations.find((l) => l.id === order.location_id);
  if (!tenant || !location) notFound();
  redirect(
    `${storefrontPath({ tenantSlug: tenant.slug, locationSlug: location.slug })}/track/${encodeURIComponent(order.id)}`,
  );
}
