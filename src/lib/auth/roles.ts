/**
 * Role / route-gating matrix (pure, server + client safe).
 *
 * Surfaces and the membership roles allowed to enter them:
 *   /admin     → owner | manager          (tenant back office)
 *   /terminal  → owner | manager | cashier | kitchen
 *   /kitchen   → owner | manager | cashier | kitchen
 *   /platform  → platform_admin ONLY (outside tenant RLS)
 *   /shop      → PUBLIC (no gate)
 *
 * These are evaluated against the SESSION's memberships (never a hardcoded
 * role). The matrix is the single source of truth shared by the middleware
 * pre-check and the per-route server checks.
 */
import type { MembershipRole } from "@/lib/db";

export type GatedSurface = "admin" | "terminal" | "kitchen" | "platform";

/** Roles permitted into each tenant surface. */
export const SURFACE_ROLES: Record<
  Exclude<GatedSurface, "platform">,
  MembershipRole[]
> = {
  admin: ["owner", "manager"],
  terminal: ["owner", "manager", "cashier", "kitchen"],
  kitchen: ["owner", "manager", "cashier", "kitchen"],
};

/** Which login a surface redirects to when the visitor is unauthenticated. */
export function loginPathFor(surface: GatedSurface): string {
  return surface === "platform" ? "/platform/login" : "/login";
}

/**
 * Given a user's memberships, the tenants they may enter a surface as. Empty
 * means "no access to this surface for any tenant".
 */
export function tenantsForSurface(
  memberships: { tenant_id: string; role: MembershipRole }[],
  surface: Exclude<GatedSurface, "platform">,
): string[] {
  const allowed = SURFACE_ROLES[surface];
  return memberships
    .filter((m) => allowed.includes(m.role))
    .map((m) => m.tenant_id);
}

/** Does the user have a qualifying role for the surface in the given tenant? */
export function canEnterSurface(
  memberships: { tenant_id: string; role: MembershipRole }[],
  surface: Exclude<GatedSurface, "platform">,
  tenantId: string,
): boolean {
  const allowed = SURFACE_ROLES[surface];
  return memberships.some(
    (m) => m.tenant_id === tenantId && allowed.includes(m.role),
  );
}
