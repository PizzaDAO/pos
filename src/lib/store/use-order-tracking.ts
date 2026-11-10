/**
 * Customer order-tracking hook (Phase 4).
 *
 * Subscribes to an order's status + delivery state through the REALTIME seam
 * (`getRealtimeProvider()`), which polls `/api/shop/track` on an interval today
 * and becomes Supabase Realtime later — with no change to this hook or the
 * tracking page. Same provider pattern the KDS board uses.
 */
"use client";

import { useEffect, useState } from "react";
import { getRealtimeProvider } from "@/lib/realtime";
import type {
  DeliveryRecord,
  OrderFulfillment,
  OrderStatus,
  OrderTotals,
} from "@/lib/db";

export interface TrackedOrder {
  id: string;
  order_number: string;
  status: OrderStatus;
  channel: string;
  currency: string;
  totals: OrderTotals;
  fulfillment: OrderFulfillment | null;
  /** Payment settled after the checkout expired (null when none). */
  late_payment:
    | "unresolved"
    | "accepted"
    | "refunded"
    | "refund_owed_manual"
    | null;
  created_at: string;
  updated_at: string;
}

export interface TrackResponse {
  order: TrackedOrder;
  delivery: DeliveryRecord | null;
  serverTime: string;
}

async function fetchTrack(orderId: string): Promise<TrackResponse> {
  const res = await fetch(
    `/api/shop/track?orderId=${encodeURIComponent(orderId)}`,
    { cache: "no-store" },
  );
  if (!res.ok) throw new Error(`Failed to load order (HTTP ${res.status})`);
  return (await res.json()) as TrackResponse;
}

/**
 * Customer tracking back-off, as multiples of the base interval: with the
 * default 4 s that is 4, 4, 8, 8, then every 15 s while nothing changes (any
 * change goes back to the base); paused while the tab is hidden.
 */
export function trackingBackoff(intervalMs: number): number[] {
  return [1, 1, 2, 2, 3.75].map((k) => Math.round(intervalMs * k));
}

export function useOrderTracking(orderId: string, intervalMs = 4000) {
  const [data, setData] = useState<TrackResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);

  useEffect(() => {
    const provider = getRealtimeProvider();
    const unsubscribe = provider.subscribe<TrackResponse>(
      `track:${orderId}`,
      () => fetchTrack(orderId),
      (snapshot) => {
        setData(snapshot.data);
        setLastUpdated(snapshot.at);
        setLoading(false);
      },
      {
        intervalMs,
        backoffMs: trackingBackoff(intervalMs),
        // serverTime changes on every response; the order + delivery do not.
        changeKey: (d) => JSON.stringify([d.order, d.delivery]),
      },
    );
    return unsubscribe;
  }, [orderId, intervalMs]);

  return { data, loading, lastUpdated };
}
