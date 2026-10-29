import { afterEach, describe, expect, it } from "vitest";
import { getPosDriver } from "@/lib/db";
import {
  SigningSecretMissingError,
  signOnboardingToken,
  verifyOnboardingToken,
} from "./onboarding-token";
import { POST as signupPOST } from "@/app/api/signup/route";

afterEach(() => {
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  delete process.env.ONBOARDING_TOKEN_SECRET;
});

function realAuthEnv() {
  // Resolve the (mock) driver first so the env change doesn't swap it.
  getPosDriver();
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
}

describe("onboarding token secret (fail closed in real mode)", () => {
  it("refuses to sign or verify without a configured secret in real mode", () => {
    const token = signOnboardingToken("tenant-x"); // demo mode: works
    realAuthEnv();
    expect(() => signOnboardingToken("tenant-x")).toThrow(
      SigningSecretMissingError,
    );
    expect(verifyOnboardingToken(token, "tenant-x")).toBe(false);

    process.env.ONBOARDING_TOKEN_SECRET = "configured-secret";
    const ok = signOnboardingToken("tenant-x");
    expect(verifyOnboardingToken(ok, "tenant-x")).toBe(true);
  });

  it("signup create_business returns 503 (and creates nothing) without a secret in real mode", async () => {
    realAuthEnv();
    const before = (await getPosDriver().listTenants()).length;
    const res = await signupPOST(
      new Request("http://localhost/api/signup", {
        method: "POST",
        body: JSON.stringify({
          action: "create_business",
          businessName: "No Secret Pizza",
          ownerEmail: "nosecret@example.com",
        }),
      }),
    );
    expect(res.status).toBe(503);
    expect((await getPosDriver().listTenants()).length).toBe(before);
  });
});

describe("go_live refuses a platform-suspended tenant", () => {
  it("403s after a platform suspend, works after reactivate", async () => {
    const created = await signupPOST(
      new Request("http://localhost/api/signup", {
        method: "POST",
        body: JSON.stringify({
          action: "create_business",
          businessName: `Suspend Test ${Date.now()}`,
          ownerEmail: "suspend@example.com",
        }),
      }),
    );
    const { tenant, onboardingToken } = (await created.json()) as {
      tenant: { id: string };
      onboardingToken: string;
    };
    const goLive = () =>
      signupPOST(
        new Request("http://localhost/api/signup", {
          method: "POST",
          headers: { "x-onboarding-token": onboardingToken },
          body: JSON.stringify({ action: "go_live", tenantId: tenant.id }),
        }),
      );

    await getPosDriver().appendAuditLog({
      actor_user_id: "ops",
      actor_label: "ops",
      action: "tenant_suspend",
      tenant_id: tenant.id,
      detail: "suspended by platform",
    });
    expect((await goLive()).status).toBe(403);
    expect((await getPosDriver().getTenant(tenant.id))?.status).toBe(
      "suspended",
    );

    await new Promise((r) => setTimeout(r, 5));
    await getPosDriver().appendAuditLog({
      actor_user_id: "ops",
      actor_label: "ops",
      action: "tenant_reactivate",
      tenant_id: tenant.id,
      detail: "reactivated",
    });
    expect((await goLive()).status).toBe(200);
  });
});
