/**
 * Admin > Staff management through the real route + the real PIN gate (real
 * mode simulated): add, edit, deactivate/reactivate (no hard delete), PIN reset
 * shown once and unique, last sign-in, owner/manager rules, last-owner rule,
 * and the audit trail.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "@/lib/auth/session";

const session = vi.hoisted(() => ({ user: null as SessionUser | null }));
vi.mock("@/lib/auth/session", () => ({
  getCurrentUser: vi.fn(async () => session.user),
}));
vi.mock("@/lib/auth/signing-secret", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth/signing-secret")>()),
  isRealMode: () => true,
  signingSecret: () => "staff-manage-test-secret-0123456789",
}));

import {
  DEMO_LOCATION_DOWNTOWN_ID,
  DEMO_LOCATION_UPTOWN_ID,
  DEMO_TENANT_ID,
  getPosDriver,
} from "@/lib/db";
import { resetMockPinState } from "@/lib/db/mock";
import { hashPin, verifyPin } from "@/lib/auth/pin";
import { POST as ownerPinPOST } from "@/app/api/admin/owner-pin/route";
import { ADMIN_UNLOCK_COOKIE } from "@/lib/auth/admin-gate";
import { POST as unlockPOST } from "@/app/api/admin/unlock/route";
import { POST as tillPOST } from "@/app/api/terminal/pin/route";
import * as staffRoute from "./route";

const T = DEMO_TENANT_ID;
const L = DEMO_LOCATION_DOWNTOWN_ID;
const TONY = "80000000-0000-0000-0000-000000000001";
const CARMELA = "80000000-0000-0000-0000-000000000002";
const CHRIS = "80000000-0000-0000-0000-000000000003";

const device: SessionUser = {
  id: "staff-admin-device",
  email: "till@example.com",
  memberships: [
    {
      id: "m1",
      user_id: "staff-admin-device",
      tenant_id: T,
      role: "owner",
      created_at: "2025-01-01T00:00:00.000Z",
    },
  ],
  isPlatformAdmin: false,
  real: true,
};

let cookie = "";

async function unlockAs(staffId: string, pin: string) {
  const res = await unlockPOST(
    new Request("http://localhost/api/admin/unlock", {
      method: "POST",
      body: JSON.stringify({ tenantId: T, staffId, pin }),
    }),
  );
  expect(res.status).toBe(200);
  cookie = decodeURIComponent(
    new RegExp(`${ADMIN_UNLOCK_COOKIE}=([^;]+)`).exec(
      res.headers.get("set-cookie") ?? "",
    )![1]!,
  );
}

const headers = () => ({
  "content-type": "application/json",
  cookie: `${ADMIN_UNLOCK_COOKIE}=${encodeURIComponent(cookie)}`,
});

async function post(body: Record<string, unknown>) {
  const res = await staffRoute.POST(
    new Request("http://localhost/api/admin/staff", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ tenantId: T, ...body }),
    }),
  );
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
    res,
  };
}

async function roster() {
  const res = await staffRoute.GET(
    new Request(
      `http://localhost/api/admin/staff?tenantId=${T}&locationId=${L}`,
      {
        headers: headers(),
      },
    ),
  );
  expect(res.status).toBe(200);
  const text = await res.text();
  return {
    text,
    data: JSON.parse(text) as {
      staff: {
        id: string;
        name: string;
        role: string;
        active: boolean;
        contact_email?: string | null;
      }[];
      hasPin: Record<string, boolean>;
      lastSignInAt: Record<string, string>;
      actor: { role: string; name: string; gated: boolean };
    },
  };
}

async function audit(action: string) {
  return (await getPosDriver().listAuditLog(T)).filter(
    (e) => e.action === action,
  );
}

const till = (staffId: string, pin: string) =>
  tillPOST(
    new Request("http://localhost/api/terminal/pin", {
      method: "POST",
      body: JSON.stringify({ staffId, pin }),
    }),
  );

const TONY_PIN = "739204";
const CARMELA_PIN = "482915";

beforeEach(async () => {
  resetMockPinState();
  session.user = device;
  await getPosDriver().setStaffPinHash(T, TONY, hashPin(TONY_PIN));
  await getPosDriver().setStaffPinHash(T, CARMELA, hashPin(CARMELA_PIN));
  await unlockAs(TONY, TONY_PIN);
});

describe("owner manages staff", () => {
  it("adds a member with contact details and a PIN shown once", async () => {
    const r = await post({
      action: "create",
      name: "  Paulie   Walnuts ",
      role: "cashier",
      email: "Paulie@Example.com",
      phone: "+1 555 010 2000",
      moduleRoles: ["driver"],
      locationIds: [L],
      issuePin: true,
    });
    expect(r.status).toBe(201);
    expect(r.res.headers.get("cache-control")).toBe("no-store");
    const staff = r.body.staff as {
      id: string;
      name: string;
      contact_email: string;
      pin_hash?: unknown;
    };
    expect(staff.name).toBe("Paulie Walnuts");
    expect(staff.contact_email).toBe("paulie@example.com");
    expect(staff.pin_hash).toBeUndefined();
    const pin = r.body.pin as string;
    expect(pin).toMatch(/^\d{6}$/);

    // Stored only as a hash; the PIN works at the till.
    const stored = await getPosDriver().getStaffById(T, staff.id);
    expect(stored?.pin_hash).not.toContain(pin);
    expect(verifyPin(pin, stored?.pin_hash)).toBe(true);
    expect(stored?.module_roles).toEqual(["driver"]);
    expect(stored?.location_ids).toEqual([L]);
    expect((await till(staff.id, pin)).status).toBe(200);

    // Never shown again; the roster says a PIN is set and when they signed in.
    const { text, data } = await roster();
    expect(text).not.toContain(pin);
    expect(text).not.toContain("pin_hash");
    expect(data.hasPin[staff.id]).toBe(true);
    expect(data.lastSignInAt[staff.id]).toBeTruthy();
    expect(data.actor).toMatchObject({
      role: "owner",
      name: "Tony Soprano",
      gated: true,
    });

    expect(
      (await audit("staff_create")).some((e) =>
        e.detail?.includes("Paulie Walnuts"),
      ),
    ).toBe(true);
    const resetLog = (await audit("staff_pin_reset")).find((e) =>
      e.detail?.includes(staff.id),
    );
    expect(resetLog?.detail).not.toContain(pin);
    expect(resetLog?.actor_label).toContain("Tony Soprano");
  });

  it("rejects bad input", async () => {
    expect(
      (await post({ action: "create", name: "", role: "cashier" })).status,
    ).toBe(422);
    expect(
      (await post({ action: "create", name: "X", role: "admin" })).status,
    ).toBe(422);
    expect(
      (
        await post({
          action: "create",
          name: "X",
          role: "cashier",
          email: "nope",
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await post({
          action: "create",
          name: "X",
          role: "cashier",
          locationIds: ["99999999-0000-4000-8000-000000000000"],
        })
      ).status,
    ).toBe(422);
    expect(
      (await post({ action: "update", staffId: "nope", name: "X" })).status,
    ).toBe(422);
    // Another tenant's staff id is not found here.
    expect(
      (
        await post({
          action: "update",
          staffId: "80000000-0000-4000-8000-0000000000ff",
          name: "X",
        })
      ).status,
    ).toBe(404);
  });

  it("edits a member and audits what changed (not the contact values)", async () => {
    const r = await post({
      action: "update",
      staffId: CHRIS,
      name: "Christopher Moltisanti",
      role: "manager",
      email: "chris@example.com",
      locationIds: [DEMO_LOCATION_UPTOWN_ID],
    });
    expect(r.status).toBe(200);
    const s = await getPosDriver().getStaffById(T, CHRIS);
    expect(s).toMatchObject({
      name: "Christopher Moltisanti",
      role: "manager",
      contact_email: "chris@example.com",
    });
    const log = (await audit("staff_update")).find((e) =>
      e.detail?.includes("Moltisanti"),
    )!;
    expect(log.detail).toContain("role cashier -> manager");
    expect(log.detail).toContain("email changed");
    expect(log.detail).not.toContain("chris@example.com");
    await post({
      action: "update",
      staffId: CHRIS,
      name: "Christopher M.",
      role: "cashier",
      email: "",
      locationIds: [],
    });
  });

  it("deactivates (no hard delete), ends their sessions, and reactivates", async () => {
    expect("DELETE" in staffRoute).toBe(false);
    const sw = await till(CHRIS, "3333");
    expect(sw.status).toBe(200);
    const sessionId = (
      (await sw.json()) as { activeStaff: { session_id: string } }
    ).activeStaff.session_id;

    expect((await post({ action: "deactivate", staffId: CHRIS })).status).toBe(
      200,
    );
    expect((await getPosDriver().getStaffById(T, CHRIS))?.active).toBe(false);
    expect(
      (await getPosDriver().getStaffSession(sessionId))?.revoked_at,
    ).toBeTruthy();
    expect((await till(CHRIS, "3333")).status).toBe(401);
    expect((await post({ action: "resetPin", staffId: CHRIS })).status).toBe(
      403,
    );
    // Still listed (history references them), just inactive.
    expect(
      (await roster()).data.staff.find((s) => s.id === CHRIS)?.active,
    ).toBe(false);
    expect((await audit("staff_deactivate")).length).toBeGreaterThan(0);

    expect((await post({ action: "reactivate", staffId: CHRIS })).status).toBe(
      200,
    );
    expect((await till(CHRIS, "3333")).status).toBe(200);
    expect((await audit("staff_reactivate")).length).toBeGreaterThan(0);
  });

  it("resets a PIN: the old one stops working, sessions end, the new one is unique", async () => {
    const sw = await till(CHRIS, "3333");
    const sessionId = (
      (await sw.json()) as { activeStaff: { session_id: string } }
    ).activeStaff.session_id;
    const r = await post({ action: "resetPin", staffId: CHRIS });
    expect(r.status).toBe(200);
    expect(r.res.headers.get("cache-control")).toBe("no-store");
    const pin = r.body.pin as string;
    expect(pin).toMatch(/^\d{6}$/);
    expect(
      (await getPosDriver().getStaffSession(sessionId))?.revoked_at,
    ).toBeTruthy();
    expect((await till(CHRIS, "3333")).status).toBe(401);
    expect((await till(CHRIS, pin)).status).toBe(200);
    // No other staff member's hash matches the new PIN.
    for (const rec of await getPosDriver().listStaffPinRecords(T)) {
      if (rec.id !== CHRIS) expect(verifyPin(pin, rec.pin_hash)).toBe(false);
    }
    expect(
      (await audit("staff_pin_reset")).some((e) => e.detail?.includes(CHRIS)),
    ).toBe(true);
    await getPosDriver().setStaffPinHash(
      T,
      CHRIS,
      "scrypt$f9711be6a1ca88216fb953d6de599969$c5bf37206b720347db1f626994a4388d55f5816c7bf92530d884db139f11cceb",
    );
  });

  it("can't demote or deactivate the last owner, but can once there is another", async () => {
    expect(
      (await post({ action: "update", staffId: TONY, role: "manager" })).body
        .error,
    ).toMatch(/last owner/);
    expect((await post({ action: "deactivate", staffId: TONY })).status).toBe(
      403,
    );
    const second = await post({
      action: "create",
      name: "Livia",
      role: "owner",
    });
    expect(second.status).toBe(201);
    const liviaId = (second.body.staff as { id: string }).id;
    expect(
      (await post({ action: "update", staffId: TONY, role: "manager" })).status,
    ).toBe(200);
    // Now Livia is the last owner (Tony's own unlock ended with his role change).
    await unlockAs(CARMELA, CARMELA_PIN);
    expect(
      (await post({ action: "deactivate", staffId: liviaId })).status,
    ).toBe(403);
    // Restore Tony as owner via the driver (a manager can't).
    await getPosDriver().updateStaffProfile(T, TONY, { role: "owner" });
    await getPosDriver().updateStaffProfile(T, liviaId, { active: false });
  });
});

describe("manager limits", () => {
  beforeEach(async () => {
    await unlockAs(CARMELA, CARMELA_PIN);
  });

  it("the acting role is the PIN staff member's, not the owner device login's", async () => {
    expect((await roster()).data.actor).toMatchObject({
      role: "manager",
      name: "Carmela M.",
    });
  });

  it("can't create, promote to, or change an owner", async () => {
    expect(
      (await post({ action: "create", name: "Junior", role: "owner" })).status,
    ).toBe(403);
    expect(
      (await post({ action: "update", staffId: CHRIS, role: "owner" })).status,
    ).toBe(403);
    expect(
      (await post({ action: "update", staffId: TONY, name: "Tony" })).status,
    ).toBe(403);
    expect((await post({ action: "resetPin", staffId: TONY })).status).toBe(
      403,
    );
    expect((await post({ action: "deactivate", staffId: TONY })).status).toBe(
      403,
    );
    const patch = await staffRoute.PATCH(
      new Request("http://localhost/api/admin/staff", {
        method: "PATCH",
        headers: headers(),
        body: JSON.stringify({
          tenantId: T,
          staffId: TONY,
          moduleRoles: ["driver"],
        }),
      }),
    );
    expect(patch.status).toBe(403);
    expect((await getPosDriver().getStaffById(T, TONY))?.role).toBe("owner");
  });

  it("can manage cashiers and kitchen staff", async () => {
    const r = await post({
      action: "create",
      name: "Benny",
      role: "kitchen",
      issuePin: true,
    });
    expect(r.status).toBe(201);
    const id = (r.body.staff as { id: string }).id;
    expect(
      (await post({ action: "update", staffId: id, role: "cashier" })).status,
    ).toBe(200);
    expect((await post({ action: "resetPin", staffId: id })).status).toBe(200);
    expect((await post({ action: "deactivate", staffId: id })).status).toBe(
      200,
    );
    expect(
      (await audit("staff_update")).some(
        (e) => e.detail?.includes(id) && e.actor_label.includes("Carmela M."),
      ),
    ).toBe(true);
  });
});

describe("bootstrap: the first gating PIN", () => {
  // No owner/manager PIN yet: the gate is off and the device role (owner) acts.
  beforeEach(async () => {
    cookie = "";
    await getPosDriver().setStaffPinHash(T, TONY, null);
    await getPosDriver().setStaffPinHash(T, CARMELA, null);
  });

  it("must be an owner's: no manager PIN while no owner has one", async () => {
    session.user = { ...device, authAt: Date.now() };
    const r = await post({ action: "resetPin", staffId: CARMELA });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/owner a PIN first/);
    expect(
      (
        await post({
          action: "create",
          name: "New Mgr",
          role: "manager",
          issuePin: true,
        })
      ).status,
    ).toBe(409);
    // Cashier/kitchen PINs don't turn the gate on: fine without a recent sign-in.
    session.user = device;
    expect((await post({ action: "resetPin", staffId: CHRIS })).status).toBe(
      200,
    );
  });

  it("needs a recent account sign-in, then turns the gate on", async () => {
    session.user = { ...device, authAt: Date.now() - 11 * 60_000 };
    const stale = await post({ action: "resetPin", staffId: TONY });
    expect(stale.status).toBe(401);
    expect(stale.body.code).toBe("reauth_required");
    expect((await getPosDriver().getStaffById(T, TONY))?.pin_hash).toBeNull();

    session.user = { ...device, authAt: Date.now() - 60_000 };
    const ok = await post({ action: "resetPin", staffId: TONY });
    expect(ok.status).toBe(200);
    // The gate is on now: without an unlock the staff API refuses.
    const after = await post({ action: "resetPin", staffId: CHRIS });
    expect(after.body.code).toBe("admin_pin_required");
    // …and with the new owner PIN it unlocks; now a manager PIN may be issued.
    await unlockAs(TONY, ok.body.pin as string);
    expect((await post({ action: "resetPin", staffId: CARMELA })).status).toBe(
      200,
    );
  });

  describe("/api/admin/owner-pin (never gated)", () => {
    const ownerPin = (staffId: string) =>
      ownerPinPOST(
        new Request("http://localhost/api/admin/owner-pin", {
          method: "POST",
          body: JSON.stringify({ tenantId: T, staffId }),
        }),
      );

    it("an owner device session with a recent sign-in sets a pin-less owner's first PIN, even with the gate on", async () => {
      // Gate on through a manager PIN (e.g. set by the hub) but no owner PIN.
      await getPosDriver().setStaffPinHash(T, CARMELA, hashPin(CARMELA_PIN));
      session.user = device;
      const stale = await ownerPin(TONY);
      expect(stale.status).toBe(401);
      expect(((await stale.json()) as { code: string }).code).toBe(
        "reauth_required",
      );

      session.user = { ...device, authAt: Date.now() };
      const res = await ownerPin(TONY);
      expect(res.status).toBe(200);
      const { pin } = (await res.json()) as { pin: string };
      expect(pin).toMatch(/^\d{6}$/);
      expect(
        verifyPin(pin, (await getPosDriver().getStaffById(T, TONY))?.pin_hash),
      ).toBe(true);
      // Never replaces an existing PIN.
      expect((await ownerPin(TONY)).status).toBe(409);
      expect(
        (await audit("staff_pin_reset")).some((e) =>
          e.detail?.includes("first PIN"),
        ),
      ).toBe(true);
    });

    it("only for an owner login and an owner staff row", async () => {
      session.user = { ...device, authAt: Date.now() };
      expect((await ownerPin(CHRIS)).status).toBe(409);
      session.user = {
        ...device,
        authAt: Date.now(),
        memberships: [{ ...device.memberships[0]!, role: "manager" }],
      };
      expect((await ownerPin(TONY)).status).toBe(403);
    });
  });
});

describe("concurrent staff changes", () => {
  it("a deadlock / serialization failure is a 409 'try again', not a 500", async () => {
    const driver = getPosDriver();
    for (const code of ["40P01", "40001"]) {
      const spy = vi
        .spyOn(driver, "updateStaffProfile")
        .mockRejectedValueOnce(
          Object.assign(new Error("Supabase: deadlock detected"), { code }),
        );
      const r = await post({
        action: "update",
        staffId: CHRIS,
        name: "Christopher X",
      });
      expect(r.status).toBe(409);
      expect(r.body.error).toMatch(/Try again/);
      spy.mockRestore();
    }
  });
});
