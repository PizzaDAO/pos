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
  /**
   * When THIS login session last authenticated (ms since epoch): the newest
   * `amr` timestamp of the Supabase access token, which survives token
   * refreshes, so it is the sign-in time of this browser's session. null when
   * unknown (simulated mode). Used to require a recent sign-in before the
   * first back-office PIN is issued (src/lib/auth/admin-gate.ts).
   */
  authAt?: number | null;
}

/**
 * The newest `amr[].timestamp` (seconds) of a JWT payload, in ms; null when
 * absent. Pure; exported for tests. Only call on a token getUser() verified.
 */
export function authTimeFromAccessToken(token: string | null | undefined): number | null {
  if (!token) return null;
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const payload = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as {
      amr?: { timestamp?: unknown }[];
    };
    const ts = (payload.amr ?? [])
      .map((a) => (typeof a?.timestamp === "number" ? a.timestamp : NaN))
      .filter((n) => Number.isFinite(n));
    return ts.length ? Math.max(...ts) * 1000 : null;
  } catch {
    return null;
  }
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
    const [memberships, isPlatformAdmin, sessionRes] = await Promise.all([
      driver.listMembershipsForUser(user.id),
      driver.isPlatformAdmin(user.id),
      // The token was just verified by getUser(); read its sign-in time.
      supabase.auth.getSession().catch(() => null),
    ]);
    const token = sessionRes?.data?.session?.access_token ?? null;
    return {
      id: user.id,
      email,
      memberships,
      isPlatformAdmin,
      real: true,
      authAt: authTimeFromAccessToken(token),
    };
  }

  // ---- SIMULATED MODE: derive a deterministic session from the seed. ----
  // ONLY with the in-memory mock driver. If the real (Supabase) driver is
  // active but the public auth env is missing/misconfigured, there is NO user —
  // never fall back to the seeded demo owner / platform admin against live data.
  if (!isSimulatedSessionAllowed(driver.name)) return null;
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
 * The simulated demo session is permitted only when real auth is NOT
 * configured AND the data driver is the in-memory mock. (Pure; exported for
 * tests.)
 */
export function isSimulatedSessionAllowed(driverName: string): boolean {
  return driverName === "mock" && !isSupabaseAuthConfigured();
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
