/**
 * Module roles (driver, dispatcher) on a staff member: PATCH /api/admin/staff
 * round-trips through the mock driver, rejects unknown roles and cross-tenant
 * staff, and the contract staff exposes them in `roles` (the driver module reads
 * `roles` to decide who can be a driver).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StaffMemberSchema } from "@openpizza/core";
import { getPosDriver, DEMO_TENANT_ID } from "@/lib/db";
import { resetMockOrders } from "@/lib/db/mock";
import { toContractStaff } from "@/lib/core/mappers";

let allow = true;
vi.mock("@/lib/auth/tenant-guard", async () => {
  const { NextResponse } = await import("next/server");
  return {
    requireTenantAccess: async (tenantId: string) =>
      allow
        ? { ok: true, tenantId, locationId: null, role: "owner", user: { id: "u" } }
        : { ok: false, res: NextResponse.json({ error: "no" }, { status: 403 }) },
  };
});

import { PATCH } from "./route";

const STAFF = "80000000-0000-4000-8000-0000000000d1";

beforeEach(async () => {
  allow = true;
  resetMockOrders();
  await getPosDriver().upsertStaff({
    id: STAFF,
    tenant_id: DEMO_TENANT_ID,
    name: "Dee Driver",
    role: "cashier",
    active: true,
    pin_hash: "scrypt$aa$bb",
    created_at: new Date().toISOString(),
  });
});

const patch = (body: unknown) =>
  PATCH(
    new Request("https://pos.test/api/admin/staff", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

describe("staff module roles", () => {
  it("round-trips through the driver and keeps the PIN", async () => {
    const res = await patch({
      tenantId: DEMO_TENANT_ID,
      staffId: STAFF,
      moduleRoles: ["dispatcher", "driver", "driver"],
    });
    expect(res.status).toBe(200);
    const stored = await getPosDriver().getStaffById(DEMO_TENANT_ID, STAFF);
    expect(stored?.module_roles).toEqual(["driver", "dispatcher"]);
    expect(stored?.pin_hash).toBe("scrypt$aa$bb");
    const list = await getPosDriver().listStaff(DEMO_TENANT_ID);
    expect(list.find((s) => s.id === STAFF)?.module_roles).toEqual([
      "driver",
      "dispatcher",
    ]);
    // Unchecking clears.
    await patch({ tenantId: DEMO_TENANT_ID, staffId: STAFF, moduleRoles: [] });
    expect(
      (await getPosDriver().getStaffById(DEMO_TENANT_ID, STAFF))?.module_roles,
    ).toEqual([]);
  });

  it("rejects roles outside driver/dispatcher (a POS role is not a module role)", async () => {
    for (const bad of [["owner"], ["manager"], ["driver", "admin"]]) {
      const res = await patch({
        tenantId: DEMO_TENANT_ID,
        staffId: STAFF,
        moduleRoles: bad,
      });
      expect(res.status).toBe(422);
    }
  });

  it("422s a staffId that is not a UUID", async () => {
    for (const bad of ["nope", 5, "80000000-0000-4000-8000-0000000000d1'--"]) {
      const res = await patch({ tenantId: DEMO_TENANT_ID, staffId: bad, moduleRoles: [] });
      expect(res.status).toBe(422);
    }
  });

  it("audits the change as membership_change and writes nothing but module_roles", async () => {
    const before = await getPosDriver().getStaffById(DEMO_TENANT_ID, STAFF);
    await patch({ tenantId: DEMO_TENANT_ID, staffId: STAFF, moduleRoles: ["driver"] });
    const after = await getPosDriver().getStaffById(DEMO_TENANT_ID, STAFF);
    expect({ ...after, module_roles: undefined }).toEqual({ ...before, module_roles: undefined });
    const log = (await getPosDriver().listAuditLog(DEMO_TENANT_ID)).filter(
      (e) =>
        e.action === "membership_change" &&
        e.detail === `Staff ${STAFF} module_roles [] -> [driver]`,
    );
    expect(log.length).toBeGreaterThan(0);
    expect(log.at(-1)!.actor_user_id).toBe("u");
  });

  it("targeted update is tenant-scoped at the driver", async () => {
    expect(
      await getPosDriver().setStaffModuleRoles("20000000-0000-4000-8000-0000000000bb", STAFF, ["driver"]),
    ).toBeNull();
    expect((await getPosDriver().getStaffById(DEMO_TENANT_ID, STAFF))?.module_roles ?? []).toEqual([]);
  });

  it("404s staff from another tenant and 403s non-admins", async () => {
    const other = await patch({
      tenantId: DEMO_TENANT_ID,
      staffId: "80000000-0000-4000-8000-0000000000ff",
      moduleRoles: ["driver"],
    });
    expect(other.status).toBe(404);
    allow = false;
    const denied = await patch({
      tenantId: DEMO_TENANT_ID,
      staffId: STAFF,
      moduleRoles: ["driver"],
    });
    expect(denied.status).toBe(403);
  });

  it("contract staff roles are the POS role plus module roles, deduped", async () => {
    const base = (await getPosDriver().getStaffById(DEMO_TENANT_ID, STAFF))!;
    const plain = toContractStaff(base, false);
    expect(plain.roles).toEqual(["cashier"]);
    const withModules = toContractStaff(
      { ...base, module_roles: ["driver", "dispatcher"] },
      false,
    );
    expect(withModules.role).toBe("cashier");
    expect(withModules.roles).toEqual(["cashier", "driver", "dispatcher"]);
    expect(StaffMemberSchema.safeParse(withModules).success).toBe(true);
  });
});
