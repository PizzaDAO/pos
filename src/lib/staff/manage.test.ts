import { beforeEach, describe, expect, it } from "vitest";
import { DEMO_TENANT_ID, getPosDriver } from "@/lib/db";
import { hashPin, verifyPin } from "@/lib/auth/pin";
import {
  checkPinIssue,
  checkStaffChange,
  cleanEmail,
  cleanName,
  cleanPhone,
  isWeakPin,
  issueStaffPin,
} from "./manage";

const T = DEMO_TENANT_ID;
const CHRIS = "80000000-0000-0000-0000-000000000003";
const FURIO = "80000000-0000-0000-0000-000000000004";

const owner = { role: "owner" as const, active: true };
const cashier = { role: "cashier" as const, active: true };

describe("checkStaffChange", () => {
  it("only owners and managers manage staff", () => {
    for (const r of ["cashier", "kitchen", null] as const) {
      expect(
        checkStaffChange(r, { kind: "create", role: "cashier" }, 1),
      ).toMatch(/owner or manager/);
    }
    expect(
      checkStaffChange("manager", { kind: "create", role: "cashier" }, 1),
    ).toBeNull();
    expect(
      checkStaffChange("owner", { kind: "create", role: "owner" }, 1),
    ).toBeNull();
  });

  it("managers can't create, promote to, or change an owner", () => {
    expect(
      checkStaffChange("manager", { kind: "create", role: "owner" }, 1),
    ).toMatch(/owner/);
    expect(
      checkStaffChange(
        "manager",
        { kind: "update", target: cashier, next: { role: "owner" } },
        2,
      ),
    ).toMatch(/owner/);
    expect(
      checkStaffChange(
        "manager",
        { kind: "update", target: owner, next: {} },
        2,
      ),
    ).toMatch(/owner/);
    expect(
      checkStaffChange(
        "manager",
        { kind: "update", target: owner, next: { active: false } },
        2,
      ),
    ).toMatch(/owner/);
    expect(
      checkStaffChange("manager", { kind: "resetPin", target: owner }, 2),
    ).toMatch(/owner/);
    // …but may manage everyone else, including other managers.
    expect(
      checkStaffChange(
        "manager",
        {
          kind: "update",
          target: { role: "manager", active: true },
          next: { role: "cashier" },
        },
        1,
      ),
    ).toBeNull();
    expect(
      checkStaffChange("manager", { kind: "resetPin", target: cashier }, 1),
    ).toBeNull();
  });

  it("nobody demotes or deactivates the last active owner", () => {
    for (const actor of ["owner", "manager"] as const) {
      expect(
        checkStaffChange(
          actor,
          { kind: "update", target: owner, next: { role: "manager" } },
          1,
        ),
      ).not.toBeNull();
      expect(
        checkStaffChange(
          actor,
          { kind: "update", target: owner, next: { active: false } },
          1,
        ),
      ).not.toBeNull();
    }
    expect(
      checkStaffChange(
        "owner",
        { kind: "update", target: owner, next: { role: "manager" } },
        1,
      ),
    ).toMatch(/last owner/);
    // With a second owner it's fine; renaming the last owner is fine.
    expect(
      checkStaffChange(
        "owner",
        { kind: "update", target: owner, next: { role: "manager" } },
        2,
      ),
    ).toBeNull();
    expect(
      checkStaffChange("owner", { kind: "update", target: owner, next: {} }, 1),
    ).toBeNull();
    // An inactive owner row isn't "the last owner".
    expect(
      checkStaffChange(
        "owner",
        {
          kind: "update",
          target: { role: "owner", active: false },
          next: { role: "cashier" },
        },
        1,
      ),
    ).toBeNull();
  });

  it("a deactivated member gets no PIN until reactivated", () => {
    expect(
      checkStaffChange(
        "owner",
        { kind: "resetPin", target: { role: "cashier", active: false } },
        1,
      ),
    ).toMatch(/Reactivate/);
  });
});

describe("input cleaning", () => {
  it("names, emails and phones", () => {
    expect(cleanName("  Sal   Bonpensiero ")).toBe("Sal Bonpensiero");
    expect(cleanName("")).toBe(false);
    expect(cleanName("x".repeat(81))).toBe(false);
    expect(cleanEmail(" Sal@Example.com ")).toBe("sal@example.com");
    expect(cleanEmail("")).toBeNull();
    expect(cleanEmail("nope")).toBe(false);
    expect(cleanPhone("+1 (555) 010-2000")).toBe("+1 (555) 010-2000");
    expect(cleanPhone("")).toBeNull();
    expect(cleanPhone("call me")).toBe(false);
    expect(cleanPhone("12345")).toBe(false);
  });
});

describe("issueStaffPin", () => {
  beforeEach(async () => {
    await getPosDriver().setStaffPinHash(T, CHRIS, hashPin("482915"));
  });

  it("skips obvious PINs", () => {
    expect(isWeakPin("111111")).toBe(true);
    expect(isWeakPin("123456")).toBe(true);
    expect(isWeakPin("654321")).toBe(true);
    expect(isWeakPin("482915")).toBe(false);
  });

  it("never issues a PIN another staff member of the tenant already has", async () => {
    const seq = [482915, 111111, 123456, 739204];
    const pin = await issueStaffPin(T, FURIO, () => seq.shift()!);
    expect(pin).toBe("739204");
    const furio = await getPosDriver().getStaffById(T, FURIO);
    expect(verifyPin("739204", furio?.pin_hash)).toBe(true);
    // The other member's PIN is untouched.
    const chris = await getPosDriver().getStaffById(T, CHRIS);
    expect(verifyPin("482915", chris?.pin_hash)).toBe(true);
  });

  it("only OTHER members PINs are excluded (re-issuing may repeat their own)", async () => {
    const pin = await issueStaffPin(T, CHRIS, () => 482915);
    expect(pin).toBe("482915");
  });

  it("never issues another member's replaced PIN while it is still in grace", async () => {
    const d = getPosDriver();
    // Chris's old PIN 615283 was replaced by 482915 but still works for 10 min.
    await d.setStaffPinHash(T, CHRIS, hashPin("615283"));
    await d.rotateStaffPin(
      T,
      CHRIS,
      hashPin("482915"),
      new Date(Date.now() + 600_000).toISOString(),
    );
    const seq = [615283, 482915, 739204];
    expect(await issueStaffPin(T, FURIO, () => seq.shift()!)).toBe("739204");

    // Once the grace has passed, that old PIN is free again.
    await d.setStaffPinHash(T, CHRIS, hashPin("615283"));
    await d.rotateStaffPin(
      T,
      CHRIS,
      hashPin("482915"),
      new Date(Date.now() - 1).toISOString(),
    );
    expect(await issueStaffPin(T, FURIO, () => 615283)).toBe("615283");
  });

  it("pads to 6 digits", async () => {
    expect(await issueStaffPin(T, FURIO, () => 4071)).toBe("004071");
  });

  it("null for a staff member outside the tenant", async () => {
    expect(
      await issueStaffPin(
        "20000000-0000-4000-8000-0000000000bb",
        FURIO,
        () => 739204,
      ),
    ).toBeNull();
  });
});

describe("checkPinIssue (bootstrap)", () => {
  const base = { ownerHasPin: false, gateOn: false, recentSignIn: true };
  it("no manager PIN before an owner has one", () => {
    expect(checkPinIssue({ ...base, role: "manager" })?.status).toBe(409);
    expect(
      checkPinIssue({
        ...base,
        role: "manager",
        ownerHasPin: true,
        gateOn: true,
      }),
    ).toBeNull();
  });
  it("the PIN that turns the gate on needs a recent sign-in", () => {
    expect(
      checkPinIssue({ ...base, role: "owner", recentSignIn: false }),
    ).toMatchObject({
      status: 401,
      code: "reauth_required",
    });
    expect(checkPinIssue({ ...base, role: "owner" })).toBeNull();
    // Once on, resets happen inside the PIN-gated back office.
    expect(
      checkPinIssue({
        ...base,
        role: "owner",
        gateOn: true,
        recentSignIn: false,
      }),
    ).toBeNull();
    // Cashier/kitchen PINs never turn it on.
    expect(
      checkPinIssue({ ...base, role: "cashier", recentSignIn: false }),
    ).toBeNull();
  });
});
