/**
 * Buy a gift card online: /shop/{tenant}/{location}/gift-cards. Server
 * component: resolves the storefront, then renders the purchase client. 404s
 * when gift cards are off.
 */
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getPosDriver } from "@/lib/db";
import { giftCardsEnabled } from "@/lib/giftcards/limits";
import { GiftCardPurchase } from "../components/gift-card-purchase";

type Params = Promise<{ tenant: string; location: string }>;

export const metadata: Metadata = { title: "Gift cards", robots: { index: false } };

export default async function GiftCardsPage({ params }: { params: Params }) {
  const { tenant: tenantSlug, location: locationSlug } = await params;
  if (!giftCardsEnabled()) notFound();
  const driver = getPosDriver();
  const location = await driver.getLocationBySlugs(tenantSlug, locationSlug);
  if (!location) notFound();
  const settings = await driver.getStoreSettings(location.tenant_id, location.id);
  return (
    <GiftCardPurchase
      tenantSlug={tenantSlug}
      locationSlug={locationSlug}
      locationName={location.name}
      currency={settings.currency}
    />
  );
}
