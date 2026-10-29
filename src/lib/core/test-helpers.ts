/**
 * Test helpers for the core layer: mint hub-style ES256 JWTs and a matching
 * in-memory JWKS fetch. Not imported by app code.
 */
import { CORE_TOKEN_AUDIENCE } from "@openpizza/core";

function b64url(input: Uint8Array | string): string {
  const bytes =
    typeof input === "string" ? new TextEncoder().encode(input) : input;
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export interface TestHub {
  jwksUrl: string;
  /** fetch stub serving the JWKS (counts calls). */
  fetch: typeof fetch;
  fetchCalls: () => number;
  sign: (claims: Record<string, unknown>, opts?: { kid?: string }) => Promise<string>;
  /** A second keypair that is NOT in the JWKS (for bad-signature tests). */
  rogue: TestHub["sign"];
}

async function keypair() {
  return globalThis.crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
}

async function signWith(
  privateKey: CryptoKey,
  kid: string,
  claims: Record<string, unknown>,
): Promise<string> {
  const header = b64url(JSON.stringify({ alg: "ES256", typ: "JWT", kid }));
  const payload = b64url(JSON.stringify(claims));
  const sig = new Uint8Array(
    await globalThis.crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      privateKey,
      new TextEncoder().encode(`${header}.${payload}`),
    ),
  );
  return `${header}.${payload}.${b64url(sig)}`;
}

export async function createTestHub(kid = "test-key-1"): Promise<TestHub> {
  const good = await keypair();
  const bad = await keypair();
  const jwk = {
    ...(await globalThis.crypto.subtle.exportKey("jwk", good.publicKey)),
    kid,
    alg: "ES256",
    use: "sig",
  };
  const jwksUrl = "https://hub.test/.well-known/jwks.json";
  let calls = 0;
  const fakeFetch = (async (url: string | URL | Request) => {
    if (String(url) !== jwksUrl) return new Response("nope", { status: 404 });
    calls += 1;
    return new Response(JSON.stringify({ keys: [jwk] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return {
    jwksUrl,
    fetch: fakeFetch,
    fetchCalls: () => calls,
    sign: (claims, opts) => signWith(good.privateKey, opts?.kid ?? kid, claims),
    rogue: (claims, opts) => signWith(bad.privateKey, opts?.kid ?? kid, claims),
  };
}

export function claimsFor(
  tenantId: string,
  scope: string,
  extra: Record<string, unknown> = {},
  nowMs = Date.now(),
): Record<string, unknown> {
  const iat = Math.floor(nowMs / 1000);
  return {
    iss: "https://hub.test",
    aud: CORE_TOKEN_AUDIENCE,
    sub: "client-guests",
    tid: tenantId,
    scope,
    op_mod: "guests",
    iat,
    exp: iat + 600,
    ...extra,
  };
}
