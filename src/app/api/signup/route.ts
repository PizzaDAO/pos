/**
 * Self-serve tenant signup + onboarding — /api/signup (Phase 6).
 *
 * Drives the onboarding wizard server-side through the DB abstraction so each
 * action creates ISOLATED tenant data (own owner user, locations, settings,
 * menu) and tracks onboarding progress. No env vars required; Connect + billing
 * fall back to their simulated paths.
 *
 * Actions (POST { action, ... }):
 *   create_business  { businessName, ownerEmail }  → new tenant + owner user,
 *                    plus an `onboardingToken` bound to the new tenant
 *   add_location     { tenantId, name, address? }  → first location (own slug)
 *   import_menu      { tenantId }                   → starter template menu
 *   go_live          { tenantId }                   → activate + mark live
 *
 * GET ?tenantId=  → onboarding state + tenant + locations (resume the wizard).
 *
 * Auth: `create_business` is PUBLIC (rate-limited). Every tenant-scoped action
 * requires EITHER the `x-onboarding-token` minted for that tenant OR an
 * owner|manager session of it — never a bare tenantId. The wizard steps only
 * run while the tenant is still onboarding (409 after go-live), so they can't
 * be used to bypass plan gating (extra locations) or to re-activate a tenant
 * the platform suspended.
 */
import { NextResponse } from "next/server";
import { getPosDriver } from "@/lib/db";
import {
  requireTenantAdminOrOnboarding,
  signOnboardingToken,
} from "@/lib/auth/onboarding-token";
import { enforceRateLimit, isEmail, recordAudit } from "@/lib/security";
import { canAddLocation, resolveEntitlements } from "@/lib/saas/entitlements";
import { signingSecret } from "@/lib/auth/signing-secret";

/**
 * Whether the platform suspended (or cancelled) this tenant — read from the
 * explicit `suspended_by_platform` flag written in the same update as the
 * platform's status change (never inferred from the audit log).
 */
async function isPlatformSuspended(tenantId: string): Promise<boolean> {
  const tenant = await getPosDriver().getTenant(tenantId);
  if (!tenant) return true;
  if (tenant.status === "cancelled") return true;
  return tenant.status === "suspended" && tenant.suspended_by_platform === true;
}

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
  const [tenant, onboarding, locations, subscription, connect] =
    await Promise.all([
      driver.getTenant(tenantId),
      driver.getOnboarding(tenantId),
      driver.listLocations(tenantId),
      driver.getSubscription(tenantId),
      driver.getConnectAccount(tenantId),
    ]);
  if (!tenant) {
    return NextResponse.json({ error: "Tenant not found." }, { status: 404 });
  }
  return NextResponse.json({
    tenant,
    onboarding,
    locations,
    subscription,
    connect,
  });
}

interface SignupBody {
  action: "create_business" | "add_location" | "import_menu" | "go_live";
  businessName?: string;
  ownerEmail?: string;
  tenantId?: string;
  name?: string;
  address?: string | null;
  timezone?: string;
}

export async function POST(request: Request) {
  let body: SignupBody;
  try {
    body = (await request.json()) as SignupBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const driver = getPosDriver();

  if (body.action === "create_business") {
    // Public: creates a tenant row per call — rate-limit per IP.
    const limited = enforceRateLimit(request, "auth");
    if (limited) return limited;
    const businessName = body.businessName?.trim();
    const ownerEmail = body.ownerEmail?.trim();
    if (!businessName || !ownerEmail || !isEmail(ownerEmail)) {
      return NextResponse.json(
        { error: "businessName and a valid ownerEmail are required." },
        { status: 422 },
      );
    }
    if (businessName.length > 120) {
      return NextResponse.json(
        { error: "businessName is too long." },
        { status: 422 },
      );
    }
    // Fail closed BEFORE creating anything if tokens can't be signed (real
    // mode without ONBOARDING_TOKEN_SECRET / service key).
    if (!signingSecret()) {
      return NextResponse.json(
        { error: "Signup is temporarily unavailable." },
        { status: 503 },
      );
    }
    try {
      const { tenant, owner } = await driver.createTenant({
        businessName,
        ownerEmail,
      });
      const onboarding = await driver.getOnboarding(tenant.id);
      return NextResponse.json(
        {
          tenant,
          owner,
          onboarding,
          onboardingToken: signOnboardingToken(tenant.id),
        },
        { status: 201 },
      );
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "Signup failed." },
        { status: 500 },
      );
    }
  }

  if (
    body.action !== "add_location" &&
    body.action !== "import_menu" &&
    body.action !== "go_live"
  ) {
    return NextResponse.json({ error: "Unknown action." }, { status: 422 });
  }
  if (!body.tenantId) {
    return NextResponse.json(
      { error: "tenantId is required." },
      { status: 422 },
    );
  }

  // Tenant-scoped wizard step: onboarding token for THIS tenant, or an
  // owner|manager session of it.
  const auth = await requireTenantAdminOrOnboarding(request, body.tenantId);
  if (!auth.ok) return auth.res;
  const tenantId = auth.tenantId;

  // Wizard steps only apply while onboarding (not after go-live).
  const current = await driver.getOnboarding(tenantId);
  if (!current) {
    return NextResponse.json({ error: "Tenant not found." }, { status: 404 });
  }
  if (current.live) {
    return NextResponse.json(
      { error: "Onboarding is already complete for this tenant." },
      { status: 409 },
    );
  }

  try {
    switch (body.action) {
      case "add_location": {
        if (!body.name?.trim()) {
          return NextResponse.json(
            { error: "tenantId and name are required." },
            { status: 422 },
          );
        }
        // Same plan gate as /api/admin/locations (no cap bypass via signup).
        const [existing, subscription] = await Promise.all([
          driver.listLocations(tenantId),
          driver.getSubscription(tenantId),
        ]);
        const entitlements = resolveEntitlements(subscription);
        const gate = canAddLocation(entitlements, existing.length);
        if (!gate.allowed) {
          return NextResponse.json(
            { error: gate.reason, code: "plan_limit", entitlements },
            { status: 402 },
          );
        }
        const location = await driver.createLocation({
          tenant_id: tenantId,
          name: body.name.trim().slice(0, 120),
          address: body.address ?? null,
          timezone: body.timezone,
        });
        const onboarding = await driver.completeOnboardingStep(
          tenantId,
          "location",
        );
        return NextResponse.json({ location, onboarding }, { status: 201 });
      }

      case "import_menu": {
        await driver.importStarterMenu(tenantId);
        const onboarding = await driver.completeOnboardingStep(
          tenantId,
          "menu",
        );
        return NextResponse.json({ ok: true, onboarding });
      }

      case "go_live": {
        // New tenants start `suspended` until go-live — but a tenant the
        // PLATFORM suspended (audited tenant_suspend not followed by a
        // reactivate) must not self-activate through the wizard.
        if (await isPlatformSuspended(tenantId)) {
          return NextResponse.json(
            { error: "This account is suspended. Contact support." },
            { status: 403 },
          );
        }
        const onboarding = await driver.goLive(tenantId);
        const tenant = await driver.getTenant(tenantId);
        await recordAudit({
          actor: {
            id: auth.user?.id ?? "system",
            label: auth.user?.email ?? "self-serve onboarding",
          },
          action: "tenant_go_live",
          tenantId,
          detail: `Tenant "${tenant?.name ?? tenantId}" went live.`,
        });
        return NextResponse.json({ ok: true, onboarding, tenant });
      }
    }
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Signup action failed." },
      { status: 500 },
    );
  }
}
