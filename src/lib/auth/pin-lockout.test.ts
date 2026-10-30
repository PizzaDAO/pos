import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "./session";

/**
 * PIN brute force: a persisted per-staff lockout (5 failures → 15 min) on top
 * of the IP limiter; the picker lists only one tenant's staff with id/name/role.
 */
const session = vi.hoisted(() => ({ user: null as SessionUser | null }));
vi.mock("./session", () => ({
  getCurrentUser: vi.fn(async () => session.user),
}));

import { DEMO_TENANT_ID, getPosDriver } from "@/lib/db";
import { GET as pinGET, POST as pinPOST } from "@/app/api/terminal/pin/route";

const device: SessionUser = {
  id: "pin-device",
  email: "pin@example.com",
  memberships: [
    {
      id: "m1",
      user_id: "pin-device",
      tenant_id: DEMO_TENANT_ID,
      role: "owner",
      created_at: "2025-01-01T00:00:00.000Z",
    },
  ],
  isPlatformAdmin: false,
  real: true,
};

beforeEach(() => {
  session.user = device;
});

const attempt = (staffId: string, pin: string) =>
  pinPOST(
    new Request("http://localhost/api/terminal/pin", {
      method: "POST",
      body: JSON.stringify({ staffId, pin }),
    }),
  );

describe("PIN lockout", () => {
  it("locks a staff member after 5 wrong PINs, even with the right PIN", async () => {
    const tony = (await getPosDriver().listStaff(DEMO_TENANT_ID)).find((s) =>
      s.name.startsWith("Tony"),
    )!;
    expect((await attempt(tony.id, "1111")).status).toBe(200);
    for (let i = 0; i < 4; i++) {
      expect((await attempt(tony.id, "9999")).status).toBe(401);
    }
    // 5th failure spends the budget; the next attempt locks.
    expect((await attempt(tony.id, "9999")).status).toBe(401);
    const locked = await attempt(tony.id, "1111");
    expect(locked.status).toBe(423);
    expect(((await locked.json()) as { lockedUntil: string }).lockedUntil).toBeTruthy();

    // Lock lifts after 15 minutes.
    const realNow = Date.now();
    const spy = vi.spyOn(Date, "now").mockReturnValue(realNow + 16 * 60_000);
    expect((await attempt(tony.id, "1111")).status).toBe(200);
    spy.mockRestore();
  });

  it("a successful PIN resets the failure counter", async () => {
    const staff = (await getPosDriver().listStaff(DEMO_TENANT_ID)).find((s) =>
      s.name.startsWith("Carmela"),
    )!;
    for (let i = 0; i < 4; i++) await attempt(staff.id, "9999");
    expect((await attempt(staff.id, "2222")).status).toBe(200);
    for (let i = 0; i < 4; i++) await attempt(staff.id, "9999");
    expect((await attempt(staff.id, "2222")).status).toBe(200);
  });
});

describe("PIN lockout is race-free (begin_pin_attempt)", () => {
  it("20 concurrent wrong guesses check at most 5 PINs; the rest are locked out", async () => {
    const staff = (await getPosDriver().listStaff(DEMO_TENANT_ID)).find((s) =>
      s.name.startsWith("Christopher"),
    )!;
    const results = await Promise.all(
      Array.from({ length: 20 }, () => attempt(staff.id, "9999")),
    );
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 401).length).toBeLessThanOrEqual(5);
    expect(statuses.filter((s) => s === 423).length).toBeGreaterThanOrEqual(15);
    // Locked: even the right PIN is refused now.
    expect((await attempt(staff.id, "3333")).status).toBe(423);
    const spy = vi
      .spyOn(Date, "now")
      .mockReturnValue(Date.now() + 16 * 60_000);
    expect((await attempt(staff.id, "3333")).status).toBe(200);
    spy.mockRestore();
  });

  it("a success never clears a lock set meanwhile", async () => {
    const driver = getPosDriver();
    const staff = (await driver.listStaff(DEMO_TENANT_ID)).find((s) =>
      s.name.startsWith("Furio"),
    )!;
    // A verified PIN's attempt was counted, then a burst locks the staff…
    expect((await driver.beginPinAttempt(DEMO_TENANT_ID, staff.id)).allowed).toBe(true);
    for (let i = 0; i < 4; i++) await driver.beginPinAttempt(DEMO_TENANT_ID, staff.id);
    const locked = await driver.beginPinAttempt(DEMO_TENANT_ID, staff.id);
    expect(locked.justLocked).toBe(true);
    // … and the (earlier) success's reset arrives late: the lock stays.
    await driver.clearPinAttempts(DEMO_TENANT_ID, staff.id);
    const after = await driver.beginPinAttempt(DEMO_TENANT_ID, staff.id);
    expect(after.allowed).toBe(false);
    expect(after.lockedUntil).toBeTruthy();
    const spy = vi
      .spyOn(Date, "now")
      .mockReturnValue(Date.now() + 16 * 60_000);
    expect((await driver.beginPinAttempt(DEMO_TENANT_ID, staff.id)).allowed).toBe(true);
    await driver.clearPinAttempts(DEMO_TENANT_ID, staff.id);
    spy.mockRestore();
  });
});

describe("PIN picker", () => {
  it("lists only id/name/role for one tenant and requires a session", async () => {
    const res = await pinGET(
      new Request(`http://localhost/api/terminal/pin?tenantId=${DEMO_TENANT_ID}`),
    );
    const { staff } = (await res.json()) as { staff: Record<string, unknown>[] };
    expect(staff.length).toBeGreaterThan(0);
    for (const s of staff) {
      expect(Object.keys(s).sort()).toEqual(["id", "name", "role"]);
    }
    session.user = null;
    expect(
      (await pinGET(new Request("http://localhost/api/terminal/pin"))).status,
    ).toBe(401);
    session.user = device;
    expect(
      (await pinGET(new Request("http://localhost/api/terminal/pin?tenantId=other"))).status,
    ).toBe(403);
  });
});
