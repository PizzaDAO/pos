/**
 * Stripe Terminal connection-token endpoint.
 *
 * POST /api/payments/stripe/connection-token — mints a Terminal connection token
 * the reader SDK uses to connect to a physical reader. Created on the tenant's
 * connected account when Stripe is configured. With no key (default, incl.
 * preview) returns a simulated token so the in-store flow can be exercised.
 *
 * Body: `{ tenantId }`.
 */
import { NextResponse } from "next/server";
import { getPosDriver } from "@/lib/db";
import { isStripeConfigured } from "@/lib/payments/env";
import { stripeRequest } from "@/lib/payments/providers/stripe-client";

export const runtime = "nodejs";

export async function POST(request: Request) {
  let body: { tenantId?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    body = {};
  }

  if (!isStripeConfigured()) {
    return NextResponse.json({
      secret: `sim_terminal_connection_token_${Date.now()}`,
      simulated: true,
    });
  }

  const tenantId = body.tenantId;
  let connectAccountId: string | null = null;
  if (tenantId) {
    const account = await getPosDriver().getConnectAccount(tenantId);
    connectAccountId = account?.account_id ?? null;
  }

  try {
    const token = await stripeRequest<{ secret: string }>(
      "/terminal/connection_tokens",
      {},
      { stripeAccount: connectAccountId ?? undefined },
    );
    return NextResponse.json({ secret: token.secret, simulated: false });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Token mint failed." },
      { status: 502 },
    );
  }
}
