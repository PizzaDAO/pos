/**
 * React hook wiring the offline queue to the UI.
 *
 * - Tracks online/offline via the browser `online`/`offline` events.
 * - Exposes the pending-sync count AND the needs-attention count (polled +
 *   refreshed after writes); `pendingCount` includes needs-attention entries so
 *   a refused order never disappears from the number.
 * - Flushes the queue on reconnect, on an interval, and on demand. Background
 *   refusals become needs-attention entries (listed in `attention`).
 * - `placeOrderOffline` is the single entry point the terminal calls to place an
 *   order: it enqueues durably (IndexedDB) then pushes it immediately, so the
 *   same idempotent path is used online and offline.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import type { CreateOrderInput } from "@/lib/db";
import {
  discardOrder,
  getAttentionOrders,
  getQueueCounts,
  pruneSynced,
  requeueOrder,
  requeueWithoutDiscount,
  type QueuedOrder,
  type QueuedStaff,
} from "./queue";
import { flushQueue, placeOrderNow, type SyncOutcome } from "./sync";

export interface OfflineSyncState {
  online: boolean;
  /** Every unsynced order: still retrying + needs attention. */
  pendingCount: number;
  /** Orders refused in the background, waiting on staff. */
  attentionCount: number;
  /** The needs-attention entries, oldest first (for the queue UI). */
  attention: QueuedOrder[];
  /**
   * Enqueue durably, then (when online) push THIS order immediately and report
   * the server's verdict: synced, rejected (non-retryable 4xx — show it, keep
   * the cart, don't take payment), or error (stays queued, retried later).
   * `queuedBy` = the PIN-switched staff at the till (recorded + sent on flush).
   */
  placeOrderOffline: (
    payload: CreateOrderInput,
    queuedBy?: QueuedStaff | null,
  ) => Promise<SyncOutcome>;
  /** Manually trigger a flush (e.g. a "retry sync" button). */
  flushNow: () => Promise<void>;
  /** Retry a needs-attention order as-is (e.g. after a manager PIN switch). */
  retryOrder: (id: string, queuedBy?: QueuedStaff | null) => Promise<void>;
  /** Re-place a needs-attention order without its discount. */
  retryWithoutDiscount: (id: string) => Promise<void>;
  /** Staff discards a needs-attention order. */
  discard: (id: string) => Promise<void>;
  refresh: () => Promise<void>;
}

const POLL_MS = 5_000;

export function useOfflineSync(): OfflineSyncState {
  const [online, setOnline] = useState(true);
  const [pendingCount, setPendingCount] = useState(0);
  const [attention, setAttention] = useState<QueuedOrder[]>([]);

  const refresh = useCallback(async () => {
    try {
      const [counts, list] = await Promise.all([
        getQueueCounts(),
        getAttentionOrders(),
      ]);
      setPendingCount(counts.pending + counts.attention);
      setAttention(list);
    } catch {
      // IndexedDB unavailable (e.g. private mode) — ignore, counts stay as-is.
    }
  }, []);

  const flushNow = useCallback(async () => {
    await flushQueue();
    await refresh();
  }, [refresh]);

  const placeOrderOffline = useCallback(
    async (
      payload: CreateOrderInput,
      queuedBy: QueuedStaff | null = null,
    ): Promise<SyncOutcome> => {
      const online = typeof navigator === "undefined" || navigator.onLine;
      const outcome = await placeOrderNow(payload, queuedBy, online);
      await refresh();
      return outcome;
    },
    [refresh],
  );

  const retryOrder = useCallback(
    async (id: string, queuedBy?: QueuedStaff | null) => {
      await requeueOrder(id, queuedBy !== undefined ? { queuedBy } : {});
      await flushNow();
    },
    [flushNow],
  );

  const retryWithoutDiscount = useCallback(
    async (id: string) => {
      await requeueWithoutDiscount(id);
      await flushNow();
    },
    [flushNow],
  );

  const discard = useCallback(
    async (id: string) => {
      await discardOrder(id);
      await refresh();
    },
    [refresh],
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

  return {
    online,
    pendingCount,
    attentionCount: attention.length,
    attention,
    placeOrderOffline,
    flushNow,
    retryOrder,
    retryWithoutDiscount,
    discard,
    refresh,
  };
}
