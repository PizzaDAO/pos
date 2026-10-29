import { describe, it, expect, afterEach, vi } from "vitest";
import * as db from "@/lib/db";
import {
  TRAINING_BANNER_STRIPE_TEST,
  demoModeInfo,
  isTrainingMode,
  isTrainingModeEnv,
  TRAINING_BANNER,
  TRAINING_BANNER_STRIPE,
} from "@/lib/demo/mode";

afterEach(() => {
  delete process.env.TRAINING_MODE;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("training / demo mode", () => {
  it("reads the TRAINING_MODE env flag (off by default)", () => {
    expect(isTrainingModeEnv()).toBe(false);
    process.env.TRAINING_MODE = "1";
    expect(isTrainingModeEnv()).toBe(true);
    process.env.TRAINING_MODE = "true";
    expect(isTrainingModeEnv()).toBe(true);
    process.env.TRAINING_MODE = "off";
    expect(isTrainingModeEnv()).toBe(false);
  });

  it("treats the mock driver as training mode (no live data)", () => {
    // The current build runs on the mock driver → training mode is on.
    expect(isTrainingMode()).toBe(true);
  });

  it("exposes a banner + driver name for surfaces", () => {
    const info = demoModeInfo();
    expect(info.driver).toBe("mock");
    expect(info.trainingMode).toBe(true);
    expect(info.banner).toMatch(/TRAINING/i);
  });

  it("is ON on the supabase driver while the Stripe secret key is unset", () => {
    vi.spyOn(db, "getPosDriver").mockReturnValue({
      name: "supabase",
    } as unknown as ReturnType<typeof db.getPosDriver>);
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    expect(isTrainingMode()).toBe(true);
    const info = demoModeInfo();
    expect(info.driver).toBe("supabase");
    expect(info.trainingMode).toBe(true);
    expect(info.reason).toBe("stripe-unset");
    expect(info.banner).toBe(TRAINING_BANNER_STRIPE);
  });

  it("uses the full simulated copy for the mock driver and the flag", () => {
    expect(demoModeInfo().reason).toBe("mock");
    expect(demoModeInfo().banner).toBe(TRAINING_BANNER);
    vi.spyOn(db, "getPosDriver").mockReturnValue({
      name: "supabase",
    } as unknown as ReturnType<typeof db.getPosDriver>);
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    vi.stubEnv("TRAINING_MODE", "1");
    expect(demoModeInfo().reason).toBe("flag");
    expect(demoModeInfo().banner).toBe(TRAINING_BANNER);
  });

  it("is OFF on the supabase driver with Stripe configured and no flag", () => {
    vi.spyOn(db, "getPosDriver").mockReturnValue({
      name: "supabase",
    } as unknown as ReturnType<typeof db.getPosDriver>);
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_live_x");
    expect(isTrainingMode()).toBe(false);
    const info = demoModeInfo();
    expect(info.trainingMode).toBe(false);
    expect(info.reason).toBeNull();
    expect(info.banner).toBeNull();
  });

  it("TRAINING_MODE=1 forces it on even when fully configured", () => {
    vi.spyOn(db, "getPosDriver").mockReturnValue({
      name: "supabase",
    } as unknown as ReturnType<typeof db.getPosDriver>);
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
    vi.stubEnv("TRAINING_MODE", "1");
    expect(demoModeInfo().trainingMode).toBe(true);
  });
});

describe("stripe-test reason + precedence (S10)", () => {
  function liveDriver() {
    vi.spyOn(db, "getPosDriver").mockReturnValue({
      name: "supabase",
    } as unknown as ReturnType<typeof db.getPosDriver>);
  }

  it("shows the Stripe test mode banner for a sk_test_ key with no flag", () => {
    liveDriver();
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
    const info = demoModeInfo();
    expect(info.reason).toBe("stripe-test");
    expect(info.trainingMode).toBe(true);
    expect(info.banner).toBe(TRAINING_BANNER_STRIPE_TEST);
    expect(info.banner).toBe("TRAINING \u2014 Stripe test mode, no real money");
    expect(isTrainingMode()).toBe(true);
  });

  it("precedence: flag > mock > stripe-unset > stripe-test", () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
    // mock driver (the real one in tests) beats stripe-test
    expect(demoModeInfo().reason).toBe("mock");
    vi.stubEnv("TRAINING_MODE", "1");
    expect(demoModeInfo().reason).toBe("flag");
    vi.unstubAllEnvs();
    liveDriver();
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    expect(demoModeInfo().reason).toBe("stripe-unset");
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
    expect(demoModeInfo().reason).toBe("stripe-test");
  });
});
