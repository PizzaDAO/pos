/**
 * Stripe Terminal connection-token endpoint.
 *
 * POST /api/payments/stripe/connection-token — mints a Terminal connection token
 * the reader SDK uses to connect to a physical reader. Created on the tenant's
 * connected account when Stripe is configured. With no key (default, incl.
 * preview) returns a simulated token so the in-store flow can be exercised.
 *
 * Body: `{ tenantId }`. Staff only: owner|manager|cashier of that tenant (the
 * terminal session's roles; kitchen has no payment role) — otherwise anyone
 * could mint a token on any tenant's connected account.
 */
import { NextResponse } from "next/server";
import {
  CardPaymentsNotReadyError,
  resolveCardConnectAccountId,
} from "@/lib/payments/connect";
import { requireTenantRole } from "@/lib/auth/api";
import { cardRailsSimulated } from "@/lib/payments/env";
import { stripeRequest } from "@/lib/payments/providers/stripe-client";

export const runtime = "nodejs";

export async function POST(request: Request) {
  let body: { tenantId?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    body = {};
  }

  if (!body.tenantId) {
    return NextResponse.json({ error: "tenantId is required." }, { status: 400 });
  }
  const auth = await requireTenantRole(body.tenantId, [
    "owner",
    "manager",
    "cashier",
  ]);
  if (!auth.ok) return auth.res;

  if (cardRailsSimulated()) {
    return NextResponse.json({
      secret: `sim_terminal_connection_token_${Date.now()}`,
      simulated: true,
    });
  }

  try {
    // Real mode: refuse unless the tenant has a charges-enabled connected
    // account (never mint a token on the platform account).
    const connectAccountId = await resolveCardConnectAccountId(body.tenantId);
    const token = await stripeRequest<{ secret: string }>(
      "/terminal/connection_tokens",
      {},
      { stripeAccount: connectAccountId ?? undefined },
    );
    return NextResponse.json({ secret: token.secret, simulated: false });
  } catch (err) {
    if (err instanceof CardPaymentsNotReadyError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Token mint failed." },
      { status: 502 },
    );
  }
}
