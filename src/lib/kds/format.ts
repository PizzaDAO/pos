/**
 * Shared KDS formatting helpers (Phase 3) — used by the board, ticket cards,
 * and the printed ticket so elapsed time + modifier text render identically.
 */
import type { OrderChannel, OrderItemModifier } from "@/lib/db";

/** mm:ss elapsed-time string from a seconds count. */
export function formatElapsed(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * "For Fri 1:00 PM": a scheduled order's promised time in the STORE's zone (the
 * screen's own zone when the store's is missing or unknown).
 */
export function formatScheduledFor(
  iso: string,
  timeZone?: string | null,
): string {
  const d = new Date(iso);
  const opts: Intl.DateTimeFormatOptions = {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  };
  let text: string;
  try {
    text = d.toLocaleString("en-US", {
      ...opts,
      timeZone: timeZone || undefined,
    });
  } catch {
    text = d.toLocaleString("en-US", opts);
  }
  return `For ${text.replace(",", "")}`;
}

/** Short, kitchen-friendly channel label. */
export function channelLabel(channel: OrderChannel): string {
  switch (channel) {
    case "in_store":
      return "Dine-in / Counter";
    case "online_pickup":
      return "Pickup";
    case "online_delivery":
      return "Delivery";
    case "marketplace":
      return "Marketplace";
    default:
      return channel;
  }
}

/**
 * Group a line's modifiers by placement for half-and-half rendering. Whole-pie
 * modifiers list normally; left/right modifiers are split so the kitchen sees
 * "LEFT: mushrooms / RIGHT: sausage".
 */
export interface GroupedModifiers {
  whole: OrderItemModifier[];
  left: OrderItemModifier[];
  right: OrderItemModifier[];
}

export function groupModifiersByPlacement(
  modifiers: OrderItemModifier[],
): GroupedModifiers {
  const grouped: GroupedModifiers = { whole: [], left: [], right: [] };
  for (const m of modifiers) {
    grouped[m.placement].push(m);
  }
  return grouped;
}

/** True when a line has any half-and-half (left or right) modifiers. */
export function isHalfAndHalf(modifiers: OrderItemModifier[]): boolean {
  return modifiers.some((m) => m.placement !== "whole");
}
