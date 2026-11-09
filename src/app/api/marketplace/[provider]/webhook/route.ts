/**
 * Marketplace order webhook.
 *
 * POST /api/marketplace/{provider}/webhook      provider: doordash | ubereats | grubhub
 *
 * Public (the provider calls it), so authentication is the provider's signature
 * over the raw body, checked against env secrets BEFORE anything is parsed. The
 * tenant/location is NOT taken from the URL: it is found by the provider store id
 * named in the signed payload (one URL per provider app, as Uber Eats does).
 * Inert by default: a store nobody enabled, an unknown store and a disabled
 * location all answer the same 404; a provider with no credentials in env gets
 * 503. The simulator is not reachable here (the admin "simulate" action calls
 * ingest directly). Idempotent: a replayed order id returns 200 `duplicate`
 * (providers retry on non-2xx).
 */
import { NextResponse } from "next/server";
import { ingestMarketplaceWebhook } from "@/lib/marketplace/service";
import {
  isMarketplaceProvider,
  MarketplaceError,
} from "@/lib/marketplace/types";
import { captureError } from "@/lib/observability";

export const runtime = "nodejs";

const STATUS: Record<MarketplaceError["code"], number> = {
  disabled: 404,
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
  if (!isMarketplaceProvider(provider) || provider === "simulator") {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  const rawBody = await request.text();
  const headers: Record<string, string> = {};
  request.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));

  try {
    const result = await ingestMarketplaceWebhook({
      provider,
      rawBody,
      headers,
    });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof MarketplaceError) {
      const status = STATUS[err.code];
      return NextResponse.json(
        {
          error: status === 404 ? "Not found." : err.message,
          code: status === 404 ? undefined : err.code,
        },
        { status },
      );
    }
    captureError(err, { scope: "marketplace.webhook", provider });
    return NextResponse.json({ error: "Webhook failed." }, { status: 500 });
  }
}
