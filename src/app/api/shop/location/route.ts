/**
 * Storefront location resolver — GET /api/shop/location?slug=
 *
 * Resolves a public location slug to its tenant/location ids + the assembled
 * menu, store settings (incl. fulfillment: hours, prep, zones), and payment
 * settings, via the DB abstraction (mock driver). This is what the storefront
 * loads to render the menu + drive checkout/scheduling. No env vars required.
 */
import { NextResponse } from "next/server";
import { getPosDriver } from "@/lib/db";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const slug = searchParams.get("slug");
  if (!slug) {
    return NextResponse.json({ error: "slug is required." }, { status: 400 });
  }

  const driver = getPosDriver();
  const location = await driver.getLocationBySlug(slug);
  if (!location) {
    return NextResponse.json({ error: "Location not found." }, { status: 404 });
  }

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
      driver: driver.name,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
