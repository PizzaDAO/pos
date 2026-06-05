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
import type { OrderChannel, OrderStatus } from "@/lib/db";

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
    case "placed":
      return "New";
    case "paid":
      return "Paid";
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
