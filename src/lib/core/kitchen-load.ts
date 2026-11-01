/**
 * `GET /v1/locations/{id}/kitchen-load`: a live load signal for throttling
 * agent ordering and quoting times. Pure over the contract orders of the last
 * {@link KITCHEN_LOAD_WINDOW_MS} (the caller loads them bounded by `createdFrom`).
 *
 * Reference thresholds from the contract: active orders <= 1 idle, <= 4 normal,
 * <= 8 busy, else slammed; `accepting_orders = false` -> slammed.
 */
import {
  KITCHEN_ACTIVE_STATUSES,
  type KitchenLoad,
  type Order,
} from "@openpizza/core";

/** How far back active orders are looked for (an order older than this is not on the board). */
export const KITCHEN_LOAD_WINDOW_MS = 12 * 3_600_000;

export function buildKitchenLoad(input: {
  location_id: string;
  /** The board's orders (already filtered to the active statuses in SQL). */
  orders: Order[];
  /** Orders placed in the last 15 minutes, counted from header rows. */
  recent_count: number;
  prep_minutes: number;
  accepting_orders: boolean;
  now: Date;
}): KitchenLoad {
  const active = input.orders.filter((o) =>
    (KITCHEN_ACTIVE_STATUSES as readonly string[]).includes(o.fulfillment_status),
  );
  const by_status: KitchenLoad["by_status"] = {};
  for (const o of active) {
    by_status[o.fulfillment_status] = (by_status[o.fulfillment_status] ?? 0) + 1;
  }
  const active_items = active.reduce(
    (n, o) => n + o.lines.reduce((m, l) => m + (l.voided ? 0 : l.quantity), 0),
    0,
  );
  const n = active.length;
  const level: KitchenLoad["level"] = !input.accepting_orders
    ? "slammed"
    : n <= 1
      ? "idle"
      : n <= 4
        ? "normal"
        : n <= 8
          ? "busy"
          : "slammed";
  const oldest =
    active
      .map((o) => o.placed_at)
      .filter((x): x is string => !!x)
      .sort()[0] ?? null;
  return {
    location_id: input.location_id,
    active_orders: n,
    active_items,
    by_status,
    orders_last_15m: input.recent_count,
    oldest_active_placed_at: oldest,
    // Each order past the first two adds two minutes to a new ASAP pickup.
    quoted_ready_minutes: input.prep_minutes + Math.max(0, n - 2) * 2,
    level,
    accepting_orders: input.accepting_orders,
    as_of: input.now.toISOString(),
  };
}
