import { describe, it, expect } from "vitest";
import {
  canAddLocation,
  canUseAdvancedReports,
  canUseOnlineOrdering,
  resolveEntitlements,
} from "@/lib/saas/entitlements";
import type { Subscription } from "@/lib/db";

function sub(over: Partial<Subscription>): Subscription {
  return {
    id: "sub_1",
    tenant_id: "t1",
    tier: "starter",
    status: "active",
    current_period_end: "2026-12-31T00:00:00.000Z",
    trial_end: null,
    cancel_at_period_end: false,
    simulated: true,
    stripe_customer_id: null,
    stripe_subscription_id: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

describe("resolveEntitlements", () => {
  it("grants the Starter feature set with no subscription (pre-checkout)", () => {
    const ent = resolveEntitlements(null);
    expect(ent.tier).toBe("starter");
    expect(ent.active).toBe(true);
    expect(ent.entitlements.online_ordering).toBe(false);
    expect(ent.entitlements.max_locations).toBe(1);
  });

  it("treats trialing / active / past_due as in good standing", () => {
    expect(resolveEntitlements(sub({ status: "trialing" })).active).toBe(true);
    expect(resolveEntitlements(sub({ status: "active" })).active).toBe(true);
    const pd = resolveEntitlements(sub({ status: "past_due" }));
    expect(pd.active).toBe(true);
    expect(pd.past_due).toBe(true);
  });

  it("collapses a canceled subscription to a blocked, single-location floor", () => {
    const ent = resolveEntitlements(sub({ tier: "pro", status: "canceled" }));
    expect(ent.active).toBe(false);
    expect(ent.entitlements.max_locations).toBe(1);
    expect(ent.entitlements.online_ordering).toBe(false);
    expect(ent.entitlements.advanced_reports).toBe(false);
  });
});

describe("canAddLocation — over-limit gating", () => {
  it("blocks a second location on Starter", () => {
    const ent = resolveEntitlements(sub({ tier: "starter", status: "active" }));
    expect(canAddLocation(ent, 1).allowed).toBe(false);
    expect(canAddLocation(ent, 0).allowed).toBe(true);
  });

  it("allows up to 3 locations on Pro and blocks the 4th", () => {
    const ent = resolveEntitlements(sub({ tier: "pro", status: "active" }));
    expect(canAddLocation(ent, 2).allowed).toBe(true);
    expect(canAddLocation(ent, 3).allowed).toBe(false);
  });

  it("allows unlimited locations on Multi", () => {
    const ent = resolveEntitlements(sub({ tier: "multi", status: "active" }));
    expect(canAddLocation(ent, 99).allowed).toBe(true);
  });

  it("blocks adding a location when the subscription is inactive", () => {
    const ent = resolveEntitlements(sub({ tier: "pro", status: "canceled" }));
    const res = canAddLocation(ent, 0);
    expect(res.allowed).toBe(false);
    expect(res.reason).toMatch(/inactive/i);
  });
});

describe("feature gates — online ordering + advanced reports", () => {
  it("blocks online ordering + advanced reports on Starter", () => {
    const ent = resolveEntitlements(sub({ tier: "starter", status: "active" }));
    expect(canUseOnlineOrdering(ent).allowed).toBe(false);
    expect(canUseAdvancedReports(ent).allowed).toBe(false);
  });

  it("allows online ordering + advanced reports on Pro", () => {
    const ent = resolveEntitlements(sub({ tier: "pro", status: "active" }));
    expect(canUseOnlineOrdering(ent).allowed).toBe(true);
    expect(canUseAdvancedReports(ent).allowed).toBe(true);
  });
});
