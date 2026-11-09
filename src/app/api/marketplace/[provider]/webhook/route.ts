/**
 * Marketplace order webhook.
 *
 * POST /api/marketplace/{provider}/webhook?tenantId=&locationId=
 *   provider: doordash | ubereats | grubhub | simulator
 *
 * Public (the provider calls it), so authentication is the provider's signature
 * over the raw body, checked against env secrets BEFORE anything is parsed or
 * stored. Inert by default: a location that has not enabled the provider gets
 * 403, a provider with no credentials in env gets 503. Idempotent: a replayed
 * order id returns 200 `duplicate` (providers retry on non-2xx, so duplicates
 * must be a success).
 */
import { NextResponse } from "next/server";
import { getPosDriver } from "@/lib/db";
import { ingestMarketplaceWebhook } from "@/lib/marketplace/service";
import {
  isMarketplaceProvider,
  MarketplaceError,
} from "@/lib/marketplace/types";
import { captureError } from "@/lib/observability";

export const runtime = "nodejs";

const STATUS: Record<MarketplaceError["code"], number> = {
  disabled: 403,
  not_configured: 503,
  bad_signature: 401,
  bad_payload: 422,
  unknown_provider: 404,
  not_found: 404,
  invalid_state: 409,
};

export async function POST(
  request: Request,
  { params }: { params: Promise<{ provider: string }> },
) {
  const { provider } = await params;
  if (!isMarketplaceProvider(provider)) {
    return NextResponse.json({ error: "Unknown provider." }, { status: 404 });
  }
  const { searchParams } = new URL(request.url);
  const tenantId = searchParams.get("tenantId");
  const locationId = searchParams.get("locationId");
  if (!tenantId || !locationId) {
    return NextResponse.json(
      { error: "tenantId and locationId are required." },
      { status: 400 },
    );
  }

  // The location must belong to the tenant (ids come from the URL, not the signer).
  const locations = await getPosDriver().listLocations(tenantId);
  if (!locations.some((l) => l.id === locationId)) {
    return NextResponse.json({ error: "Unknown location." }, { status: 404 });
  }

  const rawBody = await request.text();
  const headers: Record<string, string> = {};
  request.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));

  try {
    const result = await ingestMarketplaceWebhook({
      provider,
      tenantId,
      locationId,
      rawBody,
      headers,
    });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof MarketplaceError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: STATUS[err.code] },
      );
    }
    captureError(err, { scope: "marketplace.webhook", provider });
    return NextResponse.json({ error: "Webhook failed." }, { status: 500 });
  }
}
