/**
 * Kitchen Display System domain types (Phase 3).
 *
 * A "ticket" is the KDS view of an order: the same `Order` data, plus derived
 * fields the board needs (elapsed time, age color, which stations it touches).
 * Kept separate from the DB row types so the board never mutates order state
 * directly — status changes go through the DB abstraction (`updateOrderStatus`).
 */
import type { KdsThresholds, Order, OrderItem, Station } from "@/lib/db";

/** Age buckets that drive ticket coloring (green → yellow → red). */
export type AgeLevel = "fresh" | "warn" | "urgent";

/** All stations a station-filter UI can offer, plus the "all" pseudo-filter. */
export type StationFilter = Station | "all";

export interface KitchenTicket {
  order: Order;
  /** Seconds since the order was placed (server-computed for stable coloring). */
  elapsedSeconds: number;
  /** Age bucket derived from `elapsedSeconds` vs. the location thresholds. */
  ageLevel: AgeLevel;
  /** Distinct stations this order's (non-voided) items route to. */
  stations: Station[];
}

/**
 * Food that was already sent to the kitchen and then voided (a whole order
 * voided / refunded, or lines voided off a live ticket). Shown as a STOP banner
 * for a while so the line stops making it.
 */
export interface VoidNotice {
  orderId: string;
  orderNumber: string;
  /** When it was voided (ISO). */
  at: string;
  /** "order" = the whole ticket is off; "lines" = some items came off it. */
  scope: "order" | "lines";
  /** What to stop making, e.g. "2x Margherita · Large". */
  items: string[];
}

/** Response shape for the KDS orders API (what the polling fetcher returns). */
export interface KitchenBoardResponse {
  tickets: KitchenTicket[];
  /** Recently voided food that was already fired (newest first). Optional for older clients. */
  voided?: VoidNotice[];
  /** Active driver name (diagnostics — mock vs supabase). */
  driver: string;
  /** When the server assembled this snapshot (ISO) — anchors elapsed time. */
  serverTime: string;
  /** Location age-coloring thresholds, so clients can re-color as time ticks. */
  thresholds: KdsThresholds;
}

/** Filter a line's effective station, falling back to "expo" when unknown. */
export function lineStation(item: OrderItem): Station {
  return item.station ?? "expo";
}
