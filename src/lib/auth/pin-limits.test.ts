/**
 * PIN brute force beyond the per-staff lockout: persisted per-DEVICE (device
 * login) and per-LOCATION attempt budgets, shared by the till's PIN switch and
 * the back-office unlock (src/lib/auth/pin-attempt.ts).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "./session";

const session = vi.hoisted(() => ({ user: null as SessionUser | null }));
vi.mock("./session", () => ({
  getCurrentUser: vi.fn(async () => session.user),
}));

import {
  DEMO_LOCATION_DOWNTOWN_ID,
  DEMO_LOCATION_UPTOWN_ID,
  DEMO_TENANT_ID,
  getPosDriver,
} from "@/lib/db";
import { resetMockPinState } from "@/lib/db/mock";
import { POST as pinPOST } from "@/app/api/terminal/pin/route";
import { POST as unlockPOST } from "@/app/api/admin/unlock/route";
import {
  PIN_DEVICE_LIMIT,
  PIN_LOCATION_LIMIT,
  locationKey,
} from "./pin-attempt";

const T = DEMO_TENANT_ID;
const TONY = "80000000-0000-0000-0000-000000000001";
const CARMELA = "80000000-0000-0000-0000-000000000002";
const CHRIS = "80000000-0000-0000-0000-000000000003";
const FURIO = "80000000-0000-0000-0000-000000000004";
const STAFF = [TONY, CARMELA, CHRIS, FURIO];

function device(id: string): SessionUser {
  return {
    id,
    email: `${id}@example.com`,
    memberships: [
      {
        id: `m-${id}`,
        user_id: id,
        tenant_id: T,
        role: "owner",
        created_at: "2025-01-01T00:00:00.000Z",
      },
    ],
    isPlatformAdmin: false,
    real: true,
  };
}

const till = (staffId: string, pin: string, locationId?: string) =>
  pinPOST(
    new Request("http://localhost/api/terminal/pin", {
      method: "POST",
      body: JSON.stringify({ staffId, pin, locationId }),
    }),
  );

beforeEach(() => {
  resetMockPinState();
  session.user = device("limits-device");
});

describe("per-device budget", () => {
  it(`locks the device after ${PIN_DEVICE_LIMIT.max} wrong PINs spread over staff (each under its own lockout)`, async () => {
    // Spread guesses so no single staff member hits the per-staff lock (5).
    for (let i = 0; i < PIN_DEVICE_LIMIT.max; i++) {
      expect((await till(STAFF[i % STAFF.length]!, "9999")).status).toBe(401);
    }
    const locked = await till(CHRIS, "3333");
    expect(locked.status).toBe(423);
    expect(
      ((await locked.json()) as { lockedUntil: string }).lockedUntil,
    ).toBeTruthy();

    // Another device login at the same shop is unaffected.
    session.user = device("limits-device-2");
    expect((await till(CHRIS, "3333")).status).toBe(200);

    // The lock lifts after the lock window.
    session.user = device("limits-device");
    const spy = vi
      .spyOn(Date, "now")
      .mockReturnValue(
        Date.now() + (PIN_DEVICE_LIMIT.lockMinutes + 1) * 60_000,
      );
    try {
      expect((await till(CHRIS, "3333")).status).toBe(200);
    } finally {
      spy.mockRestore();
    }
  });

  it("a correct PIN doesn't spend (or refill) the budget", async () => {
    for (let i = 0; i < PIN_DEVICE_LIMIT.max - 1; i++) {
      await till(STAFF[i % STAFF.length]!, "9999");
    }
    // A cashier typing their own PIN in between un-counts only itself …
    for (let i = 0; i < 5; i++)
      expect((await till(FURIO, "4444")).status).toBe(200);
    // … so the next wrong guess still spends the last attempt, and the one after is refused.
    expect((await till(TONY, "9999")).status).toBe(401);
    expect((await till(TONY, "1111")).status).toBe(423);
  });

  it("guesses at unknown staff ids count too", async () => {
    for (let i = 0; i < PIN_DEVICE_LIMIT.max; i++) {
      expect(
        (
          await till(
            `80000000-0000-0000-0000-0000000009${String(i).padStart(2, "0")}`,
            "1234",
          )
        ).status,
      ).toBe(401);
    }
    expect((await till(CHRIS, "3333")).status).toBe(423);
  });

  it("the back-office unlock shares the device budget", async () => {
    for (let i = 0; i < PIN_DEVICE_LIMIT.max; i++) {
      await till(STAFF[i % STAFF.length]!, "9999");
    }
    const res = await unlockPOST(
      new Request("http://localhost/api/admin/unlock", {
        method: "POST",
        body: JSON.stringify({ tenantId: T, staffId: CARMELA, pin: "2222" }),
      }),
    );
    expect(res.status).toBe(423);
  });
});

describe("per-location budget", () => {
  it(`locks a location after ${PIN_LOCATION_LIMIT.max} wrong PINs across devices; other locations are unaffected`, async () => {
    const perDevice = PIN_DEVICE_LIMIT.max - 1;
    let n = 0;
    let dev = 0;
    while (n < PIN_LOCATION_LIMIT.max) {
      session.user = device(`loc-device-${dev++}`);
      for (let i = 0; i < perDevice && n < PIN_LOCATION_LIMIT.max; i++, n++) {
        // Rotate staff so the per-staff lockout isn't what trips.
        expect(
          (
            await till(
              STAFF[n % STAFF.length]!,
              "9999",
              DEMO_LOCATION_DOWNTOWN_ID,
            )
          ).status,
        ).toBe(401);
      }
      // Reset the per-staff counters so only the location budget is in play.
      for (const s of STAFF) await getPosDriver().clearPinAttempts(T, s);
    }
    session.user = device("loc-fresh-device");
    expect((await till(CHRIS, "3333", DEMO_LOCATION_DOWNTOWN_ID)).status).toBe(
      423,
    );
    // Uptown keeps working.
    expect((await till(CHRIS, "3333", DEMO_LOCATION_UPTOWN_ID)).status).toBe(
      200,
    );
  });

  it("a location id from outside the tenant is ignored (falls back to the tenant budget)", async () => {
    const driver = getPosDriver();
    expect(locationKey(T, null)).toBe(`${T}:*`);
    const spy = vi.spyOn(driver, "beginPinLimitAttempt");
    await till(CHRIS, "3333", "99999999-0000-4000-8000-000000000000");
    expect(spy.mock.calls.map((c) => c.slice(0, 2))).toContainEqual([
      "location",
      `${T}:*`,
    ]);
    spy.mockClear();
    await till(CHRIS, "3333", DEMO_LOCATION_DOWNTOWN_ID);
    expect(spy.mock.calls.map((c) => c.slice(0, 2))).toContainEqual([
      "location",
      `${T}:${DEMO_LOCATION_DOWNTOWN_ID}`,
    ]);
    spy.mockRestore();
  });
});

describe("driver budget (mirrors begin_pin_limit_attempt)", () => {
  it("is race-free: 30 concurrent attempts never exceed the budget", async () => {
    const driver = getPosDriver();
    const limits = { max: 5, windowMinutes: 15, lockMinutes: 15 };
    const results = await Promise.all(
      Array.from({ length: 30 }, () =>
        driver.beginPinLimitAttempt("device", "race", limits),
      ),
    );
    expect(results.filter((r) => r.allowed).length).toBe(5);
    expect(results.filter((r) => r.justLocked).length).toBe(1);
  });

  it("a release never clears a lock, and an expired window starts fresh", async () => {
    const driver = getPosDriver();
    const limits = { max: 2, windowMinutes: 15, lockMinutes: 15 };
    await driver.beginPinLimitAttempt("device", "w", limits);
    await driver.beginPinLimitAttempt("device", "w", limits);
    expect(
      (await driver.beginPinLimitAttempt("device", "w", limits)).justLocked,
    ).toBe(true);
    await driver.releasePinLimitAttempt("device", "w");
    expect(
      (await driver.beginPinLimitAttempt("device", "w", limits)).allowed,
    ).toBe(false);

    await driver.beginPinLimitAttempt("device", "w2", limits);
    await driver.beginPinLimitAttempt("device", "w2", limits);
    const spy = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 16 * 60_000);
    try {
      const r = await driver.beginPinLimitAttempt("device", "w2", limits);
      expect(r).toMatchObject({ allowed: true, attempts: 1 });
    } finally {
      spy.mockRestore();
    }
  });
});
