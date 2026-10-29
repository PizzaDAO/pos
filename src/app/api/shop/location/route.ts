/**
 * Storefront location resolver — GET /api/shop/location?tenant=&location=
 *
 * Resolves a public storefront (tenant slug + location slug) to its
 * tenant/location ids + the assembled menu, store settings (incl. fulfillment:
 * hours, prep, zones), and payment settings, via the DB abstraction. This is
 * what the storefront loads to render the menu + drive checkout/scheduling.
 *
 * Location slugs are only unique per tenant, so the tenant slug is required for
 * an unambiguous lookup. The legacy `?slug=` form still works when exactly one
 * location has that slug (409 when several tenants share it). PUBLIC; the
 * tenant is derived from the resolved location, never from the client.
 */
import { NextResponse } from "next/server";
import { getPosDriver } from "@/lib/db";
import { resolveStorefrontLocation } from "@/lib/shop/resolve-location";
import { publicOnlineRails } from "@/lib/payments/availability";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const resolved = await resolveStorefrontLocation({
    tenantSlug: searchParams.get("tenant"),
    locationSlug: searchParams.get("location") ?? searchParams.get("slug"),
  });
  if (!resolved.ok) {
    return NextResponse.json(
      { error: resolved.error },
      { status: resolved.status },
    );
  }
  const { location } = resolved;

  const driver = getPosDriver();
  const [menu, settings, paymentSettings] = await Promise.all([
    driver.getMenu(location.tenant_id, location.id),
    driver.getStoreSettings(location.tenant_id, location.id),
    driver.getPaymentSettings(location.tenant_id, location.id),
  ]);

  return NextResponse.json(
    {
      location,
      menu,
      settings,
      paymentSettings,
      // Online rails that would actually accept a customer payment now (the
      // storefront hides the rest instead of failing at checkout).
      onlineRails: publicOnlineRails(),
      driver: driver.name,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
