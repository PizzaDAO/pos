/**
 * Hub access for the outbound `openpizza_driver` provider (server-only).
 *
 * POS authenticates to the hub as the first-party `pos` MODULE client
 * (client_credentials; `tenant_id` is sent per token request, one client serves
 * every tenant) and uses that `pos` service token to call the driver deployment
 * the tenant registered in the hub.
 *
 * Everything is gated and INERT by default:
 *   1. `OPENPIZZA_DRIVER_TENANTS` (comma list) must contain the tenant. Empty or
 *      unset = off for every tenant.
 *   2. The hub client env must be set: OPENPIZZA_HUB_URL, OPENPIZZA_POS_CLIENT_ID,
 *      OPENPIZZA_POS_CLIENT_SECRET.
 *   3. The hub must list an ACTIVE `openpizza_driver` delivery registration with an
 *      https base_url (cached 60 s per tenant; any hub failure = not available).
 *
 * Nothing here reads env at module load, and no token is ever logged.
 */
import { createClientCredentialsTokenSource } from "@openpizza/core";
import { captureError } from "@/lib/observability";

export const DRIVER_KEY = "openpizza_driver";
export const REGISTRATION_TTL_MS = 60_000;
const HUB_TIMEOUT_MS = 5_000;
/** A hub registration/token failure is remembered (as "none") this long. */
export const FAILURE_TTL_MS = 30_000;

/** Global fetch with a hard timeout (the token source has none of its own). */
const timeoutFetch: typeof fetch = (input, init) =>
  fetch(input, { ...init, signal: AbortSignal.timeout(HUB_TIMEOUT_MS) });

export interface DriverHubConfig {
  hubUrl: string;
  clientId: string;
  clientSecret: string;
}

export function driverTenants(): Set<string> {
  return new Set(
    (process.env.OPENPIZZA_DRIVER_TENANTS ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function isDriverTenant(tenantId: string): boolean {
  return driverTenants().has(tenantId.trim().toLowerCase());
}

export function getDriverHubConfig(): DriverHubConfig | null {
  const hubUrl = process.env.OPENPIZZA_HUB_URL?.trim();
  const clientId = process.env.OPENPIZZA_POS_CLIENT_ID?.trim();
  const clientSecret = process.env.OPENPIZZA_POS_CLIENT_SECRET?.trim();
  if (!hubUrl || !clientId || !clientSecret) return null;
  return { hubUrl: hubUrl.replace(/\/+$/, ""), clientId, clientSecret };
}

// ---- token -----------------------------------------------------------------

const tokenSources = new Map<string, () => Promise<string>>();

/** A cached `pos` service-token getter for one tenant. */
export function hubTokenFor(
  tenantId: string,
  cfg: DriverHubConfig,
): () => Promise<string> {
  const key = `${cfg.hubUrl}|${cfg.clientId}|${tenantId}`;
  let src = tokenSources.get(key);
  if (!src) {
    const inner = createClientCredentialsTokenSource({
      tokenUrl: `${cfg.hubUrl}/oauth/token`,
      clientId: cfg.clientId,
      clientSecret: cfg.clientSecret,
      tenantId,
      scope: "deliveries:write providers:read",
      fetch: timeoutFetch,
    });
    src = async () => {
      try {
        return await inner();
      } catch (err) {
        // A refused client is a configuration problem somebody must see.
        const code = (err as { code?: string }).code;
        if (code === "INVALID_CLIENT" || code === "UNAUTHENTICATED") {
          console.error(
            `[pos][ALERT] hub refused the pos module client (${code}) for tenant ${tenantId}`,
          );
        }
        throw err;
      }
    };
    tokenSources.set(key, src);
  }
  return src;
}

// ---- registration lookup ----------------------------------------------------

export interface DriverRegistration {
  baseUrl: string;
}

const registrations = new Map<
  string,
  { at: number; ttl: number; value: DriverRegistration | null }
>();

/** Test hook: forget cached tokens and registrations. */
export function resetDriverHubCache(): void {
  tokenSources.clear();
  registrations.clear();
}

function rows(json: unknown): unknown[] {
  if (Array.isArray(json)) return json;
  if (json && typeof json === "object") {
    const o = json as Record<string, unknown>;
    for (const k of ["data", "items", "providers"]) {
      if (Array.isArray(o[k])) return o[k] as unknown[];
    }
  }
  return [];
}

/**
 * The tenant's active `openpizza_driver` registration with an https base_url, or
 * null. Throws on a hub failure (callers decide: availability treats it as "not
 * available", dispatch treats it as retryable). Cached for 60 s per tenant.
 */
export async function lookupDriverRegistration(
  tenantId: string,
  cfg: DriverHubConfig,
  fetchImpl: typeof fetch = fetch,
  now: number = Date.now(),
): Promise<DriverRegistration | null> {
  const key = `${cfg.hubUrl}|${tenantId}`;
  const hit = registrations.get(key);
  if (hit && now - hit.at < hit.ttl) return hit.value;

  let json: unknown;
  try {
    const token = await hubTokenFor(tenantId, cfg)();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), HUB_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetchImpl(`${cfg.hubUrl}/v1/providers?kind=delivery`, {
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw new Error(`hub providers.list failed: HTTP ${res.status}`);
    json = await res.json().catch(() => null);
  } catch (err) {
    // Remember the failure as "none" for 30 s so a down hub is not hammered by
    // every quote and retry. The first caller still sees the error.
    registrations.set(key, { at: now, ttl: FAILURE_TTL_MS, value: null });
    throw err;
  }
  const found = rows(json).find((r) => {
    const o = r as Record<string, unknown>;
    return (
      o &&
      o.key === DRIVER_KEY &&
      (o.kind === undefined || o.kind === "delivery")
    );
  }) as Record<string, unknown> | undefined;

  let value: DriverRegistration | null = null;
  if (
    found &&
    found.status === "active" &&
    typeof found.base_url === "string"
  ) {
    try {
      if (new URL(found.base_url).protocol === "https:") {
        value = { baseUrl: found.base_url };
      }
    } catch {
      /* not a URL: unavailable */
    }
  }
  registrations.set(key, { at: now, ttl: REGISTRATION_TTL_MS, value });
  return value;
}

/** All three locks (the location's own provider list is checked by the caller). */
export async function isDriverAvailable(
  tenantId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  if (!isDriverTenant(tenantId)) return false;
  const cfg = getDriverHubConfig();
  if (!cfg) return false;
  try {
    return (await lookupDriverRegistration(tenantId, cfg, fetchImpl)) !== null;
  } catch (err) {
    captureError(err, { scope: "driver-availability", tenantId });
    return false;
  }
}
