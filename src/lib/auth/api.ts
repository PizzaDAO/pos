/**
 * Route-handler authorization helpers — the API-layer counterpart to the page
 * guards. Tenant-scoped API routes accept a `tenantId` from the client; these
 * helpers ensure the SESSION actually authorizes that tenant + role, so a
 * logged-in user can't act on a tenant they don't belong to (defense in depth on
 * top of RLS, and the authoritative check in simulated/service-role mode).
 *
 * Both return an error `NextResponse` (caller returns it) or null on success.
 * In simulated mode the session is the seeded demo owner, so the demo tenant
 * passes and the app keeps working with zero env.
 */
import { NextResponse } from "next/server";
import type { MembershipRole } from "@/lib/db";
import { getCurrentUser, type SessionUser } from "./session";

export interface AuthorizedTenant {
  user: SessionUser;
  tenantId: string;
}

/**
 * Require that the caller is signed in AND holds one of `roles` in `tenantId`.
 * Returns { user } on success or a 401/403 response to return as-is.
 */
export async function requireTenantRole(
  tenantId: string,
  roles: MembershipRole[],
): Promise<{ ok: true; user: SessionUser } | { ok: false; res: NextResponse }> {
  const user = await getCurrentUser();
  if (!user) {
    return {
      ok: false,
      res: NextResponse.json({ error: "Not signed in." }, { status: 401 }),
    };
  }
  const role = user.memberships.find((m) => m.tenant_id === tenantId)?.role;
  if (!role || !roles.includes(role)) {
    return {
      ok: false,
      res: NextResponse.json({ error: "Not authorized for this tenant." }, {
        status: 403,
      }),
    };
  }
  return { ok: true, user };
}

/** Tenant-member (any role) check for a tenant-scoped read/write. */
export async function requireTenantMember(
  tenantId: string,
): Promise<{ ok: true; user: SessionUser } | { ok: false; res: NextResponse }> {
  return requireTenantRole(tenantId, [
    "owner",
    "manager",
    "cashier",
    "kitchen",
  ]);
}
