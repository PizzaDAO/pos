import { describe, expect, it } from "vitest";
import type { MembershipRole } from "@/lib/db";
import {
  SURFACE_ROLES,
  canEnterSurface,
  loginPathFor,
  tenantsForSurface,
} from "./roles";

const m = (tenant_id: string, role: MembershipRole) => ({ tenant_id, role });

describe("role / route-gating matrix", () => {
  it("admin requires owner|manager only", () => {
    expect(SURFACE_ROLES.admin).toEqual(["owner", "manager"]);
    expect(canEnterSurface([m("t1", "owner")], "admin", "t1")).toBe(true);
    expect(canEnterSurface([m("t1", "manager")], "admin", "t1")).toBe(true);
    expect(canEnterSurface([m("t1", "cashier")], "admin", "t1")).toBe(false);
    expect(canEnterSurface([m("t1", "kitchen")], "admin", "t1")).toBe(false);
  });

  it("terminal/kitchen allow every operational role", () => {
    for (const role of ["owner", "manager", "cashier", "kitchen"] as const) {
      expect(canEnterSurface([m("t1", role)], "terminal", "t1")).toBe(true);
      expect(canEnterSurface([m("t1", role)], "kitchen", "t1")).toBe(true);
    }
  });

  it("gates by tenant — a membership in t1 grants no access to t2", () => {
    expect(canEnterSurface([m("t1", "owner")], "admin", "t2")).toBe(false);
  });

  it("tenantsForSurface returns only tenants where the role qualifies", () => {
    const memberships = [
      m("t1", "owner"),
      m("t2", "cashier"),
      m("t3", "manager"),
    ];
    expect(tenantsForSurface(memberships, "admin").sort()).toEqual(["t1", "t3"]);
    expect(tenantsForSurface(memberships, "terminal").sort()).toEqual([
      "t1",
      "t2",
      "t3",
    ]);
  });

  it("routes unauthenticated visitors to the right login", () => {
    expect(loginPathFor("admin")).toBe("/login");
    expect(loginPathFor("terminal")).toBe("/login");
    expect(loginPathFor("kitchen")).toBe("/login");
    expect(loginPathFor("platform")).toBe("/platform/login");
  });
});
