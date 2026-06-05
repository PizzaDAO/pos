/**
 * KDS board assembly + derivations (Phase 3) — pure, server-shared logic.
 *
 * `buildTickets` turns the active orders for a location into `KitchenTicket`s
 * with elapsed time, age coloring, and station routing computed once on the
 * server so every client renders identical colors (no clock drift). Station
 * filtering and age thresholds are pure helpers reused by the API + UI.
 */
import type { KdsThresholds, Order, OrderItem, Station } from "@/lib/db";
import { KDS_ACTIVE_STATUSES } from "@/lib/db";
import type { AgeLevel, KitchenTicket, StationFilter } from "./types";
import { lineStation } from "./types";

/** Default coloring cadence when a location omits `kds_thresholds`. */
export const DEFAULT_KDS_THRESHOLDS: KdsThresholds = {
  warn_seconds: 300,
  urgent_seconds: 600,
};

/** Bucket an elapsed time into an age level given the location thresholds. */
export function ageLevelFor(
  elapsedSeconds: number,
  thresholds: KdsThresholds,
): AgeLevel {
  if (elapsedSeconds >= thresholds.urgent_seconds) return "urgent";
  if (elapsedSeconds >= thresholds.warn_seconds) return "warn";
  return "fresh";
}

/** Distinct kitchen stations the order's non-voided items route to. */
export function orderStations(order: Order): Station[] {
  const seen = new Set<Station>();
  for (const item of order.items) {
    if (item.voided) continue;
    const station = lineStation(item);
    if (station === "none") continue;
    seen.add(station);
  }
  return [...seen];
}

/** Whether a line belongs to the given station filter. */
export function lineMatchesStation(
  item: OrderItem,
  filter: StationFilter,
): boolean {
  if (filter === "all") return lineStation(item) !== "none";
  return lineStation(item) === filter;
}

/**
 * Build the KDS tickets for a location's active orders.
 *
 * @param orders   all orders for the location (any status).
 * @param now      reference time (server clock) that anchors elapsed time.
 * @param thresholds age-coloring thresholds for this location.
 */
export function buildTickets(
  orders: Order[],
  now: Date,
  thresholds: KdsThresholds,
): KitchenTicket[] {
  const active = new Set<string>(KDS_ACTIVE_STATUSES);
  const nowMs = now.getTime();

  return orders
    .filter((o) => active.has(o.status))
    .map((order) => {
      const placedMs = new Date(order.created_at).getTime();
      const elapsedSeconds = Math.max(
        0,
        Math.floor((nowMs - placedMs) / 1000),
      );
      return {
        order,
        elapsedSeconds,
        ageLevel: ageLevelFor(elapsedSeconds, thresholds),
        stations: orderStations(order),
      } satisfies KitchenTicket;
    })
    .sort((a, b) => b.elapsedSeconds - a.elapsedSeconds); // oldest first
}

/** Tickets that have at least one item for the given station filter. */
export function ticketsForStation(
  tickets: KitchenTicket[],
  filter: StationFilter,
): KitchenTicket[] {
  if (filter === "all") return tickets;
  return tickets.filter((t) =>
    t.order.items.some((i) => !i.voided && lineMatchesStation(i, filter)),
  );
}
