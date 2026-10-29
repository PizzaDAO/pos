import { beforeEach, describe, expect, it } from "vitest";
import { DEMO_TENANT_ID } from "@/lib/db";
import { DEV_TOKEN, authenticateV1, resetJwksCache } from "./auth";
import { claimsFor, createTestHub } from "./test-helpers";

function req(token?: string): Request {
  return new Request("https://pos.test/api/v1/tenant", {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

const NOW = Date.UTC(2026, 5, 1, 12, 0, 0);
const ISS = "https://hub.test";

beforeEach(() => resetJwksCache());

describe("authenticateV1 (zero-env simulated mode)", () => {
  it("accepts the dev token as the demo tenant with all scopes", async () => {
    const p = await authenticateV1(req(DEV_TOKEN), { env: {} });
    expect(p.tenant_id).toBe(DEMO_TENANT_ID);
    expect(p.scopes).toEqual(["*"]);
  });

  it("rejects a missing or wrong token", async () => {
    await expect(authenticateV1(req(), { env: {} })).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
    await expect(authenticateV1(req("nope"), { env: {} })).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
  });
});

describe("authenticateV1 (hub JWKS)", () => {
  it("verifies a hub JWT and takes the tenant from the claim", async () => {
    const hub = await createTestHub();
    const tid = "20000000-0000-4000-8000-000000000009";
    const token = await hub.sign(
      claimsFor(tid, "orders:read menu:read", { lids: [DEMO_TENANT_ID] }, NOW),
    );
    const p = await authenticateV1(req(token), {
      env: { OPENPIZZA_HUB_JWKS_URL: hub.jwksUrl, OPENPIZZA_HUB_ISSUER: ISS },
      fetch: hub.fetch,
      now: () => NOW,
    });
    expect(p.tenant_id).toBe(tid);
    expect(p.scopes).toEqual(["orders:read", "menu:read"]);
    expect(p.location_ids).toEqual([DEMO_TENANT_ID]);
    expect(p.module).toBe("guests");
  });

  it("caches the JWKS across requests", async () => {
    const hub = await createTestHub();
    const deps = {
      env: { OPENPIZZA_HUB_JWKS_URL: hub.jwksUrl, OPENPIZZA_HUB_ISSUER: ISS },
      fetch: hub.fetch,
      now: () => NOW,
    };
    const token = await hub.sign(claimsFor(DEMO_TENANT_ID, "*", {}, NOW));
    await authenticateV1(req(token), deps);
    await authenticateV1(req(token), deps);
    expect(hub.fetchCalls()).toBe(1);
  });

  it("rejects the dev token once a JWKS is configured", async () => {
    const hub = await createTestHub();
    await expect(
      authenticateV1(req(DEV_TOKEN), {
        env: { OPENPIZZA_HUB_JWKS_URL: hub.jwksUrl, OPENPIZZA_HUB_ISSUER: ISS },
        fetch: hub.fetch,
        now: () => NOW,
      }),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it.each([
    ["expired", { exp: Math.floor(NOW / 1000) - 3600 }],
    ["wrong audience", { aud: "someone:else" }],
    ["not yet valid", { nbf: Math.floor(NOW / 1000) + 3600 }],
    ["bad tenant claim", { tid: "not-a-uuid" }],
  ])("rejects a token that is %s", async (_name, extra) => {
    const hub = await createTestHub();
    const token = await hub.sign(claimsFor(DEMO_TENANT_ID, "*", extra, NOW));
    await expect(
      authenticateV1(req(token), {
        env: { OPENPIZZA_HUB_JWKS_URL: hub.jwksUrl, OPENPIZZA_HUB_ISSUER: ISS },
        fetch: hub.fetch,
        now: () => NOW,
      }),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("rejects a token signed by an unknown key", async () => {
    const hub = await createTestHub();
    const token = await hub.rogue(claimsFor(DEMO_TENANT_ID, "*", {}, NOW));
    await expect(
      authenticateV1(req(token), {
        env: { OPENPIZZA_HUB_JWKS_URL: hub.jwksUrl, OPENPIZZA_HUB_ISSUER: ISS },
        fetch: hub.fetch,
        now: () => NOW,
      }),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("rejects a tampered payload", async () => {
    const hub = await createTestHub();
    const token = await hub.sign(claimsFor(DEMO_TENANT_ID, "orders:read", {}, NOW));
    const [h, , s] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify(claimsFor("20000000-0000-4000-8000-0000000000aa", "*", {}, NOW)),
    ).toString("base64url");
    await expect(
      authenticateV1(req(`${h}.${forged}.${s}`), {
        env: { OPENPIZZA_HUB_JWKS_URL: hub.jwksUrl, OPENPIZZA_HUB_ISSUER: ISS },
        fetch: hub.fetch,
        now: () => NOW,
      }),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("enforces a pinned issuer", async () => {
    const hub = await createTestHub();
    const token = await hub.sign(claimsFor(DEMO_TENANT_ID, "*", {}, NOW));
    await expect(
      authenticateV1(req(token), {
        env: {
          OPENPIZZA_HUB_JWKS_URL: hub.jwksUrl,
          OPENPIZZA_HUB_ISSUER: "https://evil.test",
        },
        fetch: hub.fetch,
        now: () => NOW,
      }),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("fails closed when a JWKS is set without a pinned issuer", async () => {
    const hub = await createTestHub();
    const token = await hub.sign(claimsFor(DEMO_TENANT_ID, "*", {}, NOW));
    await expect(
      authenticateV1(req(token), {
        env: { OPENPIZZA_HUB_JWKS_URL: hub.jwksUrl },
        fetch: hub.fetch,
        now: () => NOW,
      }),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });
});

describe("JWKS fetch failures", () => {
  const env = { OPENPIZZA_HUB_JWKS_URL: "https://hub.test/jwks", OPENPIZZA_HUB_ISSUER: ISS };

  it("backs off after a failure instead of refetching on every request", async () => {
    let calls = 0;
    const down = (async () => {
      calls += 1;
      return new Response("oops", { status: 503 });
    }) as unknown as typeof fetch;
    let now = NOW;
    const hub = await createTestHub();
    const token = await hub.sign(claimsFor(DEMO_TENANT_ID, "*", {}, NOW));
    for (let i = 0; i < 5; i++) {
      await expect(
        authenticateV1(req(token), { env, fetch: down, now: () => now }),
      ).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
    }
    expect(calls).toBe(1);
    now += 6_000; // past the first backoff step
    await expect(
      authenticateV1(req(token), { env, fetch: down, now: () => now }),
    ).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
    expect(calls).toBe(2);
  });

  it("answers a Problem (not a 500) for a non-JSON JWKS", async () => {
    const html = (async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch;
    const hub = await createTestHub();
    const token = await hub.sign(claimsFor(DEMO_TENANT_ID, "*", {}, NOW));
    await expect(
      authenticateV1(req(token), { env, fetch: html, now: () => NOW }),
    ).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
  });
});
