import { describe, it, expect } from "vitest";
import {
  asapAvailability,
  checkScheduledTime,
  isOpenAt,
} from "@/lib/shop/scheduling";
import type { DayHours, FulfillmentSettings } from "@/lib/db";

/** Every day 11:00–22:00. */
function dailyHours(open = "11:00", close = "22:00"): DayHours[] {
  return Array.from({ length: 7 }, (_, weekday) => ({
    weekday,
    open,
    close,
    closed: false,
  }));
}

function settings(
  over: Partial<FulfillmentSettings> = {},
): FulfillmentSettings {
  return {
    pickup_enabled: true,
    delivery_enabled: false,
    prep_minutes: 20,
    scheduling_lead_minutes: 15,
    scheduling_horizon_days: 5,
    hours: dailyHours(),
    delivery_zones: [],
    delivery_providers: [],
    ...over,
  };
}

// A Wednesday (2026-06-03) used as a stable wall-clock frame.
const wed = (h: number, m = 0) => new Date(2026, 5, 3, h, m, 0, 0);

describe("isOpenAt", () => {
  it("is open inside the window", () => {
    expect(isOpenAt(dailyHours(), wed(12))).toBe(true);
  });
  it("is closed before open and after close", () => {
    expect(isOpenAt(dailyHours(), wed(9))).toBe(false);
    expect(isOpenAt(dailyHours(), wed(23))).toBe(false);
  });
  it("is closed on a day flagged closed", () => {
    const hours = dailyHours().map((h) =>
      h.weekday === 3 ? { ...h, closed: true } : h,
    );
    expect(isOpenAt(hours, wed(12))).toBe(false);
  });
  it("handles a window that wraps past midnight", () => {
    // Open 18:00, close 02:00 (next day).
    const hours = dailyHours("18:00", "02:00");
    expect(isOpenAt(hours, wed(20))).toBe(true); // evening of today
    expect(isOpenAt(hours, wed(1))).toBe(true); // early morning spillover
    expect(isOpenAt(hours, wed(15))).toBe(false); // afternoon gap
  });
});

describe("asapAvailability", () => {
  it("is available when open and ready time is still before close", () => {
    const res = asapAvailability(settings(), wed(12));
    expect(res.available).toBe(true);
    expect(res.promisedAt).toBeTruthy();
  });

  it("is unavailable when the store is closed now", () => {
    const res = asapAvailability(settings(), wed(9));
    expect(res.available).toBe(false);
    expect(res.reason).toMatch(/closed/i);
  });

  it("is unavailable too close to closing (ready time falls after close)", () => {
    // 21:50 + 20 prep = 22:10, past 22:00 close.
    const res = asapAvailability(settings({ prep_minutes: 20 }), wed(21, 50));
    expect(res.available).toBe(false);
    expect(res.reason).toMatch(/closing/i);
  });
});

describe("checkScheduledTime", () => {
  it("accepts a valid future time inside hours and horizon", () => {
    const res = checkScheduledTime(settings(), wed(12), wed(14));
    expect(res.ok).toBe(true);
    expect(res.promisedAt).toBe(wed(14).toISOString());
  });

  it("rejects a time inside the lead window (prep + lead = 35 min)", () => {
    // now 12:00, lead 35 min → earliest 12:35; 12:20 is too soon.
    const res = checkScheduledTime(settings(), wed(12), wed(12, 20));
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/from now/i);
  });

  it("rejects a time beyond the booking horizon", () => {
    const far = new Date(wed(12).getTime() + 10 * 24 * 60 * 60 * 1000);
    const res = checkScheduledTime(
      settings({ scheduling_horizon_days: 5 }),
      wed(12),
      far,
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/within/i);
  });

  it("rejects a time when the store is closed at that moment", () => {
    const res = checkScheduledTime(settings(), wed(12), wed(23));
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/closed/i);
  });

  it("rejects an invalid date", () => {
    const res = checkScheduledTime(settings(), wed(12), new Date(NaN));
    expect(res.ok).toBe(false);
  });
});
