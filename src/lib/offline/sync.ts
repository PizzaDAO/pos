/**
 * Flush the offline order queue to the server.
 *
 * Walks pending entries oldest-first and POSTs each to /api/orders. The endpoint
 * upserts by the order UUID, so a flush is safe to run repeatedly and on
 * overlapping triggers (reconnect + interval + manual) without duplicating
 * orders. Browser-only.
 */
import {
  getPendingOrders,
  markError,
  markSynced,
  markSyncing,
} from "./queue";

export interface FlushResult {
  attempted: number;
  synced: number;
  failed: number;
}

let flushing = false;

/** Flush all pending queued orders. Re-entrant-safe (no overlapping runs). */
export async function flushQueue(): Promise<FlushResult> {
  if (typeof window === "undefined") {
    return { attempted: 0, synced: 0, failed: 0 };
  }
  if (flushing) return { attempted: 0, synced: 0, failed: 0 };
  flushing = true;

  let synced = 0;
  let failed = 0;
  try {
    const pending = await getPendingOrders();
    for (const entry of pending) {
      try {
        await markSyncing(entry.id);
        const res = await fetch("/api/orders", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(entry.payload),
        });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        await markSynced(entry.id);
        synced += 1;
      } catch (err) {
        failed += 1;
        await markError(
          entry.id,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    return { attempted: synced + failed, synced, failed };
  } finally {
    flushing = false;
  }
}
