import { describe, it, expect, afterEach, vi } from "vitest";
import * as db from "@/lib/db";
import {
  demoModeInfo,
  isTrainingMode,
  isTrainingModeEnv,
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
    expect(info.banner).toMatch(/TRAINING/i);
  });

  it("is OFF on the supabase driver with Stripe configured and no flag", () => {
    vi.spyOn(db, "getPosDriver").mockReturnValue({
      name: "supabase",
    } as unknown as ReturnType<typeof db.getPosDriver>);
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
    expect(isTrainingMode()).toBe(false);
    const info = demoModeInfo();
    expect(info.trainingMode).toBe(false);
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
