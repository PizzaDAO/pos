/**
 * Fire time of scheduled online orders (audit 2026-11-18 pos P1-1).
 *
 * A scheduled online order (pickup or delivery for a later time) is paid at
 * checkout, possibly days ahead. It must not reach the kitchen then. It is held
 * until its FIRE TIME, `promised_at - prep_minutes`, stored at checkout as
 * `fulfillment.kitchen_fire_at`:
 *
 *  - KDS: computed on every read (`isHeldForFire` in `buildTickets`), so the
 *    ticket appears on the first poll / refetch after the fire time, with its age
 *    counted from the fire time, not from checkout. Nothing in memory, no timers.
 *  - Printer: `runPostPaymentSteps` auto-prints only an order that is already due.
 *    A held order is printed by the fire sweep (`releaseDueScheduledOrders`,
 *    Vercel cron every minute), which also stamps `kitchen_released_at`. That
 *    write bumps the row, so a KDS on Supabase Realtime refetches at release.
 *    The print's `fire:<orderId>` dedupe key keeps a re-run from printing twice.
 *
 * Only `paid` online orders that carry `kitchen_fire_at` are held: once anyone moves the order on (bump,
 * void, refund), the status decides as usual. /v1 holds (`order.hold`, catering)
 * are a separate mechanism and untouched.
 */
import type { Order } from "@/lib/db";

/** `promised_at - prep` as ISO. */
export function scheduledFireAt(
  promisedAtIso: string,
  prepMinutes: number,
): string {
  const prep = Number.isFinite(prepMinutes) ? Math.max(0, prepMinutes) : 0;
  return new Date(
    new Date(promisedAtIso).getTime() - prep * 60_000,
  ).toISOString();
}

function isScheduledOnline(
  order: Pick<Order, "channel" | "fulfillment">,
): boolean {
  const f = order.fulfillment;
  return (
    (order.channel === "online_pickup" ||
      order.channel === "online_delivery") &&
    !!f &&
    f.scheduled_for !== "asap"
  );
}

/**
 * The order's kitchen fire time (ISO), or null when it fires on payment. Only
 * an order that CARRIES `kitchen_fire_at` (set by the storefront checkout for a
 * scheduled order) is ever held: /v1 orders (catering releases, /v1
 * awaiting_payment) and orders placed before this field existed never are, so
 * nothing that was already printed can vanish from the board.
 */
export function kitchenFireAt(
  order: Pick<Order, "channel" | "fulfillment">,
): string | null {
  if (!isScheduledOnline(order)) return null;
  const at = order.fulfillment!.kitchen_fire_at;
  return at && !Number.isNaN(Date.parse(at)) ? at : null;
}

/** True while a paid scheduled order is waiting for its fire time. */
export function isHeldForFire(
  order: Pick<Order, "channel" | "fulfillment" | "status" | "hold">,
  now: Date,
): boolean {
  if (order.status !== "paid" || order.hold) return false;
  const fireAt = kitchenFireAt(order);
  return fireAt !== null && Date.parse(fireAt) > now.getTime();
}

/**
 * Whether the kitchen had not been given this order yet at `at` (its fire time
 * was still ahead). A void or refund then is not the kitchen's business: no VOID
 * ticket, no STOP banner. Works on the order after it left `paid` too.
 */
export function wasHeldAt(
  order: Pick<Order, "channel" | "fulfillment">,
  at: Date,
): boolean {
  const fireAt = kitchenFireAt(order);
  return fireAt !== null && Date.parse(fireAt) > at.getTime();
}
