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
  DEVICE_COOKIE,
  PIN_DEVICE_LIMIT,
  PIN_LOCATION_LIMIT,
  locationKey,
  mintDeviceCookie,
} from "./pin-attempt";
import { hashPin } from "./pin";

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

const till = (
  staffId: string,
  pin: string,
  locationId?: string,
  deviceCookie?: string,
) =>
  pinPOST(
    new Request("http://localhost/api/terminal/pin", {
      method: "POST",
      headers: deviceCookie
        ? { cookie: `${DEVICE_COOKIE}=${deviceCookie}` }
        : {},
      body: JSON.stringify({ staffId, pin, locationId }),
    }),
  );

const unlock = (staffId: string, pin: string, deviceCookie?: string) =>
  unlockPOST(
    new Request("http://localhost/api/admin/unlock", {
      method: "POST",
      headers: deviceCookie
        ? { cookie: `${DEVICE_COOKIE}=${deviceCookie}` }
        : {},
      body: JSON.stringify({ tenantId: T, staffId, pin }),
    }),
  );

const deviceCookieOf = (res: Response) =>
  new RegExp(`${DEVICE_COOKIE}=([^;]+)`).exec(
    res.headers.get("set-cookie") ?? "",
  )?.[1];

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

describe("per-browser device budget (tills share the owner login)", () => {
  /** Lock the budget of the browser holding `cookie` (or the no-cookie bucket). */
  async function exhaust(cookie?: string) {
    for (let i = 0; i < PIN_DEVICE_LIMIT.max; i++) {
      await till(STAFF[i % STAFF.length]!, "9999", undefined, cookie);
      for (const st of STAFF) await getPosDriver().clearPinAttempts(T, st);
    }
  }

  it("bad guesses on one till don't lock PIN entry on another till signed in as the same owner", async () => {
    const tillA = mintDeviceCookie()!;
    const tillB = mintDeviceCookie()!;
    await exhaust(tillA);
    expect((await till(CHRIS, "3333", undefined, tillA)).status).toBe(423);
    expect((await till(CHRIS, "3333", undefined, tillB)).status).toBe(200);
  });

  it("a device id is handed out only on a successful PIN; browsers without one share a bucket", async () => {
    const bad = await till(CHRIS, "9999");
    expect(bad.status).toBe(401);
    expect(deviceCookieOf(bad)).toBeUndefined();
    const good = await till(CHRIS, "3333");
    expect(good.status).toBe(200);
    const issued = deviceCookieOf(good);
    expect(issued).toBeTruthy();
    expect(good.headers.get("set-cookie")).toMatch(
      /pos_device=[^;]+;.*HttpOnly/i,
    );

    // Clearing the cookie doesn't buy a fresh budget: no-cookie requests share one.
    await exhaust(undefined);
    expect((await till(CHRIS, "3333")).status).toBe(423);
    // A forged id counts as no id.
    expect(
      (await till(CHRIS, "3333", undefined, "a".repeat(32) + ".beef")).status,
    ).toBe(423);
    // The browser that earned an id keeps its own budget.
    expect(
      (await till(CHRIS, "3333", undefined, decodeURIComponent(issued!)))
        .status,
    ).toBe(200);
  });
});

describe("admin unlock: an owner is never locked out by the device/location budgets", () => {
  const TONY_PIN = "739204";
  const CARMELA_PIN = "482915";
  beforeEach(async () => {
    await getPosDriver().setStaffPinHash(T, TONY, hashPin(TONY_PIN));
    await getPosDriver().setStaffPinHash(T, CARMELA, hashPin(CARMELA_PIN));
  });

  it("device budget spent: owner unlocks, manager is refused", async () => {
    for (let i = 0; i < PIN_DEVICE_LIMIT.max; i++) {
      await till(STAFF[i % STAFF.length]!, "9999");
      for (const st of STAFF) await getPosDriver().clearPinAttempts(T, st);
    }
    expect((await unlock(CARMELA, CARMELA_PIN)).status).toBe(423);
    expect((await unlock(TONY, TONY_PIN)).status).toBe(200);
  });

  it("location budget spent: owner still unlocks", async () => {
    const driver = getPosDriver();
    for (let i = 0; i <= PIN_LOCATION_LIMIT.max; i++) {
      await driver.beginPinLimitAttempt(
        "location",
        locationKey(T, null),
        PIN_LOCATION_LIMIT,
      );
    }
    expect((await unlock(CARMELA, CARMELA_PIN)).status).toBe(423);
    expect((await unlock(TONY, TONY_PIN)).status).toBe(200);
  });

  it("the owner's own per-staff lockout still applies", async () => {
    for (let i = 0; i < 5; i++)
      expect((await unlock(TONY, "000001")).status).toBe(401);
    expect((await unlock(TONY, TONY_PIN)).status).toBe(423);
  });
});
