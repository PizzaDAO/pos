/**
 * KDS board hook (Phase 3).
 *
 * Subscribes to the active-orders feed through the REALTIME ABSTRACTION
 * (`getRealtimeProvider()`), which today polls `/api/kitchen/orders` on an
 * interval and tomorrow becomes Supabase Realtime — with no change to this hook
 * or the components that use it. Exposes `bump`/`recall` mutations that POST to
 * the same route and optimistically refresh the board.
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEMO_LOCATION_DOWNTOWN_ID,
  DEMO_TENANT_ID,
} from "@/lib/db";
import { getRealtimeProvider } from "@/lib/realtime";
import type { KitchenBoardResponse } from "./types";

async function fetchBoard(
  tenantId: string,
  locationId: string,
): Promise<KitchenBoardResponse> {
  const res = await fetch(
    `/api/kitchen/orders?tenantId=${encodeURIComponent(
      tenantId,
    )}&locationId=${encodeURIComponent(locationId)}`,
    { cache: "no-store" },
  );
  if (!res.ok) throw new Error(`Failed to load kitchen board (HTTP ${res.status})`);
  return (await res.json()) as KitchenBoardResponse;
}

export interface UseKitchenBoardResult {
  board: KitchenBoardResponse | null;
  loading: boolean;
  /** Realtime transport in use ("poll" until Supabase Realtime is wired). */
  source: "poll" | "realtime" | null;
  /** Last snapshot time (ISO), for a "live" indicator. */
  lastUpdated: string | null;
  bump: (orderId: string) => Promise<void>;
  recall: (orderId: string) => Promise<void>;
  /** Force an immediate refresh (e.g. right after a mutation). */
  refresh: () => Promise<void>;
}

export function useKitchenBoard(
  tenantId: string = DEMO_TENANT_ID,
  locationId: string = DEMO_LOCATION_DOWNTOWN_ID,
  intervalMs = 4000,
): UseKitchenBoardResult {
  const [board, setBoard] = useState<KitchenBoardResponse | null>(null);
  const [source, setSource] = useState<"poll" | "realtime" | null>(null);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const fetcherRef = useRef(() => fetchBoard(tenantId, locationId));
  fetcherRef.current = () => fetchBoard(tenantId, locationId);

  useEffect(() => {
    const provider = getRealtimeProvider();
    const unsubscribe = provider.subscribe<KitchenBoardResponse>(
      `kds:${tenantId}:${locationId}`,
      () => fetcherRef.current(),
      (snapshot) => {
        setBoard(snapshot.data);
        setSource(snapshot.source);
        setLastUpdated(snapshot.at);
        setLoading(false);
      },
      { intervalMs },
    );
    return unsubscribe;
  }, [tenantId, locationId, intervalMs]);

  const refresh = useCallback(async () => {
    const data = await fetcherRef.current();
    setBoard(data);
    setLastUpdated(new Date().toISOString());
  }, []);

  const mutate = useCallback(
    async (orderId: string, action: "bump" | "recall") => {
      await fetch("/api/kitchen/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: orderId, action }),
      });
      // Immediate refresh so the board reflects the change before the next poll.
      await refresh();
    },
    [refresh],
  );

  const bump = useCallback((id: string) => mutate(id, "bump"), [mutate]);
  const recall = useCallback((id: string) => mutate(id, "recall"), [mutate]);

  return { board, loading, source, lastUpdated, bump, recall, refresh };
}
