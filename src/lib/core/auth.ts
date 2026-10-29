/**
 * `/api/v1` authentication.
 *
 * Bearer token = a hub-issued JWT (ES256/RS256/EdDSA, audience
 * `openpizza:api`) verified against the JWKS at `OPENPIZZA_HUB_JWKS_URL`
 * (optionally pinning `OPENPIZZA_HUB_ISSUER`). The TENANT comes from the token
 * claim `tid` ONLY — never from a query/body parameter — and the optional `lids`
 * claim restricts locations. Scope checks run per route against `V1_ROUTES`.
 *
 * SIMULATED MODE (zero env: no Supabase config AND no JWKS URL): the fixed dev
 * token {@link DEV_TOKEN} authenticates as the demo tenant with every scope so
 * the whole API works in previews, tests and e2e. As soon as a JWKS URL is set
 * the dev token is rejected.
 *
 * Verification uses WebCrypto only (no dependency); keys are cached per JWKS URL
 * and refetched at most every 30s on an unknown `kid`.
 */
import {
  CORE_TOKEN_AUDIENCE,
  CoreTokenClaimsSchema,
  ProblemError,
  principalFromClaims,
  type Principal,
} from "@openpizza/core";
import { DEMO_TENANT_ID } from "@/lib/db/seed-data";
import { getPosDriver } from "@/lib/db";

export const DEV_TOKEN = "dev-openpizza-token";

export interface AuthDeps {
  /** Env lookup (default `process.env`). */
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  /** Clock in ms (default Date.now). */
  now?: () => number;
}

interface Jwk {
  kid?: string;
  kty: string;
  alg?: string;
  use?: string;
  [k: string]: unknown;
}

const JWKS_TTL_MS = 10 * 60_000;
const JWKS_MIN_REFETCH_MS = 30_000;
const CLOCK_SKEW_S = 30;

interface JwksEntry {
  keys: Jwk[];
  /** Last time we TRIED to fetch (success or failure). */
  fetchedAt: number;
  /** No refetch before this instant after failures (exponential backoff). */
  retryAt: number;
  failures: number;
}

const BACKOFF_BASE_MS = 5_000;
const BACKOFF_MAX_MS = 5 * 60_000;
const jwksCache = new Map<string, JwksEntry>();

/** Test helper: forget cached JWKS. */
export function resetJwksCache(): void {
  jwksCache.clear();
}

function b64urlToBytes(s: string): Uint8Array {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function decodeJson(part: string): unknown {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(part)));
}

function unauthenticated(detail: string): ProblemError {
  return ProblemError.of("UNAUTHENTICATED", { detail });
}

async function loadJwks(
  url: string,
  deps: Required<Pick<AuthDeps, "fetch" | "now">>,
  force: boolean,
): Promise<Jwk[]> {
  const cached = jwksCache.get(url);
  const now = deps.now();
  if (cached) {
    // Negative cache: after a failure, do not hammer the hub.
    if (now < cached.retryAt) {
      if (cached.keys.length > 0) return cached.keys;
      throw ProblemError.of("UPSTREAM_UNAVAILABLE", {
        detail: "The hub JWKS is temporarily unavailable.",
      });
    }
    const age = now - cached.fetchedAt;
    if (cached.keys.length > 0) {
      if (!force && age < JWKS_TTL_MS) return cached.keys;
      if (force && age < JWKS_MIN_REFETCH_MS) return cached.keys;
    }
  }
  const fail = (detail: string): never => {
    const failures = (cached?.failures ?? 0) + 1;
    jwksCache.set(url, {
      keys: cached?.keys ?? [],
      fetchedAt: now,
      retryAt: now + Math.min(BACKOFF_BASE_MS * 2 ** (failures - 1), BACKOFF_MAX_MS),
      failures,
    });
    if (cached && cached.keys.length > 0) {
      // Keep serving the last good keys while the hub is down.
      throw new StaleKeys(cached.keys);
    }
    throw ProblemError.of("UPSTREAM_UNAVAILABLE", { detail });
  };
  try {
    let res: Response;
    try {
      res = await deps.fetch(url, { headers: { accept: "application/json" } });
    } catch {
      return fail("Could not fetch the hub JWKS.");
    }
    if (!res.ok) return fail(`Hub JWKS returned HTTP ${res.status}.`);
    let body: { keys?: Jwk[] };
    try {
      body = (await res.json()) as { keys?: Jwk[] };
    } catch {
      return fail("Hub JWKS is not valid JSON.");
    }
    const keys = Array.isArray(body?.keys) ? body.keys : [];
    if (keys.length === 0) return fail("Hub JWKS has no keys.");
    jwksCache.set(url, { keys, fetchedAt: now, retryAt: 0, failures: 0 });
    return keys;
  } catch (e) {
    if (e instanceof StaleKeys) return e.keys;
    throw e;
  }
}

class StaleKeys extends Error {
  constructor(readonly keys: Jwk[]) {
    super("stale");
  }
}

function algParams(alg: string): {
  import: AlgorithmIdentifier | RsaHashedImportParams | EcKeyImportParams;
  verify: AlgorithmIdentifier | EcdsaParams;
} | null {
  switch (alg) {
    case "ES256":
      return {
        import: { name: "ECDSA", namedCurve: "P-256" },
        verify: { name: "ECDSA", hash: "SHA-256" },
      };
    case "RS256":
      return {
        import: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        verify: { name: "RSASSA-PKCS1-v1_5" },
      };
    case "EdDSA":
      return { import: { name: "Ed25519" }, verify: { name: "Ed25519" } };
    default:
      return null;
  }
}

/** Verify a compact JWT against the JWKS; returns the raw claims. */
export async function verifyHubJwt(
  token: string,
  jwksUrl: string,
  deps: Required<Pick<AuthDeps, "fetch" | "now">> & { issuer?: string },
): Promise<unknown> {
  const parts = token.split(".");
  if (parts.length !== 3) throw unauthenticated("Malformed bearer token.");
  const [h, p, sig] = parts as [string, string, string];

  let header: { alg?: string; kid?: string };
  let payload: unknown;
  try {
    header = decodeJson(h) as { alg?: string; kid?: string };
    payload = decodeJson(p);
  } catch {
    throw unauthenticated("Malformed bearer token.");
  }
  const alg = algParams(header.alg ?? "");
  if (!alg) throw unauthenticated("Unsupported token algorithm.");

  const pick = (keys: Jwk[]): Jwk | undefined =>
    keys.find(
      (k) =>
        (header.kid ? k.kid === header.kid : true) &&
        (k.use === undefined || k.use === "sig") &&
        (k.alg === undefined || k.alg === header.alg),
    );
  let jwk = pick(await loadJwks(jwksUrl, deps, false));
  if (!jwk) jwk = pick(await loadJwks(jwksUrl, deps, true));
  if (!jwk) throw unauthenticated("Unknown signing key.");

  let ok = false;
  try {
    const key = await globalThis.crypto.subtle.importKey(
      "jwk",
      jwk as JsonWebKey,
      alg.import,
      false,
      ["verify"],
    );
    ok = await globalThis.crypto.subtle.verify(
      alg.verify,
      key,
      b64urlToBytes(sig) as BufferSource,
      new TextEncoder().encode(`${h}.${p}`) as BufferSource,
    );
  } catch {
    ok = false;
  }
  if (!ok) throw unauthenticated("Invalid token signature.");

  const c = payload as Record<string, unknown>;
  const nowS = Math.floor(deps.now() / 1000);
  if (typeof c.exp !== "number" || c.exp + CLOCK_SKEW_S < nowS) {
    throw unauthenticated("Token expired.");
  }
  if (typeof c.nbf === "number" && c.nbf - CLOCK_SKEW_S > nowS) {
    throw unauthenticated("Token not yet valid.");
  }
  const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (!aud.includes(CORE_TOKEN_AUDIENCE)) {
    throw unauthenticated("Token audience is not openpizza:api.");
  }
  if (deps.issuer && c.iss !== deps.issuer) {
    throw unauthenticated("Token issuer is not trusted.");
  }
  return payload;
}

/**
 * True when `/api/v1` runs in zero-env simulated mode: the in-memory mock
 * driver is active, no JWKS is configured, and this is not a production deploy.
 */
export function isSimulatedV1(env: Record<string, string | undefined>): boolean {
  return (
    getPosDriver().name === "mock" &&
    !env.OPENPIZZA_HUB_JWKS_URL &&
    env.VERCEL_ENV !== "production"
  );
}

/** Authenticate a request; throws `ProblemError` (401/502) on failure. */
export async function authenticateV1(
  req: Request,
  deps: AuthDeps = {},
): Promise<Principal> {
  const env = deps.env ?? process.env;
  const header = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(header);
  if (!m) throw unauthenticated("Missing bearer token.");
  const token = m[1]!.trim();

  const jwksUrl = env.OPENPIZZA_HUB_JWKS_URL;
  if (!jwksUrl) {
    if (isSimulatedV1(env) && token === DEV_TOKEN) {
      return {
        kind: "service",
        id: "dev",
        tenant_id: DEMO_TENANT_ID,
        location_ids: null,
        scopes: ["*"],
        module: null,
      };
    }
    throw unauthenticated(
      isSimulatedV1(env)
        ? "Invalid dev token."
        : "Bearer verification is not configured (OPENPIZZA_HUB_JWKS_URL).",
    );
  }

  // Fail closed: a JWKS without a pinned issuer would trust any issuer
  // that happens to share the signing keys.
  const issuer = env.OPENPIZZA_HUB_ISSUER;
  if (!issuer) {
    throw unauthenticated(
      "Bearer verification is misconfigured (OPENPIZZA_HUB_ISSUER is required with OPENPIZZA_HUB_JWKS_URL).",
    );
  }
  const raw = await verifyHubJwt(token, jwksUrl, {
    fetch: deps.fetch ?? globalThis.fetch.bind(globalThis),
    now: deps.now ?? Date.now,
    issuer,
  });
  const claims = CoreTokenClaimsSchema.safeParse(raw);
  if (!claims.success) throw unauthenticated("Token claims are invalid.");
  return principalFromClaims(claims.data);
}
