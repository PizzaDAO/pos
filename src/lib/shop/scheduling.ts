/**
 * Online-ordering scheduling + store-hours gate (Phase 4). PURE functions over
 * `FulfillmentSettings` so the storefront, checkout, and order-intake validation
 * all agree on whether a requested fulfillment time is acceptable.
 *
 * Model:
 *  - ASAP is allowed only when the store is OPEN now AND the promised-ready time
 *    (now + prep) still falls inside today's window.
 *  - A SCHEDULED time must be (a) within the booking horizon, (b) at least
 *    prep + lead minutes in the future, and (c) inside an open window for its
 *    weekday.
 *
 * Time zones: settings hold local "HH:MM" in the LOCATION's IANA zone
 * (`locations.timezone`). Every function takes that zone and reads the weekday
 * and minute of an instant in it (Intl, so DST is handled by the tz database),
 * never the runtime's clock: the server (UTC on Vercel), the customer's browser
 * and a till in another zone all get the same answer. Windows that close after
 * midnight (11:00-02:00) belong to the day they open on.
 *
 * Fail-safe: a missing or unknown zone means we cannot tell local time, so the
 * store reads as CLOSED (no ASAP, no slots, every scheduled time refused, with
 * `TIMEZONE_UNSET_REASON`). Taking orders at the wrong hours is worse than
 * pausing online ordering until the location's zone is fixed.
 */
import type { DayHours, FulfillmentSettings } from "@/lib/db";

/** Shown when the location has no usable IANA time zone (see the header). */
export const TIMEZONE_UNSET_REASON =
  "Online ordering is paused: this store's time zone is not set.";

const DAY_MS = 24 * 60 * 60 * 1000;

function parseHm(hm: string): number {
  const [h, m] = hm.split(":").map((x) => Number.parseInt(x, 10));
  return (h ?? 0) * 60 + (m ?? 0);
}

const WEEKDAYS: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

const clockFormatters = new Map<string, Intl.DateTimeFormat | null>();

function clockFormatter(timeZone: string): Intl.DateTimeFormat | null {
  let f = clockFormatters.get(timeZone);
  if (f === undefined) {
    try {
      f = new Intl.DateTimeFormat("en-US", {
        timeZone,
        weekday: "short",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      });
    } catch {
      f = null; // unknown zone
    }
    clockFormatters.set(timeZone, f);
  }
  return f;
}

/** The zone if this runtime knows it, else null (missing / blank / unknown). */
export function usableTimeZone(
  timeZone: string | null | undefined,
): string | null {
  const tz = timeZone?.trim();
  if (!tz) return null;
  return clockFormatter(tz) ? tz : null;
}

/**
 * Weekday (0 = Sunday) and minutes past local midnight of `at` in `timeZone`.
 * Null when the zone is unusable.
 */
export function localWeekdayMinutes(
  at: Date,
  timeZone: string | null | undefined,
): { weekday: number; minutes: number } | null {
  const tz = usableTimeZone(timeZone);
  if (!tz || Number.isNaN(at.getTime())) return null;
  const parts: Record<string, string> = {};
  for (const p of clockFormatter(tz)!.formatToParts(at)) parts[p.type] = p.value;
  const weekday = WEEKDAYS[parts.weekday ?? ""];
  if (weekday === undefined) return null;
  const minutes = (Number(parts.hour) % 24) * 60 + Number(parts.minute);
  return { weekday, minutes };
}

function dayHoursFor(
  hours: DayHours[],
  weekday: number,
): DayHours | undefined {
  return hours.find((h) => h.weekday === weekday);
}

/**
 * Is the store open at `at`, read in the location's `timeZone`? Handles windows
 * that wrap past midnight (open > close means it closes the next morning).
 * False when the zone is unusable (fail-safe, see the header).
 */
export function isOpenAt(
  hours: DayHours[],
  at: Date,
  timeZone: string | null | undefined,
): boolean {
  const local = localWeekdayMinutes(at, timeZone);
  if (!local) return false;
  const today = dayHoursFor(hours, local.weekday);
  const mins = local.minutes;
  if (today && !today.closed) {
    const open = parseHm(today.open);
    const close = parseHm(today.close);
    if (open <= close) {
      if (mins >= open && mins < close) return true;
    } else {
      // Wraps midnight: open in the evening portion of today.
      if (mins >= open) return true;
    }
  }
  // Spillover from YESTERDAY's wrapping window into the early morning.
  const yesterday = dayHoursFor(hours, (local.weekday + 6) % 7);
  if (yesterday && !yesterday.closed) {
    const open = parseHm(yesterday.open);
    const close = parseHm(yesterday.close);
    if (open > close && mins < close) return true;
  }
  return false;
}

/** The promised-ready time for an ASAP order = now + prep minutes. */
export function asapPromisedAt(
  settings: FulfillmentSettings,
  now: Date,
): Date {
  return new Date(now.getTime() + settings.prep_minutes * 60_000);
}

export interface AsapAvailability {
  available: boolean;
  promisedAt?: string;
  reason?: string;
}

/** Whether ASAP ordering is currently possible (open now + ready before close). */
export function asapAvailability(
  settings: FulfillmentSettings,
  now: Date,
  timeZone: string | null | undefined,
): AsapAvailability {
  if (!usableTimeZone(timeZone)) {
    return { available: false, reason: TIMEZONE_UNSET_REASON };
  }
  if (!isOpenAt(settings.hours, now, timeZone)) {
    return { available: false, reason: "The store is currently closed." };
  }
  const ready = asapPromisedAt(settings, now);
  if (!isOpenAt(settings.hours, ready, timeZone)) {
    return {
      available: false,
      reason: "Too close to closing for an ASAP order.",
    };
  }
  return { available: true, promisedAt: ready.toISOString() };
}

export interface ScheduleCheck {
  ok: boolean;
  promisedAt?: string;
  reason?: string;
}

/**
 * Validate a requested scheduled time against horizon, lead time, and hours.
 * Returns the promised-ready ISO time (the scheduled time itself) on success.
 */
export function checkScheduledTime(
  settings: FulfillmentSettings,
  now: Date,
  scheduledFor: Date,
  timeZone: string | null | undefined,
): ScheduleCheck {
  if (Number.isNaN(scheduledFor.getTime())) {
    return { ok: false, reason: "Invalid time." };
  }
  if (!usableTimeZone(timeZone)) {
    return { ok: false, reason: TIMEZONE_UNSET_REASON };
  }
  const leadMs =
    (settings.prep_minutes + settings.scheduling_lead_minutes) * 60_000;
  if (scheduledFor.getTime() < now.getTime() + leadMs) {
    return {
      ok: false,
      reason: `Choose a time at least ${
        settings.prep_minutes + settings.scheduling_lead_minutes
      } minutes from now.`,
    };
  }
  const horizonMs = settings.scheduling_horizon_days * DAY_MS;
  if (scheduledFor.getTime() > now.getTime() + horizonMs) {
    return {
      ok: false,
      reason: `Schedule within ${settings.scheduling_horizon_days} days.`,
    };
  }
  if (!isOpenAt(settings.hours, scheduledFor, timeZone)) {
    return { ok: false, reason: "The store is closed at that time." };
  }
  return { ok: true, promisedAt: scheduledFor.toISOString() };
}

/**
 * Generate selectable scheduled slots (every `stepMinutes`) within the horizon
 * that pass `checkScheduledTime`. Used to populate the checkout time picker.
 * Capped at `max` slots so the dropdown stays manageable. Labels are in the
 * STORE's zone (with its abbreviation), whatever zone the customer is in.
 */
export function generateSlots(
  settings: FulfillmentSettings,
  now: Date,
  timeZone: string | null | undefined,
  stepMinutes = 15,
  max = 64,
): { iso: string; label: string }[] {
  const slots: { iso: string; label: string }[] = [];
  const tz = usableTimeZone(timeZone);
  if (!tz) return slots;
  const label = new Intl.DateTimeFormat(undefined, {
    timeZone: tz,
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
  const stepMs = stepMinutes * 60_000;
  const leadMs =
    (settings.prep_minutes + settings.scheduling_lead_minutes) * 60_000;
  // Start at the next step boundary after the lead time.
  let t = Math.ceil((now.getTime() + leadMs) / stepMs) * stepMs;
  const end = now.getTime() + settings.scheduling_horizon_days * DAY_MS;
  while (t <= end && slots.length < max) {
    const d = new Date(t);
    if (isOpenAt(settings.hours, d, tz)) {
      slots.push({ iso: d.toISOString(), label: label.format(d) });
    }
    t += stepMs;
  }
  return slots;
}
