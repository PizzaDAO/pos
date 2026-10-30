/**
 * API tenant guard — the ONE server-side authorization check every
 * tenant-scoped route handler runs before touching data.
 *
 * Why this exists: the server DB driver uses the Supabase SERVICE-ROLE key
 * (RLS bypassed) and the middleware does not match /api/*, so a route handler
 * that trusts a `tenantId` from the query/body would let ANY caller (signed out,
 * or signed in to another tenant) read/write ANY tenant. This guard derives the
 * set of tenants the caller may act on FROM THE SESSION's memberships (never
 * from the client) and returns 401 (no session) / 403 (wrong tenant/role).
 *
 * Usage:
 *   const auth = await requireTenantAccess(tenantId, "admin", { locationId });
 *   if (!auth.ok) return auth.res;
 *   // auth.tenantId / auth.locationId are now authorized
 *
 * `access` is a gated surface ("admin" | "terminal" | "kitchen", see roles.ts)
 * or an explicit role list. When `tenantId` is omitted, the caller's single
 * authorized tenant is used (400 if they have several and didn't choose).
 * When `locationId` is passed it must belong to the authorized tenant (403).
 *
 * SIMULATED MODE (no Supabase env): `getCurrentUser()` returns the seeded demo
 * owner, so the demo tenant passes every tenant gate and the zero-env app,
 * build, unit and e2e suites keep working unchanged.
 */
import { NextResponse } from "next/server";
import { getPosDriver, type MembershipRole, type Order } from "@/lib/db";
import { getCurrentUser, type SessionUser } from "./session";
import { SURFACE_ROLES, type GatedSurface } from "./roles";

/** A tenant surface name or an explicit list of permitted membership roles. */
export type TenantAccess = Exclude<GatedSurface, "platform"> | MembershipRole[];

export type GuardFailure = { ok: false; res: NextResponse };

export interface TenantGrant {
  ok: true;
  user: SessionUser;
  tenantId: string;
  /** The authorized location (validated to belong to tenantId), or null. */
  locationId: string | null;
  /** The caller's role in the authorized tenant. */
  role: MembershipRole;
}

function deny(status: 400 | 401 | 403 | 404, error: string): GuardFailure {
  return { ok: false, res: NextResponse.json({ error }, { status }) };
}

/** Roles permitted by an access spec. */
export function rolesFor(access: TenantAccess): MembershipRole[] {
  return Array.isArray(access) ? access : SURFACE_ROLES[access];
}

/**
 * Pure decision (no I/O): given a session user, which tenant may they act on?
 * Exposed for unit tests; route handlers call {@link requireTenantAccess}.
 */
export function decideTenantAccess(
  user: SessionUser | null,
  requestedTenantId: string | null | undefined,
  access: TenantAccess,
):
  | { ok: true; tenantId: string; role: MembershipRole }
  | { ok: false; status: 400 | 401 | 403; error: string } {
  if (!user) return { ok: false, status: 401, error: "Not signed in." };
  const roles = rolesFor(access);
  const allowed = user.memberships.filter((m) => roles.includes(m.role));
  const allowedIds = [...new Set(allowed.map((m) => m.tenant_id))];

  let tenantId = requestedTenantId || null;
  if (!tenantId) {
    if (allowedIds.length === 0) {
      return { ok: false, status: 403, error: "Not authorized." };
    }
    if (allowedIds.length > 1) {
      return { ok: false, status: 400, error: "tenantId is required." };
    }
    tenantId = allowedIds[0] ?? null;
  }
  const membership = allowed.find((m) => m.tenant_id === tenantId);
  if (!tenantId || !membership) {
    return { ok: false, status: 403, error: "Not authorized for this tenant." };
  }
  return { ok: true, tenantId, role: membership.role };
}

/**
 * Require that the caller is signed in and holds an `access` role in
 * `tenantId` (or their sole authorized tenant when omitted). Optionally
 * validates that `locationId` belongs to that tenant.
 */
export async function requireTenantAccess(
  tenantId: string | null | undefined,
  access: TenantAccess,
  opts?: { locationId?: string | null; requireLocation?: boolean },
): Promise<TenantGrant | GuardFailure> {
  return grantFor(await getCurrentUser(), tenantId, access, opts);
}

async function grantFor(
  user: SessionUser | null,
  tenantId: string | null | undefined,
  access: TenantAccess,
  opts?: { locationId?: string | null; requireLocation?: boolean },
): Promise<TenantGrant | GuardFailure> {
  const decision = decideTenantAccess(user, tenantId, access);
  if (!decision.ok) return deny(decision.status, decision.error);

  const locationId = opts?.locationId || null;
  if (!locationId && opts?.requireLocation) {
    return deny(400, "locationId is required.");
  }
  if (locationId) {
    const locations = await getPosDriver().listLocations(decision.tenantId);
    if (!locations.some((l) => l.id === locationId)) {
      return deny(403, "Location is not part of this tenant.");
    }
  }
  return {
    ok: true,
    user: user as SessionUser,
    tenantId: decision.tenantId,
    locationId,
    role: decision.role,
  };
}

/**
 * Layer for routes that already authorize the tenant with main's
 * `requireTenantRole` / `requireTenantMember`: the client-supplied
 * `locationId` must belong to that (already authorized) tenant. Returns a 403
 * failure, or null when it does.
 */
export async function requireLocationInTenant(
  tenantId: string,
  locationId: string,
): Promise<GuardFailure | null> {
  const locations = await getPosDriver().listLocations(tenantId);
  return locations.some((l) => l.id === locationId)
    ? null
    : deny(403, "Location is not part of this tenant.");
}

/** The caller's role in `tenantId` (null when not a member). */
export function sessionRoleIn(
  user: Pick<SessionUser, "memberships"> | null | undefined,
  tenantId: string,
): MembershipRole | null {
  return user?.memberships?.find((m) => m.tenant_id === tenantId)?.role ?? null;
}

/**
 * Resolve an order by id and require `access` on ITS tenant (the tenant is
 * taken from the stored order, never the client). 404 when it doesn't exist.
 */
export async function requireOrderAccess(
  orderId: string,
  access: TenantAccess,
): Promise<(TenantGrant & { order: Order }) | GuardFailure> {
  // Authenticate first so an anonymous caller can't probe order ids.
  const user = await getCurrentUser();
  if (!user) return deny(401, "Not signed in.");
  let order: Order | null = null;
  try {
    order = await getPosDriver().getOrder(orderId);
  } catch {
    order = null;
  }
  if (!order) return deny(404, "Order not found.");
  const auth = await grantFor(user, order.tenant_id, access, {
    locationId: order.location_id,
  });
  if (!auth.ok) return auth;
  return { ...auth, order };
}

/**
 * Require a platform (super) admin. In simulated mode the simulated platform
 * operator session is used so /platform works with zero env.
 */
export async function requirePlatformAdminApi(): Promise<
  { ok: true; user: SessionUser } | GuardFailure
> {
  const user = await getCurrentUser({ simulatedAs: "platform" });
  if (!user) return deny(401, "Not signed in.");
  if (!user.isPlatformAdmin) return deny(403, "Not authorized.");
  return { ok: true, user };
}
