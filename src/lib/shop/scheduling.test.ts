import { afterAll, beforeAll, describe, it, expect } from "vitest";
import {
  asapAvailability,
  checkScheduledTime,
  generateSlots,
  isOpenAt as isOpenAtIn,
  TIMEZONE_UNSET_REASON,
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

const NY = "America/New_York";

// A Wednesday (2026-06-03) in New York (EDT, UTC-4): an absolute instant, so
// the result cannot depend on the process zone.
const wed = (h: number, m = 0) => new Date(Date.UTC(2026, 5, 3, h + 4, m));

const isOpenAt = (hours: DayHours[], at: Date) => isOpenAtIn(hours, at, NY);

/**
 * Run under several PROCESS zones: the answer must depend only on the store's
 * zone (Vercel runs in UTC; browsers and tills can be anywhere).
 */
for (const processTz of ["UTC", "Pacific/Auckland", "America/Los_Angeles"]) {
  describe(`with TZ=${processTz}`, () => {
    const prevTz = process.env.TZ;
    beforeAll(() => {
      process.env.TZ = processTz;
    });
    afterAll(() => {
      process.env.TZ = prevTz;
    });

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
        const res = asapAvailability(settings(), wed(12), NY);
        expect(res.available).toBe(true);
        expect(res.promisedAt).toBeTruthy();
      });

      it("is unavailable when the store is closed now", () => {
        const res = asapAvailability(settings(), wed(9), NY);
        expect(res.available).toBe(false);
        expect(res.reason).toMatch(/closed/i);
      });

      it("is unavailable too close to closing (ready time falls after close)", () => {
        // 21:50 + 20 prep = 22:10, past 22:00 close.
        const res = asapAvailability(
          settings({ prep_minutes: 20 }),
          wed(21, 50),
          NY,
        );
        expect(res.available).toBe(false);
        expect(res.reason).toMatch(/closing/i);
      });
    });

    describe("checkScheduledTime", () => {
      it("accepts a valid future time inside hours and horizon", () => {
        const res = checkScheduledTime(settings(), wed(12), wed(14), NY);
        expect(res.ok).toBe(true);
        expect(res.promisedAt).toBe(wed(14).toISOString());
      });

      it("rejects a time inside the lead window (prep + lead = 35 min)", () => {
        // now 12:00, lead 35 min → earliest 12:35; 12:20 is too soon.
        const res = checkScheduledTime(settings(), wed(12), wed(12, 20), NY);
        expect(res.ok).toBe(false);
        expect(res.reason).toMatch(/from now/i);
      });

      it("rejects a time beyond the booking horizon", () => {
        const far = new Date(wed(12).getTime() + 10 * 24 * 60 * 60 * 1000);
        const res = checkScheduledTime(
          settings({ scheduling_horizon_days: 5 }),
          wed(12),
          far,
          NY,
        );
        expect(res.ok).toBe(false);
        expect(res.reason).toMatch(/within/i);
      });

      it("rejects a time when the store is closed at that moment", () => {
        const res = checkScheduledTime(settings(), wed(12), wed(23), NY);
        expect(res.ok).toBe(false);
        expect(res.reason).toMatch(/closed/i);
      });

      it("rejects an invalid date", () => {
        const res = checkScheduledTime(settings(), wed(12), new Date(NaN), NY);
        expect(res.ok).toBe(false);
      });
    });

    // Audit 2026-11-18 pos P0-1: Tony's Downtown, New York, 11:00-22:00 (23:00 Fri/Sat).
    describe("location time zone (audit P0-1 repro)", () => {
      const tonys = () =>
        settings({
          hours: Array.from({ length: 7 }, (_, weekday) => ({
            weekday,
            open: "11:00",
            close: weekday >= 5 ? "23:00" : "22:00",
            closed: false,
          })),
        });

      it("is open for ASAP at 6:30 pm EST (23:30Z)", () => {
        const res = asapAvailability(
          tonys(),
          new Date("2026-11-18T23:30:00Z"),
          NY,
        );
        expect(res).toEqual({
          available: true,
          promisedAt: "2026-11-18T23:50:00.000Z",
        });
      });

      it("is closed for ASAP at 7:00 am EST (12:00Z)", () => {
        const res = asapAvailability(
          tonys(),
          new Date("2026-11-18T12:00:00Z"),
          NY,
        );
        expect(res.available).toBe(false);
        expect(res.reason).toMatch(/closed/i);
      });

      it("accepts a 7 pm EST Thursday slot (00:00Z Friday)", () => {
        const res = checkScheduledTime(
          tonys(),
          new Date("2026-11-18T15:00:00Z"),
          new Date("2026-11-20T00:00:00Z"),
          NY,
        );
        expect(res.ok).toBe(true);
      });

      it("gives the same answer for a store in Auckland", () => {
        // 12:00 NZDT Thursday 2026-11-19 = 23:00Z Wednesday.
        const at = new Date("2026-11-18T23:00:00Z");
        expect(isOpenAtIn(tonys().hours, at, "Pacific/Auckland")).toBe(true);
        // 08:00 NZDT = 19:00Z: closed there, though it is 2 pm in New York.
        const early = new Date("2026-11-18T19:00:00Z");
        expect(isOpenAtIn(tonys().hours, early, "Pacific/Auckland")).toBe(
          false,
        );
        expect(isOpenAtIn(tonys().hours, early, NY)).toBe(true);
      });
    });

    describe("DST", () => {
      const hours = dailyHours("11:00", "22:00");
      it("spring forward: 11:30 EDT on 2026-03-08 (15:30Z) is open", () => {
        expect(isOpenAt(hours, new Date("2026-03-08T15:30:00Z"))).toBe(true);
        // 10:30 EDT (14:30Z) is before open; a fixed EST offset would call it 9:30.
        expect(isOpenAt(hours, new Date("2026-03-08T14:30:00Z"))).toBe(false);
      });
      it("fall back: 10:30 EST on 2026-11-01 (15:30Z) is closed, 11:00 EST (16:00Z) open", () => {
        expect(isOpenAt(hours, new Date("2026-11-01T15:30:00Z"))).toBe(false);
        expect(isOpenAt(hours, new Date("2026-11-01T16:00:00Z"))).toBe(true);
      });
      it("close moves with the clock: 21:50 EDT on the Saturday before fall back is open", () => {
        // 2026-10-31 21:50 EDT = 2026-11-01T01:50Z.
        expect(isOpenAt(hours, new Date("2026-11-01T01:50:00Z"))).toBe(true);
        // 22:10 EDT = 02:10Z: closed.
        expect(isOpenAt(hours, new Date("2026-11-01T02:10:00Z"))).toBe(false);
      });
    });

    describe("overnight hours (11:00-02:00), Sunday closed", () => {
      const hours: DayHours[] = Array.from({ length: 7 }, (_, weekday) => ({
        weekday,
        open: "11:00",
        close: "02:00",
        closed: weekday === 0,
      }));
      // Week of 2026-11-21 (Sat) in New York, EST = UTC-5.
      it("Saturday's window spills into early Sunday even though Sunday is closed", () => {
        // Sun 01:30 EST = 06:30Z.
        expect(isOpenAt(hours, new Date("2026-11-22T06:30:00Z"))).toBe(true);
        // Sun 02:00 EST = 07:00Z: closed.
        expect(isOpenAt(hours, new Date("2026-11-22T07:00:00Z"))).toBe(false);
      });
      it("closed all Sunday and the early Monday spillover", () => {
        // Sun 23:00 EST = Mon 04:00Z; Mon 01:00 EST = 06:00Z.
        expect(isOpenAt(hours, new Date("2026-11-23T04:00:00Z"))).toBe(false);
        expect(isOpenAt(hours, new Date("2026-11-23T06:00:00Z"))).toBe(false);
        // Mon 11:00 EST = 16:00Z.
        expect(isOpenAt(hours, new Date("2026-11-23T16:00:00Z"))).toBe(true);
      });
      it("ASAP refuses when the ready time falls after the 02:00 close", () => {
        const s = settings({ hours, prep_minutes: 20 });
        // Sun 01:50 EST = 06:50Z; ready 02:10.
        const res = asapAvailability(s, new Date("2026-11-22T06:50:00Z"), NY);
        expect(res.available).toBe(false);
        expect(res.reason).toMatch(/closing/i);
        // Sat 23:30 EST = Sun 04:30Z: fine.
        expect(
          asapAvailability(s, new Date("2026-11-22T04:30:00Z"), NY).available,
        ).toBe(true);
      });
    });

    describe("generateSlots", () => {
      it("starts at the store's opening and labels slots in the store's zone", () => {
        // Wed 10:00 EST (15:00Z); lead 35 min; open 11:00.
        const slots = generateSlots(
          settings(),
          new Date("2026-11-18T15:00:00Z"),
          NY,
        );
        expect(slots[0]?.iso).toBe("2026-11-18T16:00:00.000Z");
        expect(slots[0]?.label).toMatch(/^Wed,? 11:00\sAM EST$/);
        for (const s of slots)
          expect(isOpenAt(settings().hours, new Date(s.iso))).toBe(true);
      });
    });

    describe("missing or unknown time zone (fail-safe: closed)", () => {
      for (const tz of [null, undefined, "", "Not/AZone"]) {
        it(`treats ${JSON.stringify(tz)} as closed`, () => {
          expect(isOpenAtIn(dailyHours(), wed(12), tz)).toBe(false);
          expect(asapAvailability(settings(), wed(12), tz)).toEqual({
            available: false,
            reason: TIMEZONE_UNSET_REASON,
          });
          expect(checkScheduledTime(settings(), wed(12), wed(14), tz)).toEqual({
            ok: false,
            reason: TIMEZONE_UNSET_REASON,
          });
          expect(generateSlots(settings(), wed(12), tz)).toEqual([]);
        });
      }
    });
  });
}
