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
 *
 * Auth: owner|manager session of the tenant, or the signup wizard's onboarding
 * token for that tenant while it is still onboarding.
 */
import { NextResponse } from "next/server";
import { getPosDriver } from "@/lib/db";
import {
  createAccountLink,
  createConnectAccount,
  fetchConnectStatus,
  isSimulated,
} from "@/lib/payments/connect";
import { requireTenantAdminOrOnboarding } from "@/lib/auth/onboarding-token";
import { recordAudit } from "@/lib/security";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const auth = await requireTenantAdminOrOnboarding(
    request,
    searchParams.get("tenantId"),
  );
  if (!auth.ok) return auth.res;
  const tenantId = auth.tenantId;
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

  // Only an owner|manager of the tenant (or its own signup wizard) may
  // start/modify Connect onboarding — this controls where card revenue settles.
  const auth = await requireTenantAdminOrOnboarding(request, body.tenantId);
  if (!auth.ok) return auth.res;

  // Redirect targets must stay on this origin (no open redirect via Stripe).
  const origin = new URL(request.url).origin;
  const sameOrigin = (u: string | undefined) => {
    if (!u) return undefined;
    try {
      return new URL(u, origin).origin === origin
        ? new URL(u, origin).toString()
        : undefined;
    } catch {
      return undefined;
    }
  };

  const driver = getPosDriver();
  try {
    // Reuse an existing account if onboarding was already started.
    let account = await driver.getConnectAccount(body.tenantId);
    if (!account) {
      account = await createConnectAccount(body.tenantId);
      account = await driver.upsertConnectAccount(account);
    }

    const returnUrl =
      sameOrigin(body.returnUrl) ?? `${origin}/admin?connect=return`;
    const refreshUrl =
      sameOrigin(body.refreshUrl) ?? `${origin}/admin?connect=refresh`;

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

    // Audit the Connect change (tenant-scoped) — a money-routing-sensitive op.
    await recordAudit({
      actor: {
        id: auth.user?.id ?? "system",
        label: auth.user?.email ?? "self-serve onboarding",
      },
      action: "connect_change",
      tenantId: body.tenantId,
      detail: `Stripe Connect onboarding ${isSimulated() ? "(simulated) " : ""}started/refreshed; account ${account.account_id}, status ${account.status}.`,
    });

    return NextResponse.json({
      account,
      onboardingUrl,
      simulated: isSimulated(),
    });
  } catch (err) {
    return NextResponse.json(
      {
        error:
          err instanceof Error ? err.message : "Connect onboarding failed.",
      },
      { status: 502 },
    );
  }
}
