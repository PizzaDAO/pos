import { describe, expect, it } from "vitest";
import {
  DEMO_OWNER_EMAIL,
  DEMO_OWNER_USER_ID,
  DEMO_TENANT_ID,
  PLATFORM_ADMIN_EMAIL,
  getPosDriver,
} from "@/lib/db";
import { verifyPin } from "./pin";

/**
 * The session resolver (src/lib/auth/session.ts) derives identity + memberships
 * + platform-admin flag from these driver methods. We exercise the driver
 * directly (no next/headers) so the resolution logic the session depends on is
 * covered: memberships are real (not a hardcoded role), and the PIN switch
 * verifies server-side against staff.pin_hash.
 */
describe("identity resolution (driver-backed)", () => {
  const driver = getPosDriver();

  it("resolves the seed owner by email and their owner membership", async () => {
    const user = await driver.getUserByEmail(DEMO_OWNER_EMAIL);
    expect(user?.id).toBe(DEMO_OWNER_USER_ID);

    const memberships = await driver.listMembershipsForUser(DEMO_OWNER_USER_ID);
    expect(memberships).toHaveLength(1);
    expect(memberships[0]).toMatchObject({
      tenant_id: DEMO_TENANT_ID,
      role: "owner",
    });
  });

  it("flags the platform admin and not the owner", async () => {
    const admin = await driver.getUserByEmail(PLATFORM_ADMIN_EMAIL);
    expect(admin).not.toBeNull();
    expect(await driver.isPlatformAdmin(admin!.id)).toBe(true);
    expect(await driver.isPlatformAdmin(DEMO_OWNER_USER_ID)).toBe(false);
  });

  it("email lookup is case-insensitive and returns null for unknown", async () => {
    expect(await driver.getUserByEmail(DEMO_OWNER_EMAIL.toUpperCase())).not.toBeNull();
    expect(await driver.getUserByEmail("nobody@example.com")).toBeNull();
  });

  it("never exposes pin_hash via listStaff, but getStaffById can verify a PIN", async () => {
    const list = await driver.listStaff(DEMO_TENANT_ID);
    expect(list.length).toBeGreaterThan(0);
    for (const s of list) expect(s.pin_hash).toBeUndefined();

    // Christopher (cashier) — seed PIN 3333.
    const christopher = list.find((s) => s.role === "cashier");
    expect(christopher).toBeDefined();
    const full = await driver.getStaffById(DEMO_TENANT_ID, christopher!.id);
    expect(full?.pin_hash).toBeTruthy();
    expect(verifyPin("3333", full!.pin_hash)).toBe(true);
    expect(verifyPin("0000", full!.pin_hash)).toBe(false);
  });

  it("scopes getStaffById to the tenant (no cross-tenant read)", async () => {
    const list = await driver.listStaff(DEMO_TENANT_ID);
    const someStaffId = list[0]!.id;
    const wrongTenant = await driver.getStaffById(
      "00000000-0000-0000-0000-000000000000",
      someStaffId,
    );
    expect(wrongTenant).toBeNull();
  });
});
