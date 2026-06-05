/**
 * React hook wiring the offline queue to the UI.
 *
 * - Tracks online/offline via the browser `online`/`offline` events.
 * - Exposes the pending-sync count (polled + refreshed after writes).
 * - Flushes the queue on reconnect, on an interval, and on demand.
 * - `placeOrderOffline` is the single entry point the terminal calls to place an
 *   order: it enqueues durably (IndexedDB) then attempts an immediate flush, so
 *   the same idempotent path is used online and offline.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import type { CreateOrderInput } from "@/lib/db";
import { enqueueOrder, getPendingCount, pruneSynced } from "./queue";
import { flushQueue } from "./sync";

export interface OfflineSyncState {
  online: boolean;
  pendingCount: number;
  /** Enqueue + attempt flush. Returns once durably queued (not necessarily synced). */
  placeOrderOffline: (payload: CreateOrderInput) => Promise<void>;
  /** Manually trigger a flush (e.g. a "retry sync" button). */
  flushNow: () => Promise<void>;
  refresh: () => Promise<void>;
}

const POLL_MS = 5_000;

export function useOfflineSync(): OfflineSyncState {
  const [online, setOnline] = useState(true);
  const [pendingCount, setPendingCount] = useState(0);

  const refresh = useCallback(async () => {
    try {
      setPendingCount(await getPendingCount());
    } catch {
      // IndexedDB unavailable (e.g. private mode) — ignore, count stays as-is.
    }
  }, []);

  const flushNow = useCallback(async () => {
    await flushQueue();
    await refresh();
  }, [refresh]);

  const placeOrderOffline = useCallback(
    async (payload: CreateOrderInput) => {
      await enqueueOrder(payload);
      await refresh();
      // Fire-and-forget flush; failures stay queued for the next trigger.
      void flushNow();
    },
    [flushNow, refresh],
  );

  useEffect(() => {
    setOnline(navigator.onLine);
    void refresh();
    void pruneSynced();

    const handleOnline = () => {
      setOnline(true);
      void flushNow();
    };
    const handleOffline = () => setOnline(false);

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    const interval = window.setInterval(() => {
      void refresh();
      if (navigator.onLine) void flushNow();
    }, POLL_MS);

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      window.clearInterval(interval);
    };
  }, [flushNow, refresh]);

  return { online, pendingCount, placeOrderOffline, flushNow, refresh };
}
