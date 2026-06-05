/**
 * Stripe Connect onboarding endpoint (Phase 2 scaffold).
 *
 * GET  /api/connect?tenantId=  — current Connect status for the tenant (from the
 *      DB abstraction); refreshes from Stripe when configured.
 * POST /api/connect            — start onboarding for the tenant: create (or
 *      simulate) a connected account, persist it, and return an onboarding URL.
 *      `{ tenantId, returnUrl?, refreshUrl? }`.
 *
 * REAL Stripe Connect calls are guarded by STRIPE_SECRET_KEY. With no key
 * (default, incl. preview) a simulated `acct_sim_…` account is returned that
 * reports `connected`, so card rails + the admin UI work end-to-end. Status is
 * persisted via the DB abstraction (mock driver).
 */
import { NextResponse } from "next/server";
import { getPosDriver } from "@/lib/db";
import {
  createAccountLink,
  createConnectAccount,
  fetchConnectStatus,
  isSimulated,
} from "@/lib/payments/connect";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const tenantId = searchParams.get("tenantId");
  if (!tenantId) {
    return NextResponse.json(
      { error: "tenantId is required." },
      { status: 400 },
    );
  }
  const driver = getPosDriver();
  let account = await driver.getConnectAccount(tenantId);

  // If we have a stored real account, refresh its live status from Stripe.
  if (account && !account.simulated) {
    try {
      const fresh = await fetchConnectStatus(tenantId, account.account_id);
      account = await driver.upsertConnectAccount(fresh);
    } catch {
      // Keep the stored status if the refresh fails.
    }
  }

  return NextResponse.json({ account, simulated: isSimulated() });
}

export async function POST(request: Request) {
  let body: { tenantId?: string; returnUrl?: string; refreshUrl?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (!body.tenantId) {
    return NextResponse.json(
      { error: "tenantId is required." },
      { status: 422 },
    );
  }

  const driver = getPosDriver();
  try {
    // Reuse an existing account if onboarding was already started.
    let account = await driver.getConnectAccount(body.tenantId);
    if (!account) {
      account = await createConnectAccount(body.tenantId);
      account = await driver.upsertConnectAccount(account);
    }

    const origin = new URL(request.url).origin;
    const returnUrl = body.returnUrl ?? `${origin}/admin?connect=return`;
    const refreshUrl = body.refreshUrl ?? `${origin}/admin?connect=refresh`;

    // Simulated mode: immediately mark connected on "return".
    if (isSimulated()) {
      account = await driver.upsertConnectAccount({
        ...account,
        status: "connected",
        charges_enabled: true,
        payouts_enabled: true,
        details_submitted: true,
        simulated: true,
      });
    }

    const onboardingUrl = await createAccountLink(
      account.account_id,
      returnUrl,
      refreshUrl,
    );

    return NextResponse.json({ account, onboardingUrl, simulated: isSimulated() });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Connect onboarding failed." },
      { status: 502 },
    );
  }
}
