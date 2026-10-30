/**
 * Flush the offline order queue to the server.
 *
 * Walks pending entries oldest-first and POSTs each to /api/orders. The endpoint
 * upserts by the order UUID, so a flush is safe to run repeatedly and on
 * overlapping triggers (reconnect + interval + manual) without duplicating
 * orders. Browser-only.
 *
 * Refusals (non-retryable 4xx):
 *   - INTERACTIVE (the cashier is placing the order right now): the caller
 *     shows the refusal and keeps the cart; the entry is hidden (`rejected`).
 *   - BACKGROUND (interval / reconnect / manual flush): nobody is looking, so
 *     the entry becomes `needs_attention` — counted, listed in the queue UI,
 *     never dropped. A 401 is retried on every flush (succeeds after re-login).
 *
 * Each flush sends the staff session that was active when the order was
 * queued (`queued_staff_session_id`); the server honours it for a discount only
 * while that session is still live for this device login.
 */
import type { CreateOrderInput } from "@/lib/db";
import {
  enqueueOrder,
  getPendingOrders,
  getQueuedOrder,
  isFlushable,
  markError,
  markNeedsAttention,
  markRejected,
  markSynced,
  markSyncing,
  type QueuedOrder,
  type QueuedStaff,
} from "./queue";

export interface FlushResult {
  attempted: number;
  synced: number;
  failed: number;
  /** Refused this run → now waiting on staff. */
  needsAttention: number;
}

/** Outcome of pushing ONE queued order to the server. */
export type SyncOutcome =
  | { status: "synced" }
  /** Interactive only: non-retryable 4xx shown to the cashier; not placed. */
  | { status: "rejected"; httpStatus: number; error: string; code?: string }
  /** Background: non-retryable 4xx; kept and surfaced for staff to resolve. */
  | {
      status: "needs_attention";
      httpStatus: number;
      error: string;
      code?: string;
    }
  /** Network/5xx/429/408: stays queued and is retried later. */
  | { status: "error"; error: string };

export interface SyncOptions {
  /** The cashier is placing this order right now and will see a refusal. */
  interactive?: boolean;
}

/** 4xx other than timeout / rate-limit is a definitive refusal. */
function isPermanentRejection(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

/** Order ids being placed interactively right now (background flush skips). */
const inFlight = new Set<string>();

/** The request body for an entry: its payload + the queued-time staff session. */
export function flushBody(entry: QueuedOrder): Record<string, unknown> {
  const sessionId = entry.queuedBy?.sessionId;
  return sessionId
    ? { ...entry.payload, queued_staff_session_id: sessionId }
    : { ...entry.payload };
}

/** Push one queued entry; classifies the server's answer. */
export async function syncEntry(
  entry: QueuedOrder,
  opts: SyncOptions = {},
): Promise<SyncOutcome> {
  try {
    await markSyncing(entry.id);
    const res = await fetch("/api/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(flushBody(entry)),
    });
    if (res.ok) {
      await markSynced(entry.id);
      return { status: "synced" };
    }
    let message = `HTTP ${res.status}`;
    let code: string | undefined;
    try {
      const data = (await res.json()) as { error?: string; code?: string };
      if (data.error) message = data.error;
      if (typeof data.code === "string") code = data.code;
    } catch {
      // non-JSON body
    }
    if (isPermanentRejection(res.status)) {
      const refusal = { httpStatus: res.status, message, code };
      if (opts.interactive) {
        await markRejected(entry.id, refusal);
        return { status: "rejected", httpStatus: res.status, error: message, code };
      }
      await markNeedsAttention(entry.id, refusal);
      return {
        status: "needs_attention",
        httpStatus: res.status,
        error: message,
        code,
      };
    }
    await markError(entry.id, message);
    return { status: "error", error: message };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await markError(entry.id, message).catch(() => null);
    return { status: "error", error: message };
  }
}

/**
 * INTERACTIVE placement: enqueue durably, then (when online) push THIS order
 * now and report the server's verdict to the cashier. The id is marked
 * in-flight BEFORE it is enqueued, so a concurrent background flush never
 * picks it up and turns a refusal the cashier is about to see into a hidden
 * one (or the reverse).
 */
export async function placeOrderNow(
  payload: CreateOrderInput,
  queuedBy: QueuedStaff | null,
  online: boolean,
): Promise<SyncOutcome> {
  inFlight.add(payload.id);
  try {
    await enqueueOrder(payload, queuedBy);
    if (!online) return { status: "error", error: "offline" };
    const now = Date.now();
    return await syncEntry(
      {
        id: payload.id,
        payload,
        status: "pending",
        attempts: 0,
        queuedBy,
        createdAt: now,
        updatedAt: now,
      },
      { interactive: true },
    );
  } finally {
    inFlight.delete(payload.id);
  }
}

let flushing = false;

/**
 * BACKGROUND flush of all pending queued orders. Re-entrant-safe (no
 * overlapping runs); skips orders the cashier is placing interactively.
 */
export async function flushQueue(): Promise<FlushResult> {
  const empty = { attempted: 0, synced: 0, failed: 0, needsAttention: 0 };
  if (typeof window === "undefined") return empty;
  if (flushing) return empty;
  flushing = true;

  let synced = 0;
  let failed = 0;
  let attention = 0;
  try {
    const pending = await getPendingOrders();
    for (const snap of pending) {
      if (inFlight.has(snap.id)) continue;
      // Re-read right before posting: the snapshot may be stale (e.g. the
      // cashier placed this order interactively meanwhile and acknowledged a
      // refusal). Only still-flushable entries are posted.
      const entry = await getQueuedOrder(snap.id);
      if (!entry || !isFlushable(entry) || inFlight.has(entry.id)) continue;
      const outcome = await syncEntry(entry);
      if (outcome.status === "synced") synced += 1;
      else {
        failed += 1;
        if (outcome.status === "needs_attention") attention += 1;
      }
    }
    return {
      attempted: synced + failed,
      synced,
      failed,
      needsAttention: attention,
    };
  } finally {
    flushing = false;
  }
}
