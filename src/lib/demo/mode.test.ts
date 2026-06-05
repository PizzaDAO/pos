import { describe, it, expect, afterEach } from "vitest";
import {
  demoModeInfo,
  isTrainingMode,
  isTrainingModeEnv,
} from "@/lib/demo/mode";

afterEach(() => {
  delete process.env.TRAINING_MODE;
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
});
