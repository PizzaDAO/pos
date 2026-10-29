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
    // 5th failure locks.
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
