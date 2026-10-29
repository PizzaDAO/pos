/**
 * Delivery quote endpoint — POST /api/delivery/quote
 *
 * Body: { tenantSlug, locationSlug, dropoff, subtotalCents, currency, scheduledFor? }
 *
 * PUBLIC (the storefront calls it before checkout). The tenant/location are
 * resolved SERVER-SIDE from the storefront slugs — a client-supplied tenantId
 * is never trusted. (Legacy `{ tenantId, locationId }` bodies are accepted only
 * when that location really belongs to that tenant.) The quote is advisory:
 * /api/shop/orders re-quotes against the server-computed subtotal.
 * Returns a quote (provider, fee, ETA, zoneId) via the location's DeliveryProvider
 * (in-house or DoorDash Drive, simulated when unkeyed). Rejects out-of-zone /
 * below-minimum addresses with 422 + a customer-facing message — this is the
 * zone GATE the storefront uses to enable/disable the delivery option.
 *
 * No env vars required; the provider runs simulated with none.
 */
import { NextResponse } from "next/server";
import type { DeliveryAddress } from "@/lib/db";
import { getPosDriver } from "@/lib/db";
import { quoteDelivery } from "@/lib/delivery/service";
import { DeliveryUnavailableError } from "@/lib/delivery";
import { resolveStorefrontLocation } from "@/lib/shop/resolve-location";
import { enforceRateLimit, isMoneyCents } from "@/lib/security";

export const runtime = "nodejs";

interface QuoteBody {
  tenantSlug?: string;
  locationSlug?: string;
  /** Legacy addressing (validated: the location must belong to the tenant). */
  tenantId?: string;
  locationId?: string;
  dropoff: DeliveryAddress;
  subtotalCents: number;
  currency: string;
  scheduledFor?: string;
}

function isValid(body: unknown): body is QuoteBody {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  return (
    (typeof b.locationSlug === "string" ||
      (typeof b.tenantId === "string" && typeof b.locationId === "string")) &&
    isMoneyCents(b.subtotalCents) &&
    typeof b.currency === "string" &&
    typeof b.dropoff === "object" &&
    b.dropoff !== null
  );
}

export async function POST(request: Request) {
  // Public + may call a paid provider API (DoorDash) — rate-limit per IP.
  const limited = enforceRateLimit(request, "orders");
  if (limited) return limited;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (!isValid(body)) {
    return NextResponse.json(
      { error: "Malformed quote payload." },
      { status: 422 },
    );
  }

  const driver = getPosDriver();
  let tenantId: string;
  let locationId: string;
  if (typeof body.locationSlug === "string") {
    const resolved = await resolveStorefrontLocation({
      tenantSlug: body.tenantSlug,
      locationSlug: body.locationSlug,
    });
    if (!resolved.ok) {
      return NextResponse.json(
        { error: resolved.error },
        { status: resolved.status },
      );
    }
    tenantId = resolved.location.tenant_id;
    locationId = resolved.location.id;
  } else {
    const locations = await driver.listLocations(body.tenantId as string);
    const loc = locations.find((l) => l.id === body.locationId);
    if (!loc) {
      return NextResponse.json(
        { error: "Location not found." },
        { status: 404 },
      );
    }
    tenantId = loc.tenant_id;
    locationId = loc.id;
  }
  const settings = await driver.getStoreSettings(tenantId, locationId);
  const fulfillment = settings.fulfillment;
  if (!fulfillment?.delivery_enabled) {
    return NextResponse.json(
      { error: "This location does not offer delivery." },
      { status: 422 },
    );
  }
  const pickup: DeliveryAddress = parsePickup(
    fulfillment.pickup_address ?? "",
  );

  try {
    const { provider, quote } = await quoteDelivery({
      tenantId,
      locationId,
      dropoff: body.dropoff,
      pickup,
      subtotalCents: body.subtotalCents,
      currency: settings.currency,
      scheduledFor: body.scheduledFor,
    });
    return NextResponse.json({
      provider,
      feeCents: quote.fee.amount,
      currency: quote.fee.currency,
      etaMinutes: quote.etaMinutes ?? null,
      zoneId: quote.quoteId ?? null,
      simulated: !quote.expiresAt ? undefined : true,
    });
  } catch (err) {
    if (err instanceof DeliveryUnavailableError) {
      return NextResponse.json(
        { error: err.message, deliverable: false },
        { status: 422 },
      );
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Quote failed." },
      { status: 502 },
    );
  }
}

/** Best-effort parse of a one-line pickup address into the structured shape. */
function parsePickup(s: string): DeliveryAddress {
  return {
    line1: s || "Pickup",
    city: "",
    region: "",
    postal_code: "",
    country: "US",
  };
}
