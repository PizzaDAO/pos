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
 * Times in settings are local "HH:MM" in the location's timezone. To keep the
 * mock deterministic with no tz database, we treat the provided `now` (and
 * scheduled Date) in the SAME wall-clock frame the hours are expressed in; a
 * real impl would convert using the location timezone. This is sufficient for
 * gating in the pilot.
 */
import type { DayHours, FulfillmentSettings } from "@/lib/db";

const DAY_MS = 24 * 60 * 60 * 1000;

function parseHm(hm: string): number {
  const [h, m] = hm.split(":").map((x) => Number.parseInt(x, 10));
  return (h ?? 0) * 60 + (m ?? 0);
}

function minutesIntoDay(d: Date): number {
  return d.getHours() * 60 + d.getMinutes();
}

function dayHoursFor(
  hours: DayHours[],
  weekday: number,
): DayHours | undefined {
  return hours.find((h) => h.weekday === weekday);
}

/**
 * Is the store open at `at`? Handles windows that wrap past midnight (open >
 * close means it closes the next morning).
 */
export function isOpenAt(hours: DayHours[], at: Date): boolean {
  const today = dayHoursFor(hours, at.getDay());
  const mins = minutesIntoDay(at);
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
  const yesterday = dayHoursFor(hours, (at.getDay() + 6) % 7);
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
): AsapAvailability {
  if (!isOpenAt(settings.hours, now)) {
    return { available: false, reason: "The store is currently closed." };
  }
  const ready = asapPromisedAt(settings, now);
  if (!isOpenAt(settings.hours, ready)) {
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
): ScheduleCheck {
  if (Number.isNaN(scheduledFor.getTime())) {
    return { ok: false, reason: "Invalid time." };
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
  if (!isOpenAt(settings.hours, scheduledFor)) {
    return { ok: false, reason: "The store is closed at that time." };
  }
  return { ok: true, promisedAt: scheduledFor.toISOString() };
}

/**
 * Generate selectable scheduled slots (every `stepMinutes`) within the horizon
 * that pass `checkScheduledTime`. Used to populate the checkout time picker.
 * Capped at `max` slots so the dropdown stays manageable.
 */
export function generateSlots(
  settings: FulfillmentSettings,
  now: Date,
  stepMinutes = 15,
  max = 64,
): { iso: string; label: string }[] {
  const slots: { iso: string; label: string }[] = [];
  const stepMs = stepMinutes * 60_000;
  const leadMs =
    (settings.prep_minutes + settings.scheduling_lead_minutes) * 60_000;
  // Start at the next step boundary after the lead time.
  let t = Math.ceil((now.getTime() + leadMs) / stepMs) * stepMs;
  const end = now.getTime() + settings.scheduling_horizon_days * DAY_MS;
  while (t <= end && slots.length < max) {
    const d = new Date(t);
    if (isOpenAt(settings.hours, d)) {
      slots.push({
        iso: d.toISOString(),
        label: d.toLocaleString(undefined, {
          weekday: "short",
          hour: "numeric",
          minute: "2-digit",
        }),
      });
    }
    t += stepMs;
  }
  return slots;
}
