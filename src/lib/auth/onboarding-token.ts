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
 * Secret: see ./signing-secret — ONBOARDING_TOKEN_SECRET or the service-role
 * key; in real mode with neither, signing THROWS and verification fails
 * (fail closed). Never read at module load.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { signingSecret } from "./signing-secret";
import { getPosDriver } from "@/lib/db";
import type { SessionUser } from "./session";
import { requireTenantAccess, type GuardFailure } from "./tenant-guard";
import { requireTenantRole } from "./api";

export const ONBOARDING_TOKEN_HEADER = "x-onboarding-token";

/** Token lifetime: long enough to finish the wizard, short enough to expire. */
const TTL_MS = 24 * 60 * 60 * 1000;

/** Thrown when no signing secret is configured in real mode (fail closed). */
export class SigningSecretMissingError extends Error {
  constructor() {
    super(
      "Server signing secret is not configured (set ONBOARDING_TOKEN_SECRET).",
    );
    this.name = "SigningSecretMissingError";
  }
}

function mac(payload: string): string | null {
  const key = signingSecret();
  if (!key) return null;
  return createHmac("sha256", key)
    .update(`onboarding:v1:${payload}`)
    .digest("hex");
}

/** Mint a token for a freshly-created tenant. Throws if no secret (real mode). */
export function signOnboardingToken(tenantId: string, now = Date.now()): string {
  const exp = String(now + TTL_MS);
  const payload = `${tenantId}.${exp}`;
  const sig = mac(payload);
  if (!sig) throw new SigningSecretMissingError();
  return `${payload}.${sig}`;
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
  const expectedHex = mac(payload);
  if (!expectedHex) return false; // no secret in real mode → fail closed
  const expected = Buffer.from(expectedHex, "hex");
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
  if (tenantId) {
    // Same session gate main uses for tenant-admin routes (owner|manager).
    const auth = await requireTenantRole(tenantId, ["owner", "manager"]);
    if (!auth.ok) return auth;
    return { ok: true, tenantId, user: auth.user, via: "session" };
  }
  // No tenant named: the caller's single owner|manager tenant (400 if several).
  const auth = await requireTenantAccess(tenantId, "admin");
  if (!auth.ok) return auth;
  return { ok: true, tenantId: auth.tenantId, user: auth.user, via: "session" };
}
