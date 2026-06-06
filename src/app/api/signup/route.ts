/**
 * Self-serve tenant signup + onboarding — /api/signup (Phase 6).
 *
 * Drives the onboarding wizard server-side through the DB abstraction so each
 * action creates ISOLATED tenant data (own owner user, locations, settings,
 * menu) and tracks onboarding progress. No env vars required; Connect + billing
 * fall back to their simulated paths.
 *
 * Actions (POST { action, ... }):
 *   create_business  { businessName, ownerEmail }  → new tenant + owner user
 *   add_location     { tenantId, name, address? }  → first location (own slug)
 *   import_menu      { tenantId }                   → starter template menu
 *   go_live          { tenantId }                   → activate + mark live
 *
 * GET ?tenantId=  → onboarding state + tenant + locations (resume the wizard).
 */
import { NextResponse } from "next/server";
import { getPosDriver } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth/session";
import { recordAudit } from "@/lib/security";

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
  const driver = getPosDriver();

  try {
    switch (body.action) {
      case "create_business": {
        const businessName = body.businessName?.trim();
        const ownerEmail = body.ownerEmail?.trim();
        if (!businessName || !ownerEmail) {
          return NextResponse.json(
            { error: "businessName and ownerEmail are required." },
            { status: 422 },
          );
        }
        const { tenant, owner } = await driver.createTenant({
          businessName,
          ownerEmail,
        });
        const onboarding = await driver.getOnboarding(tenant.id);
        return NextResponse.json(
          { tenant, owner, onboarding },
          { status: 201 },
        );
      }

      case "add_location": {
        if (!body.tenantId || !body.name?.trim()) {
          return NextResponse.json(
            { error: "tenantId and name are required." },
            { status: 422 },
          );
        }
        const location = await driver.createLocation({
          tenant_id: body.tenantId,
          name: body.name.trim(),
          address: body.address ?? null,
          timezone: body.timezone,
        });
        const onboarding = await driver.completeOnboardingStep(
          body.tenantId,
          "location",
        );
        return NextResponse.json({ location, onboarding }, { status: 201 });
      }

      case "import_menu": {
        if (!body.tenantId) {
          return NextResponse.json(
            { error: "tenantId is required." },
            { status: 422 },
          );
        }
        await driver.importStarterMenu(body.tenantId);
        const onboarding = await driver.completeOnboardingStep(
          body.tenantId,
          "menu",
        );
        return NextResponse.json({ ok: true, onboarding });
      }

      case "go_live": {
        if (!body.tenantId) {
          return NextResponse.json(
            { error: "tenantId is required." },
            { status: 422 },
          );
        }
        const onboarding = await driver.goLive(body.tenantId);
        const tenant = await driver.getTenant(body.tenantId);
        // Audit tenant go-live (lifecycle) — best-effort actor from session.
        const actor = await getCurrentUser();
        await recordAudit({
          actor: {
            id: actor?.id ?? "system",
            label: actor?.email ?? "self-serve onboarding",
          },
          action: "tenant_go_live",
          tenantId: body.tenantId,
          detail: `Tenant "${tenant?.name ?? body.tenantId}" went live.`,
        });
        return NextResponse.json({ ok: true, onboarding, tenant });
      }

      default:
        return NextResponse.json({ error: "Unknown action." }, { status: 422 });
    }
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Signup action failed." },
      { status: 500 },
    );
  }
}
