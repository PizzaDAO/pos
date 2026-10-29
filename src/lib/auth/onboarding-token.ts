/**
 * Onboarding capability token (server-only).
 *
 * The self-serve /signup wizard is PUBLIC: a brand-new pizzeria has no login
 * yet while it walks through location → Connect → menu → plan → go-live. Those
 * steps are tenant-scoped writes, so they must NOT accept a bare `tenantId`
 * from the client (anyone could then add locations to, import menus into, or
 * un-suspend ANY tenant). Instead, `create_business` mints a short-lived HMAC
 * token bound to the new tenant id; the wizard sends it back in the
 * `x-onboarding-token` header, and the routes accept it ONLY for that tenant and
 * ONLY while the tenant's onboarding is not yet live. After go-live the normal
 * session + membership guard applies.
 *
 * Secret: ONBOARDING_TOKEN_SECRET, else the Supabase service-role key (always
 * present in real mode), else a per-process random secret (simulated/zero-env
 * mode, whose state is per-process anyway). Never read at module load.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { getPosDriver } from "@/lib/db";
import type { SessionUser } from "./session";
import { requireTenantAccess, type GuardFailure } from "./tenant-guard";

export const ONBOARDING_TOKEN_HEADER = "x-onboarding-token";

/** Token lifetime: long enough to finish the wizard, short enough to expire. */
const TTL_MS = 24 * 60 * 60 * 1000;

let processSecret: string | null = null;

function secret(): string {
  const configured =
    process.env.ONBOARDING_TOKEN_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (configured) return configured;
  if (!processSecret) processSecret = randomBytes(32).toString("hex");
  return processSecret;
}

function mac(payload: string): string {
  return createHmac("sha256", secret())
    .update(`onboarding:v1:${payload}`)
    .digest("hex");
}

/** Mint a token for a freshly-created tenant. */
export function signOnboardingToken(tenantId: string, now = Date.now()): string {
  const exp = String(now + TTL_MS);
  const payload = `${tenantId}.${exp}`;
  return `${payload}.${mac(payload)}`;
}

/** Verify a token's signature, expiry and tenant binding (pure, no I/O). */
export function verifyOnboardingToken(
  token: string | null | undefined,
  tenantId: string,
  now = Date.now(),
): boolean {
  if (!token || !tenantId) return false;
  const lastDot = token.lastIndexOf(".");
  if (lastDot <= 0) return false;
  const payload = token.slice(0, lastDot);
  const sig = token.slice(lastDot + 1);
  const expDot = payload.lastIndexOf(".");
  if (expDot <= 0) return false;
  const boundTenant = payload.slice(0, expDot);
  const exp = Number(payload.slice(expDot + 1));
  if (boundTenant !== tenantId) return false;
  if (!Number.isFinite(exp) || exp < now) return false;
  const expected = Buffer.from(mac(payload), "hex");
  let given: Buffer;
  try {
    given = Buffer.from(sig, "hex");
  } catch {
    return false;
  }
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * Whether the request carries a valid onboarding token for `tenantId` AND the
 * tenant has not gone live yet (tokens stop working after go-live).
 */
export async function hasOnboardingAccess(
  request: Request,
  tenantId: string,
): Promise<boolean> {
  const token = request.headers.get(ONBOARDING_TOKEN_HEADER);
  if (!verifyOnboardingToken(token, tenantId)) return false;
  const onboarding = await getPosDriver().getOnboarding(tenantId);
  return Boolean(onboarding && !onboarding.live);
}

/**
 * Authorize a tenant-admin action that the PUBLIC signup wizard also performs
 * (Connect onboarding, plan subscription, wizard steps): allowed for an
 * owner|manager session of the tenant, OR for a valid onboarding token while
 * the tenant is still onboarding. Returns the session user when there is one.
 */
export async function requireTenantAdminOrOnboarding(
  request: Request,
  tenantId: string | null | undefined,
): Promise<
  | {
      ok: true;
      tenantId: string;
      user: SessionUser | null;
      via: "session" | "onboarding";
    }
  | GuardFailure
> {
  if (tenantId && (await hasOnboardingAccess(request, tenantId))) {
    return { ok: true, tenantId, user: null, via: "onboarding" };
  }
  const auth = await requireTenantAccess(tenantId, "admin");
  if (!auth.ok) return auth;
  return { ok: true, tenantId: auth.tenantId, user: auth.user, via: "session" };
}
