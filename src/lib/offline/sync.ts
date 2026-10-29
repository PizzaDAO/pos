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
  markRejected,
  markSynced,
  markSyncing,
  type QueuedOrder,
} from "./queue";

export interface FlushResult {
  attempted: number;
  synced: number;
  failed: number;
}

/** Outcome of pushing ONE queued order to the server. */
export type SyncOutcome =
  | { status: "synced" }
  /** Non-retryable 4xx: the order will not be placed; show `error`. */
  | { status: "rejected"; httpStatus: number; error: string }
  /** Network/5xx/429: stays queued and is retried later. */
  | { status: "error"; error: string };

/** 4xx other than timeout / rate-limit is a definitive refusal. */
function isPermanentRejection(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

/** Push one queued entry; classifies the server's answer. */
export async function syncEntry(entry: QueuedOrder): Promise<SyncOutcome> {
  try {
    await markSyncing(entry.id);
    const res = await fetch("/api/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(entry.payload),
    });
    if (res.ok) {
      await markSynced(entry.id);
      return { status: "synced" };
    }
    let message = `HTTP ${res.status}`;
    try {
      const data = (await res.json()) as { error?: string };
      if (data.error) message = data.error;
    } catch {
      // non-JSON body
    }
    if (isPermanentRejection(res.status)) {
      await markRejected(entry.id, message);
      return { status: "rejected", httpStatus: res.status, error: message };
    }
    await markError(entry.id, message);
    return { status: "error", error: message };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await markError(entry.id, message).catch(() => null);
    return { status: "error", error: message };
  }
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
      const outcome = await syncEntry(entry);
      if (outcome.status === "synced") synced += 1;
      else failed += 1;
    }
    return { attempted: synced + failed, synced, failed };
  } finally {
    flushing = false;
  }
}
