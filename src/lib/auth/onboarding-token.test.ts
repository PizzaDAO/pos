import { describe, expect, it } from "vitest";
import {
  signOnboardingToken,
  verifyOnboardingToken,
} from "./onboarding-token";

describe("onboarding capability token", () => {
  it("verifies only for the tenant it was minted for", () => {
    const token = signOnboardingToken("tenant-a");
    expect(verifyOnboardingToken(token, "tenant-a")).toBe(true);
    expect(verifyOnboardingToken(token, "tenant-b")).toBe(false);
  });

  it("rejects expired, tampered, and missing tokens", () => {
    const old = signOnboardingToken("tenant-a", Date.now() - 48 * 3600_000);
    expect(verifyOnboardingToken(old, "tenant-a")).toBe(false);

    const token = signOnboardingToken("tenant-a");
    const [tenant, exp, sig] = token.split(".");
    // Extending the expiry invalidates the MAC.
    expect(
      verifyOnboardingToken(`${tenant}.${Number(exp) + 1}.${sig}`, "tenant-a"),
    ).toBe(false);
    // Re-binding to another tenant invalidates the MAC.
    expect(
      verifyOnboardingToken(`tenant-b.${exp}.${sig}`, "tenant-b"),
    ).toBe(false);
    expect(verifyOnboardingToken(null, "tenant-a")).toBe(false);
    expect(verifyOnboardingToken("garbage", "tenant-a")).toBe(false);
  });
});
