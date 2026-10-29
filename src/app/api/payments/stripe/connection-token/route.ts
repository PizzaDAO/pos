/**
 * Stripe Terminal connection-token endpoint.
 *
 * POST /api/payments/stripe/connection-token — mints a Terminal connection token
 * the reader SDK uses to connect to a physical reader. Created on the tenant's
 * connected account when Stripe is configured. With no key (default, incl.
 * preview) returns a simulated token so the in-store flow can be exercised.
 *
 * Body: `{ tenantId }`. Auth: an operational (terminal) role of that tenant —
 * the token lets a reader connect to the tenant's connected account, so it is
 * never minted for an unauthenticated caller or another tenant. tenantId may be
 * omitted when the caller has exactly one terminal tenant.
 */
import { NextResponse } from "next/server";
import { getPosDriver } from "@/lib/db";
import { isStripeConfigured } from "@/lib/payments/env";
import { stripeRequest } from "@/lib/payments/providers/stripe-client";
import { railAvailable } from "@/lib/payments/availability";
import { requireTenantAccess } from "@/lib/auth/tenant-guard";

export const runtime = "nodejs";

export async function POST(request: Request) {
  let body: { tenantId?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    body = {};
  }

  const auth = await requireTenantAccess(body.tenantId, "terminal");
  if (!auth.ok) return auth.res;

  if (!isStripeConfigured()) {
    // Terminal staff only (guarded above) — the training opt-in applies.
    if (!railAvailable("stripe_terminal", { staff: true })) {
      return NextResponse.json(
        { error: "Card readers are not configured." },
        { status: 503 },
      );
    }
    return NextResponse.json({
      secret: `sim_terminal_connection_token_${Date.now()}`,
      simulated: true,
    });
  }

  const account = await getPosDriver().getConnectAccount(auth.tenantId);
  const connectAccountId = account?.account_id ?? null;

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
