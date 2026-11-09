/** Location POST: timezone is stored canonical; abbreviations and non-strings are refused. */
import { describe, expect, it, vi } from "vitest";
import { DEMO_TENANT_ID } from "@/lib/db";

vi.mock("@/lib/auth/tenant-guard", () => ({
  requireTenantAccess: async (tenantId: string | null) => ({
    ok: true,
    tenantId: tenantId ?? DEMO_TENANT_ID,
    locationId: null,
    user: { id: "u", email: "o@example.com" },
  }),
}));
vi.mock("@/lib/saas/entitlements", async (orig) => ({
  ...(await orig<typeof import("@/lib/saas/entitlements")>()),
  canAddLocation: () => ({ allowed: true }),
}));

import { POST } from "./route";

const post = (timezone: unknown) =>
  POST(
    new Request("https://pos.test/api/admin/locations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenantId: DEMO_TENANT_ID, name: `Loc ${Math.random()}`, timezone }),
    }),
  );

describe("POST /api/admin/locations timezone", () => {
  it("rejects abbreviations, unknown zones and non-strings with 422", async () => {
    for (const tz of ["EST", "Nope/Zone", 5, {}, ["America/New_York"], true]) {
      expect((await post(tz)).status).toBe(422);
    }
  });
  it("stores the canonical zone; null/missing uses the default", async () => {
    const ok = await post("America/Chicago");
    expect(ok.status).toBe(201);
    expect((await ok.json()).location.timezone).toBe("America/Chicago");
    for (const tz of [null, undefined, ""]) {
      const res = await post(tz);
      expect(res.status).toBe(201);
      expect((await res.json()).location.timezone).toBeTruthy();
    }
  });
});
