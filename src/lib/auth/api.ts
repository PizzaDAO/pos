/**
 * Route-handler authorization helpers (legacy names). Thin wrappers over the
 * single shared guard in `./tenant-guard` so every tenant-scoped API route
 * flows through ONE implementation. New code should call
 * `requireTenantAccess` directly.
 *
 * Both return `{ ok: true, user }` or `{ ok: false, res }` (a 401/403 response
 * the caller returns as-is). In simulated mode the session is the seeded demo
 * owner, so the demo tenant passes and the app keeps working with zero env.
 */
import { NextResponse } from "next/server";
import type { MembershipRole } from "@/lib/db";
import type { SessionUser } from "./session";
import { requireTenantAccess } from "./tenant-guard";

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
  if (!tenantId) {
    return {
      ok: false,
      res: NextResponse.json({ error: "tenantId is required." }, { status: 400 }),
    };
  }
  const auth = await requireTenantAccess(tenantId, roles);
  if (!auth.ok) return auth;
  return { ok: true, user: auth.user };
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
