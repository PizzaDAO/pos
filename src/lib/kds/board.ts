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
import type { AgeLevel, KitchenTicket, StationFilter, VoidNotice } from "./types";
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

/**
 * Whether an order has any line for a station, or fired food voided since. An
 * order without (a drink-only one) stays on the board as a compact "No prep"
 * ticket so it can still be handed off (ready/completed events, callbacks).
 */
export function hasKitchenWork(order: Order): boolean {
  if (order.items.length === 0) return true; // nothing to judge by: leave it on the board
  return order.items.some((i) =>
    i.voided ? !!i.fired_at && lineStation(i) !== "none" : lineStation(i) !== "none",
  );
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
    // A gift card sale/reload order has nothing to cook.
    .filter((o) => active.has(o.status) && !o.core_ext?.stored_value)
    // A marketplace order the cashier has not accepted yet is not for the kitchen.
    .filter((o) => o.fulfillment?.marketplace?.acceptance !== "pending")
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

/** How long a void stays on the board as a STOP banner. */
export const VOID_NOTICE_MS = 15 * 60 * 1000;

function lineLabel(i: OrderItem): string {
  return `${i.quantity > 1 ? `${i.quantity}x ` : ""}${i.item_name}${i.size_name ? ` · ${i.size_name}` : ""}`;
}

/**
 * Fired food that was voided in the last `windowMs`: whole orders voided while
 * they had fired lines, and lines voided off a ticket after they were sent.
 * Newest first.
 */
export function buildVoidNotices(
  orders: Order[],
  now: Date,
  windowMs = VOID_NOTICE_MS,
): VoidNotice[] {
  const since = now.getTime() - windowMs;
  const out: VoidNotice[] = [];
  for (const order of orders) {
    // A whole order voided while it was in the kitchen (a refund AFTER hand-off
    // ends `refunded` and is not the kitchen's business).
    if (order.status === "voided") {
      if (new Date(order.updated_at).getTime() < since) continue;
      const fired = order.items.filter((i) => !!i.fired_at && !i.voided);
      if (fired.length === 0) continue;
      out.push({
        orderId: order.id,
        orderNumber: order.order_number,
        at: order.updated_at,
        scope: "order",
        items: fired.map(lineLabel),
      });
      continue;
    }
    const lines = order.items.filter(
      (i) =>
        i.voided &&
        !!i.fired_at &&
        !!i.voided_at &&
        new Date(i.voided_at).getTime() >= since,
    );
    if (lines.length === 0) continue;
    out.push({
      orderId: order.id,
      orderNumber: order.order_number,
      at: lines.map((i) => i.voided_at!).sort().pop()!,
      scope: "lines",
      items: lines.map(lineLabel),
    });
  }
  return out.sort((a, b) => b.at.localeCompare(a.at));
}
