/**
 * Super-admin platform surface — /api/platform (Phase 6).
 *
 * Operates OUTSIDE tenant RLS scope (tied to the `platform_admins` concept). The
 * caller is the seeded platform operator; a real impl (Phase 7/Supabase) checks
 * the authed user against `platform_admins`. Every sensitive action — notably
 * support impersonation ("view as tenant") — writes an AUDIT LOG entry so it is
 * always traceable.
 *
 * GET  ?tenantId=  → one tenant's detail (health + audit) when set; else the
 *      full tenant-health list + recent audit log + platform-admin identity.
 * POST { action, tenantId?, detail? }:
 *   impersonate_start / impersonate_end → audited "view as tenant"
 *   suspend / reactivate                → flip tenant status (audited)
 */
import { NextResponse } from "next/server";
import { getPosDriver } from "@/lib/db";
import type { AuditAction } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth/session";

export const runtime = "nodejs";

/**
 * Resolve the current platform operator FROM THE SESSION. In real mode this is
 * the logged-in user (gated by their `platform_admins` membership); in simulated
 * mode it's the seeded platform-operator identity. Returns null when the caller
 * is not a platform admin, so every sensitive action below stays gated.
 */
async function requirePlatformAdmin(): Promise<{ id: string; email: string } | null> {
  const user = await getCurrentUser({ simulatedAs: "platform" });
  if (!user || !user.isPlatformAdmin) return null;
  return { id: user.id, email: user.email };
}

export async function GET(request: Request) {
  const admin = await requirePlatformAdmin();
  if (!admin) {
    return NextResponse.json({ error: "Not authorized." }, { status: 403 });
  }
  const driver = getPosDriver();
  const { searchParams } = new URL(request.url);
  const tenantId = searchParams.get("tenantId");

  if (tenantId) {
    const [tenant, health, locations, subscription, connect, onboarding, audit] =
      await Promise.all([
        driver.getTenant(tenantId),
        driver.listTenantHealth(),
        driver.listLocations(tenantId),
        driver.getSubscription(tenantId),
        driver.getConnectAccount(tenantId),
        driver.getOnboarding(tenantId),
        driver.listAuditLog(tenantId),
      ]);
    if (!tenant) {
      return NextResponse.json({ error: "Tenant not found." }, { status: 404 });
    }
    return NextResponse.json({
      tenant,
      health: health.find((h) => h.tenant_id === tenantId) ?? null,
      locations,
      subscription,
      connect,
      onboarding,
      audit,
      admin,
    });
  }

  const [tenants, audit] = await Promise.all([
    driver.listTenantHealth(),
    driver.listAuditLog(),
  ]);
  return NextResponse.json({ tenants, audit, admin });
}

interface PlatformBody {
  action: "impersonate_start" | "impersonate_end" | "suspend" | "reactivate";
  tenantId?: string;
  detail?: string;
}

export async function POST(request: Request) {
  const admin = await requirePlatformAdmin();
  if (!admin) {
    return NextResponse.json({ error: "Not authorized." }, { status: 403 });
  }
  let body: PlatformBody;
  try {
    body = (await request.json()) as PlatformBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (!body.tenantId) {
    return NextResponse.json({ error: "tenantId is required." }, { status: 422 });
  }
  const driver = getPosDriver();
  const tenant = await driver.getTenant(body.tenantId);
  if (!tenant) {
    return NextResponse.json({ error: "Tenant not found." }, { status: 404 });
  }

  const auditAction: AuditAction =
    body.action === "suspend"
      ? "tenant_suspend"
      : body.action === "reactivate"
        ? "tenant_reactivate"
        : body.action; // impersonate_start | impersonate_end

  try {
    if (body.action === "suspend") {
      await driver.setTenantStatus(body.tenantId, "suspended");
    } else if (body.action === "reactivate") {
      await driver.setTenantStatus(body.tenantId, "active");
    }

    const detail =
      body.detail ??
      (body.action === "impersonate_start"
        ? `Support session: viewing ${tenant.name} as the tenant.`
        : body.action === "impersonate_end"
          ? `Ended support session for ${tenant.name}.`
          : `${body.action} ${tenant.name}.`);

    const entry = await driver.appendAuditLog({
      actor_user_id: admin.id,
      actor_label: admin.email,
      action: auditAction,
      tenant_id: body.tenantId,
      detail,
    });

    return NextResponse.json({ ok: true, audit: entry });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Platform action failed." },
      { status: 500 },
    );
  }
}
