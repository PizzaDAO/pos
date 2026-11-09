/**
 * KDS status transitions (Phase 3) — bump & recall.
 *
 * Bump advances an order along the kitchen flow; recall pulls a bumped order
 * back. These are PURE functions returning the next status (or null when the
 * action is a no-op), so they're trivially testable and the API route stays a
 * thin idempotent wrapper over `updateOrderStatus`.
 *
 *   placed ──bump──▶ in_kitchen ──bump──▶ ready ──bump──▶ completed
 *                         ▲                   │
 *                         └──── recall ◀──────┘ (also from completed)
 *
 * `paid` is an entry point equivalent to `placed` (paid-at-counter, not yet
 * started), so bumping it begins prep.
 */
import type { Order, OrderChannel, OrderStatus } from "@/lib/db";

/** Bump order: where each status advances to. */
const BUMP_NEXT: Partial<Record<OrderStatus, OrderStatus>> = {
  placed: "in_kitchen",
  paid: "in_kitchen",
  recall: "in_kitchen",
  in_kitchen: "ready",
  ready: "completed",
  // Online delivery: a dispatched ticket is bumped to done on hand-off.
  out_for_delivery: "completed",
};

/**
 * The status a `bump` moves `current` to, or null if `current` can't be bumped
 * (already completed/void/etc.). Idempotency lives at the DB call site: bumping
 * an already-`completed` order is a no-op.
 *
 * For online DELIVERY orders, a `ready` ticket bumps to `out_for_delivery`
 * (handed to the driver) rather than straight to `completed`, so the kitchen +
 * customer tracker reflect the delivery leg. The optional `channel` selects this
 * path; without it, `ready` → `completed` (pickup/in-store).
 */
export function nextBumpStatus(
  current: OrderStatus,
  channel?: OrderChannel,
): OrderStatus | null {
  if (current === "ready" && channel === "online_delivery") {
    return "out_for_delivery";
  }
  return BUMP_NEXT[current] ?? null;
}

/** Statuses that sit in the KDS hand-off lane (done cooking, not yet gone). */
export function isHandoffStatus(status: OrderStatus): boolean {
  return (
    status === "ready" || status === "completed" || status === "out_for_delivery"
  );
}

/**
 * Whether the KITCHEN hands this delivery to the driver itself. Only in-house
 * manual delivery does; for DoorDash / the driver module the provider sets the
 * delivery status, so the KDS must not move it. The DELIVERY RECORD's provider
 * wins (a delivery switched to in-house keeps its old fulfillment value), then
 * the order's quoted provider; none means in-house (as dispatch defaults).
 */
export function kitchenHandsOffDelivery(
  order: Pick<Order, "channel" | "fulfillment">,
  recordProvider?: string | null,
): boolean {
  if (order.channel !== "online_delivery") return true;
  const provider =
    recordProvider ?? order.fulfillment?.delivery_provider ?? "in_house_manual";
  return provider === "in_house_manual";
}

/**
 * Label for the hand-off bump on a ticket in the hand-off lane (null when the
 * KDS offers none). Pickup / in-store: Ready → "Picked up" (→ `completed`, which
 * leaves the board). In-house delivery: Ready → "Out with driver"
 * (→ `out_for_delivery`), then "Delivered" (→ `completed`). Provider-run
 * delivery (DoorDash, driver module): no hand-off button.
 */
export function handoffLabel(
  order: Pick<Order, "status" | "channel" | "fulfillment">,
  recordProvider?: string | null,
): string | null {
  if (order.channel === "online_delivery") {
    if (!kitchenHandsOffDelivery(order, recordProvider)) return null;
    if (order.status === "ready") return "Out with driver";
    if (order.status === "out_for_delivery") return "Delivered";
    return null;
  }
  return order.status === "ready" ? "Picked up" : null;
}

/**
 * Recall pulls a bumped order back onto the active board. A `ready` or
 * `completed` order returns to `recall` (a distinct, visually-flagged active
 * state) so the kitchen knows it was re-opened. Anything still in progress
 * can't be recalled (nothing to pull back).
 */
export function recallStatus(current: OrderStatus): OrderStatus | null {
  if (
    current === "ready" ||
    current === "completed" ||
    current === "out_for_delivery"
  ) {
    return "recall";
  }
  return null;
}

/** Human label for a KDS status (board headers / ticket badges). */
export function statusLabel(status: OrderStatus): string {
  switch (status) {
    case "awaiting_payment":
      return "Waiting for payment";
    case "abandoned":
      return "Checkout expired";
    case "placed":
      return "New";
    case "paid":
      // Cooks don't care about payment state; paid-at-counter is a new ticket.
      return "New";
    case "in_kitchen":
      return "In kitchen";
    case "ready":
      return "Ready";
    case "recall":
      return "Recalled";
    case "out_for_delivery":
      return "Out for delivery";
    case "completed":
      return "Done";
    default:
      return status;
  }
}
