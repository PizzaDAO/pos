/**
 * Storefront location resolver — GET /api/shop/location?tenant=&location=
 * (legacy: ?slug=, accepted only when no two tenants share that location slug)
 *
 * Resolves a public storefront (tenant slug + location slug) to its
 * tenant/location ids + the assembled
 * menu, store settings (incl. fulfillment: hours, prep, zones), and payment
 * settings, via the DB abstraction (mock driver). This is what the storefront
 * loads to render the menu + drive checkout/scheduling. No env vars required.
 */
import { NextResponse } from "next/server";
import { getPosDriver } from "@/lib/db";
import { demoModeInfo } from "@/lib/demo/mode";
import { isCardReady } from "@/lib/payments/connect";
import { onlineRailAvailable } from "@/lib/payments/online-rails";
import { resolveStorefrontLocation } from "@/lib/shop/resolve-location";
import { onlinePaymentAllowed } from "@/lib/shop/training-online";
import { giftCardsEnabled } from "@/lib/giftcards/limits";

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

  const [menu, settings, paymentSettings, cardReady] = await Promise.all([
    driver.getMenu(location.tenant_id, location.id),
    driver.getStoreSettings(location.tenant_id, location.id),
    driver.getPaymentSettings(location.tenant_id, location.id),
    // Server-computed card-readiness only (never the account id): lets the
    // storefront hide Card when it would be refused. Always true when simulated.
    isCardReady(location.tenant_id),
  ]);

  return NextResponse.json(
    {
      location,
      menu,
      settings,
      paymentSettings,
      // A rail the training gate refuses (simulated on a live database, audit
      // H3) is reported not ready, so the storefront hides it.
      cardReady:
        cardReady && onlinePaymentAllowed(location.tenant_id, "stripe_online"),
      // Unconfigured crypto rails are hidden (they would simulate; the payments
      // route refuses them unless the whole environment is a simulation).
      cryptoReady: {
        crypto_onchain_usdc:
          onlineRailAvailable("crypto_onchain_usdc") &&
          onlinePaymentAllowed(location.tenant_id, "crypto_onchain_usdc"),
        crypto_coinbase:
          onlineRailAvailable("crypto_coinbase") &&
          onlinePaymentAllowed(location.tenant_id, "crypto_coinbase"),
      },
      driver: driver.name,
      // Gift cards / store credit can be bought and applied at checkout.
      giftCards: giftCardsEnabled(),
      // Display only: the "payments are simulated" note shows just in training.
      demo: demoModeInfo().banner,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
