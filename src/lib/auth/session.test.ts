import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The seeded demo session must ONLY exist with the in-memory mock driver. If
 * the real (Supabase) driver is active but the public auth env is missing, a
 * request must resolve to NO user — never the demo owner / platform admin.
 */
const state = vi.hoisted(() => ({ driverName: "mock" as "mock" | "supabase" }));

vi.mock("./supabase-server", () => ({
  isSupabaseAuthConfigured: () => false,
  getServerSupabase: async () => null,
}));

vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  return {
    ...actual,
    getPosDriver: () => {
      const real = actual.getPosDriver();
      return new Proxy(real, {
        get(target, prop, receiver) {
          if (prop === "name") return state.driverName;
          return Reflect.get(target, prop, receiver);
        },
      });
    },
  };
});

import { getCurrentUser, isSimulatedSessionAllowed } from "./session";

beforeEach(() => {
  state.driverName = "mock";
});

describe("simulated session gating", () => {
  it("returns the demo owner with the mock driver and no auth env", async () => {
    const user = await getCurrentUser();
    expect(user?.real).toBe(false);
    expect(user?.memberships.length).toBeGreaterThan(0);
    expect(isSimulatedSessionAllowed("mock")).toBe(true);
  });

  it("returns NO user when the real driver is active without auth env", async () => {
    state.driverName = "supabase";
    expect(await getCurrentUser()).toBeNull();
    expect(await getCurrentUser({ simulatedAs: "platform" })).toBeNull();
    expect(isSimulatedSessionAllowed("supabase")).toBe(false);
  });
});
