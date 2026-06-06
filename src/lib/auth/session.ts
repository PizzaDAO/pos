/**
 * Server session resolution — the single source of truth for "who is the
 * current user, what tenants/roles do they have, and are they a platform admin".
 *
 * ENV-GUARDED, mirroring the established driver/payment pattern:
 *
 *  - REAL MODE (Supabase public env present): the user is read from the
 *    `@supabase/ssr` server client's auth session (the cookie). The auth user's
 *    id == `public.users.id` (the identity-bridge trigger guarantees this), so
 *    we resolve memberships + the platform-admin flag straight from the driver.
 *    No hardcoded identity anywhere.
 *
 *  - SIMULATED MODE (no Supabase env — the zero-env / CI / local default): there
 *    is no real login, so we return a deterministic simulated session derived
 *    FROM THE SEED DRIVER (the demo owner, resolved by email), NOT a hardcoded
 *    constant role. This keeps the whole app working with zero config while
 *    still flowing every authorization decision through `memberships`. A
 *    simulated platform-admin session is available for the /platform surface.
 *
 * Everything is read at call time; nothing touches env at module load.
 *
 * Server-only: transitively imports `next/headers` (via the SSR server client),
 * so importing this from a client component is a build error by construction.
 */
import {
  DEMO_OWNER_EMAIL,
  PLATFORM_ADMIN_EMAIL,
  getPosDriver,
  type Membership,
  type MembershipRole,
} from "@/lib/db";
import {
  getServerSupabase,
  isSupabaseAuthConfigured,
} from "./supabase-server";

/** The resolved current user + their tenant access, derived from the session. */
export interface SessionUser {
  id: string;
  email: string;
  /** Tenant memberships (tenant_id + role) — drives ALL route/role gating. */
  memberships: Membership[];
  /** True if the user is a platform super-admin (outside tenant RLS). */
  isPlatformAdmin: boolean;
  /**
   * Whether this session came from a REAL Supabase login (`true`) or the
   * simulated/seed fallback (`false`). Surfaces can badge "simulated auth".
   */
  real: boolean;
}

/**
 * The authenticated user for the current request, or null if signed out.
 *
 * In simulated mode this returns the seeded demo owner so the app is usable with
 * no login; pass `{ simulatedAs: "platform" }` to get the simulated platform
 * admin instead (used by the /platform surface fallback).
 */
export async function getCurrentUser(opts?: {
  simulatedAs?: "owner" | "platform";
}): Promise<SessionUser | null> {
  const driver = getPosDriver();

  if (isSupabaseAuthConfigured()) {
    // ---- REAL MODE: identity comes from the Supabase auth cookie. ----
    const supabase = await getServerSupabase();
    if (!supabase) return null;
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return null;

    const email = user.email ?? "";
    // auth.uid() == public.users.id (identity bridge). Resolve access by id.
    const [memberships, isPlatformAdmin] = await Promise.all([
      driver.listMembershipsForUser(user.id),
      driver.isPlatformAdmin(user.id),
    ]);
    return { id: user.id, email, memberships, isPlatformAdmin, real: true };
  }

  // ---- SIMULATED MODE: derive a deterministic session from the seed. ----
  const email =
    opts?.simulatedAs === "platform" ? PLATFORM_ADMIN_EMAIL : DEMO_OWNER_EMAIL;
  const seedUser = await driver.getUserByEmail(email);
  if (!seedUser) return null;
  const [memberships, isPlatformAdmin] = await Promise.all([
    driver.listMembershipsForUser(seedUser.id),
    driver.isPlatformAdmin(seedUser.id),
  ]);
  return {
    id: seedUser.id,
    email: seedUser.email,
    memberships,
    isPlatformAdmin,
    real: false,
  };
}

/**
 * Convenience alias matching the deliverable name. Returns the same resolved
 * session user (auth user + memberships + platform-admin flag).
 */
export async function getServerSession(opts?: {
  simulatedAs?: "owner" | "platform";
}): Promise<SessionUser | null> {
  return getCurrentUser(opts);
}

/** The role the user holds in a given tenant, or null if not a member. */
export function roleInTenant(
  user: SessionUser,
  tenantId: string,
): MembershipRole | null {
  return user.memberships.find((m) => m.tenant_id === tenantId)?.role ?? null;
}

/** Whether real Supabase auth is active (vs the simulated/seed fallback). */
export function isRealAuth(): boolean {
  return isSupabaseAuthConfigured();
}
