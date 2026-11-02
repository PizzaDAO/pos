/**
 * Admin dispatch board: which `openpizza_driver` deliveries need a person
 * (pure, client-safe). The one fix offered is "Dispatch manually instead".
 */
import type { DeliveryRecord } from "@/lib/db";

const QUOTED_GRACE_MS = 2 * 60_000;

export interface DriverAttention {
  /** Why the row needs attention, or null when it does not. */
  reason: string | null;
  /** Whether the "Dispatch manually instead" button may be shown (the server re-checks). */
  canDispatchManually: boolean;
}

export function driverAttention(
  d: Pick<
    DeliveryRecord,
    | "provider"
    | "status"
    | "provider_delivery_id"
    | "dispatch_error"
    | "created_at"
  >,
  now: number = Date.now(),
  /** The order's status: a closed order (POS canceled it itself) needs no one. */
  orderStatus?: string | null,
): DriverAttention {
  if (d.provider !== "openpizza_driver") {
    return { reason: null, canDispatchManually: false };
  }
  if (
    orderStatus &&
    ["voided", "abandoned", "refunded", "completed"].includes(orderStatus)
  ) {
    return { reason: null, canDispatchManually: false };
  }
  const hasId = d.provider_delivery_id !== null;
  const stuck =
    d.status === "quoted" &&
    !hasId &&
    now - new Date(d.created_at).getTime() >= QUOTED_GRACE_MS;
  if (d.status === "failed") {
    return {
      reason: d.dispatch_error ?? "The driver delivery failed.",
      // The driver reported it failed (or the dispatch did): a person may take over.
      canDispatchManually: true,
    };
  }
  if (stuck) {
    return {
      reason: d.dispatch_error ?? "The driver has not confirmed this delivery.",
      canDispatchManually: true,
    };
  }
  if (d.status === "canceled") {
    return {
      reason: "The driver canceled this delivery.",
      canDispatchManually: hasId,
    };
  }
  if (d.dispatch_error && d.status !== "delivered") {
    return { reason: d.dispatch_error, canDispatchManually: false };
  }
  return { reason: null, canDispatchManually: false };
}
