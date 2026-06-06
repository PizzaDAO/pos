/**
 * Server-side route guards — the AUTHORITATIVE authorization checks for each
 * gated surface. Called from the route-group server components (and reusable in
 * route handlers). They resolve the session, enforce the role matrix against the
 * session's memberships, and return the session-derived ACTIVE CONTEXT (tenant +
 * location + user) that replaces the old hardcoded `DEMO_CONTEXT`.
 *
 * `redirect()` from `next/navigation` is used for unauthenticated / unauthorized
 * outcomes so a page can simply `const ctx = await requireTerminal(...)` and
 * trust ctx thereafter. Works in both real and simulated mode (in simulated mode
 * the session is the seeded demo owner, who satisfies every tenant gate).
 */
import { redirect } from "next/navigation";
import {
  DEMO_LOCATION_DOWNTOWN_ID,
  DEMO_TENANT_ID,
  getPosDriver,
  type Location,
} from "@/lib/db";
import { getCurrentUser, type SessionUser } from "./session";
import {
  canEnterSurface,
  tenantsForSurface,
  type GatedSurface,
} from "./roles";

/** The active operating context a gated page renders against. */
export interface ActiveContext {
  user: SessionUser;
  tenantId: string;
  /** The active location id (terminal/kitchen). null for tenant-wide admin. */
  locationId: string | null;
  /** Locations of the active tenant (for a chooser / labels). */
  locations: Location[];
}

/**
 * Resolve the active tenant for a surface from the session + an optional
 * explicit `?tenant=` (must be one the user can enter). When the user can enter
 * exactly one tenant, that one is chosen; multiple with no explicit pick →
 * caller should render a chooser (returned as `null`).
 */
function pickTenant(
  user: SessionUser,
  surface: Exclude<GatedSurface, "platform">,
  requestedTenant: string | null,
): { tenantId: string | null; allowed: string[] } {
  const allowed = tenantsForSurface(user.memberships, surface);
  if (requestedTenant && allowed.includes(requestedTenant)) {
    return { tenantId: requestedTenant, allowed };
  }
  if (allowed.length === 1) return { tenantId: allowed[0] ?? null, allowed };
  return { tenantId: null, allowed };
}

/**
 * Gate the tenant back office (/admin): owner|manager of the active tenant.
 * Redirects to /login when signed out, or /forbidden when authenticated but
 * lacking access. Returns the active context (locationId null — admin is
 * tenant-wide).
 */
export async function requireAdmin(
  requestedTenant?: string | null,
): Promise<ActiveContext> {
  const user = await getCurrentUser();
  if (!user) redirect("/login?redirect=/admin");
  const { tenantId, allowed } = pickTenant(user, "admin", requestedTenant ?? null);
  if (allowed.length === 0) redirect("/forbidden");
  // Multiple tenants and none chosen → send to the chooser.
  if (!tenantId) redirect("/login/choose?surface=admin");
  const locations = await getPosDriver().listLocations(tenantId);
  return { user, tenantId, locationId: null, locations };
}

/**
 * Gate an operational location surface (/terminal, /kitchen): any operational
 * role (owner|manager|cashier|kitchen) of the active location's tenant.
 * Resolves the active location from `?location=` (must belong to the tenant)
 * else the tenant's first location.
 */
export async function requireLocationSurface(
  surface: "terminal" | "kitchen",
  requested?: { tenant?: string | null; location?: string | null },
): Promise<ActiveContext> {
  const user = await getCurrentUser();
  if (!user) redirect(`/login?redirect=/${surface}`);
  const { tenantId, allowed } = pickTenant(
    user,
    surface,
    requested?.tenant ?? null,
  );
  if (allowed.length === 0) redirect("/forbidden");
  if (!tenantId) redirect(`/login/choose?surface=${surface}`);
  if (!canEnterSurface(user.memberships, surface, tenantId)) {
    redirect("/forbidden");
  }
  const locations = await getPosDriver().listLocations(tenantId);
  const requestedLoc = requested?.location ?? null;
  const locationId =
    (requestedLoc && locations.some((l) => l.id === requestedLoc)
      ? requestedLoc
      : locations[0]?.id) ?? null;
  return { user, tenantId, locationId, locations };
}

/**
 * Gate the super-admin surface (/platform): the user must be a platform admin.
 * In simulated mode, resolve the simulated platform-admin session.
 */
export async function requirePlatformAdmin(): Promise<SessionUser> {
  // In simulated mode, surface the simulated platform-admin identity so the
  // console is reachable with zero env; in real mode the flag comes from the
  // logged-in user's platform_admins membership.
  const user = await getCurrentUser({ simulatedAs: "platform" });
  if (!user) redirect("/platform/login");
  if (!user.isPlatformAdmin) redirect("/platform/login?error=forbidden");
  return user;
}

/** The demo defaults, re-exported so simulated-mode callers have a fallback. */
export const FALLBACK_CONTEXT = {
  tenantId: DEMO_TENANT_ID,
  locationId: DEMO_LOCATION_DOWNTOWN_ID,
} as const;
