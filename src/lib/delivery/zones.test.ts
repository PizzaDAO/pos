import { describe, it, expect } from "vitest";
import {
  checkDeliverable,
  normalizePostal,
  resolveZone,
} from "@/lib/delivery/zones";
import type { DeliveryZone } from "@/lib/db";

const zones: DeliveryZone[] = [
  {
    id: "near",
    name: "Core",
    postal_codes: ["10001", "10002"],
    fee_cents: 399,
    eta_minutes: 30,
    min_subtotal_cents: 0,
  },
  {
    id: "far",
    name: "Greater",
    postal_codes: ["10010"],
    fee_cents: 699,
    eta_minutes: 45,
    min_subtotal_cents: 2000,
  },
];

describe("normalizePostal", () => {
  it("trims, uppercases, and strips spaces", () => {
    expect(normalizePostal("  m5v 2t6 ")).toBe("M5V2T6");
  });
});

describe("resolveZone", () => {
  it("matches a served postal code", () => {
    expect(resolveZone(zones, { postal_code: "10001" })?.id).toBe("near");
  });
  it("returns null for an unserved postal code", () => {
    expect(resolveZone(zones, { postal_code: "99999" })).toBeNull();
  });
  it("returns null for an empty postal code", () => {
    expect(resolveZone(zones, { postal_code: "" })).toBeNull();
  });
});

describe("checkDeliverable — zone gating", () => {
  it("accepts an in-zone address above the minimum, returning fee + ETA", () => {
    const res = checkDeliverable(zones, { postal_code: "10001" }, 1500);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.zone.fee_cents).toBe(399);
      expect(res.zone.eta_minutes).toBe(30);
    }
  });

  it("rejects an out-of-zone address", () => {
    const res = checkDeliverable(zones, { postal_code: "88888" }, 5000);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("out_of_zone");
  });

  it("rejects an in-zone order below the zone minimum", () => {
    const res = checkDeliverable(zones, { postal_code: "10010" }, 1500);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("below_minimum");
      expect(res.zone?.id).toBe("far");
    }
  });

  it("accepts the far zone exactly at its minimum", () => {
    const res = checkDeliverable(zones, { postal_code: "10010" }, 2000);
    expect(res.ok).toBe(true);
  });
});
