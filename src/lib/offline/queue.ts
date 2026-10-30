/**
 * Offline order queue (IndexedDB via Dexie).
 *
 * Strategy: ALWAYS-queue. Every placed order is first written to a durable
 * IndexedDB queue keyed by its client UUID, then flushed to the DB abstraction.
 * Because the key is the order UUID and the driver's `createOrder` is an
 * idempotent upsert-by-UUID, flushing the same entry twice (e.g. after a
 * reconnect or a refresh mid-flight) never creates duplicates.
 *
 * NEVER LOSE AN ORDER: a background flush that the server refuses does not
 * drop or hide the entry — it becomes `needs_attention`, is counted wherever
 * the pending count is shown, and stays in the queue UI until staff retry,
 * fix or discard it.
 *
 * This module is browser-only (IndexedDB). Guard usage behind `typeof window`.
 */
import Dexie, { type Table } from "dexie";
import type { CreateOrderInput } from "@/lib/db";

/**
 * - `needs_attention`: a BACKGROUND flush got a non-retryable 4xx (401 signed
 *   out, 403 forbidden discount, 422 86'd item…). The order is NOT dropped: it
 *   stays visible in the queue UI until staff retry, fix or discard it. A 401
 *   is retried automatically on every flush (it succeeds once re-logged in).
 * - `rejected`: refused while the cashier was placing it (user present). The
 *   refusal was shown and the cart kept, so the entry is hidden. (A `rejected`
 *   entry without `acknowledged` — written by an older build, possibly by a
 *   background flush nobody saw — is surfaced as needs-attention instead.)
 * - `discarded`: staff explicitly discarded a needs-attention order.
 */
export type QueueEntryStatus =
  | "pending"
  | "syncing"
  | "synced"
  | "error"
  | "needs_attention"
  | "rejected"
  | "discarded";

/** Who was at the till when the order was queued (the PIN-switched staff). */
export interface QueuedStaff {
  id: string;
  role: string;
  /** Server staff-session id of that switch-in (see effectiveTerminalRole). */
  sessionId?: string;
}

export interface QueuedOrder {
  /** Primary key = the order's client UUID (idempotency key). */
  id: string;
  /** The exact payload to upsert via the DB abstraction. */
  payload: CreateOrderInput;
  status: QueueEntryStatus;
  /** Number of flush attempts (for backoff / diagnostics). */
  attempts: number;
  /** Last error message, if the most recent attempt failed. */
  lastError?: string;
  /** HTTP status of the last refusal (needs_attention / rejected). */
  httpStatus?: number;
  /** Machine-readable refusal code from the server (e.g. discount_forbidden). */
  errorCode?: string;
  /** `rejected` only: the cashier saw the refusal (interactive placement). */
  acknowledged?: boolean;
  /** Active staff at queue time (its session id is sent with the flush). */
  queuedBy?: QueuedStaff | null;
  createdAt: number;
  updatedAt: number;
}

class PosOfflineDb extends Dexie {
  orders!: Table<QueuedOrder, string>;

  constructor() {
    super("pos-offline");
    this.version(1).stores({
      // id is the primary key; index status + createdAt for flush ordering.
      orders: "id, status, createdAt",
    });
  }
}

/**
 * Lazily-constructed singleton. Constructing Dexie touches `indexedDB`, so we
 * defer it until first use on the client and never instantiate during SSR.
 */
let _db: PosOfflineDb | null = null;
function db(): PosOfflineDb {
  if (typeof window === "undefined") {
    throw new Error("Offline queue is only available in the browser.");
  }
  if (!_db) _db = new PosOfflineDb();
  return _db;
}

/** Enqueue a placed order (idempotent on the order UUID). */
export async function enqueueOrder(
  payload: CreateOrderInput,
  queuedBy: QueuedStaff | null = null,
): Promise<void> {
  const now = Date.now();
  const existing = await db().orders.get(payload.id);
  if (existing && existing.status === "synced") return;
  await db().orders.put({
    id: payload.id,
    payload,
    status: "pending",
    attempts: existing?.attempts ?? 0,
    queuedBy: queuedBy ?? existing?.queuedBy ?? null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  });
}

/** Does this entry need a person (refused in the background, or legacy)? */
export function needsAttention(o: QueuedOrder): boolean {
  return (
    o.status === "needs_attention" ||
    (o.status === "rejected" && o.acknowledged !== true)
  );
}

/** Retryable without a person: pending / in-flight / transient error. */
function isAutoRetryable(o: QueuedOrder): boolean {
  return (
    o.status === "pending" || o.status === "syncing" || o.status === "error"
  );
}

/**
 * Entries a flush should push, oldest first: the retryable ones plus
 * needs-attention entries refused with 401 (signed out — they go through once
 * the device logs back in, so every flush retries them).
 */
export async function getPendingOrders(): Promise<QueuedOrder[]> {
  const all = await db().orders.orderBy("createdAt").toArray();
  return all.filter(isFlushable);
}

/**
 * Should a background flush push this entry? Retryable ones, plus
 * needs-attention entries refused with 401. Re-checked against a FRESH read
 * right before each post, so an entry resolved meanwhile (an interactive
 * refusal the cashier saw, or a sync) is never re-posted from a stale snapshot.
 */
export function isFlushable(o: QueuedOrder): boolean {
  return isAutoRetryable(o) || (needsAttention(o) && o.httpStatus === 401);
}

/** Entries waiting on staff, oldest first. */
export async function getAttentionOrders(): Promise<QueuedOrder[]> {
  const all = await db().orders.orderBy("createdAt").toArray();
  return all.filter(needsAttention);
}

/** Counts for the status bar: still syncing vs. waiting on staff. */
export async function getQueueCounts(): Promise<{
  pending: number;
  attention: number;
}> {
  const all = await db().orders.toArray();
  return {
    pending: all.filter(isAutoRetryable).length,
    attention: all.filter(needsAttention).length,
  };
}

/**
 * Every order the terminal still owes the server — auto-retrying AND
 * needs-attention. A refused order must never vanish from this number.
 */
export async function getPendingCount(): Promise<number> {
  const c = await getQueueCounts();
  return c.pending + c.attention;
}

export async function getQueuedOrder(
  id: string,
): Promise<QueuedOrder | undefined> {
  return db().orders.get(id);
}

/** No-op on resolved entries (see markNeedsAttention). */
export async function markSyncing(id: string): Promise<void> {
  await db().transaction("rw", db().orders, async () => {
    const entry = await db().orders.get(id);
    if (!entry || isResolved(entry)) return;
    await db().orders.update(id, { status: "syncing", updatedAt: Date.now() });
  });
}

export async function markSynced(id: string): Promise<void> {
  await db().orders.update(id, { status: "synced", updatedAt: Date.now() });
}

export async function markError(id: string, message: string): Promise<void> {
  const entry = await db().orders.get(id);
  await db().orders.update(id, {
    status: "error",
    attempts: (entry?.attempts ?? 0) + 1,
    lastError: message,
    updatedAt: Date.now(),
  });
}

export interface Refusal {
  httpStatus: number;
  message: string;
  code?: string;
}

/**
 * Refused while the cashier was placing it (user present): the refusal was
 * shown and the cart kept, so the entry is hidden (acknowledged).
 */
export async function markRejected(id: string, r: Refusal): Promise<void> {
  const entry = await db().orders.get(id);
  await db().orders.update(id, {
    status: "rejected",
    acknowledged: true,
    attempts: (entry?.attempts ?? 0) + 1,
    lastError: r.message,
    httpStatus: r.httpStatus,
    errorCode: r.code,
    updatedAt: Date.now(),
  });
}

/**
 * Refused during a BACKGROUND flush: keep it and surface it to staff.
 *
 * No-op when the entry is already resolved — synced, or rejected and
 * acknowledged (the cashier saw that refusal and kept the cart). A stale
 * background post must never turn such an entry back into a retryable
 * needs-attention one: a later Retry would then place the order twice.
 */
export async function markNeedsAttention(
  id: string,
  r: Refusal,
): Promise<void> {
  await db().transaction("rw", db().orders, async () => {
    const entry = await db().orders.get(id);
    if (!entry || isResolved(entry)) return;
    await db().orders.update(id, {
      status: "needs_attention",
      acknowledged: false,
      attempts: (entry.attempts ?? 0) + 1,
      lastError: r.message,
      httpStatus: r.httpStatus,
      errorCode: r.code,
      updatedAt: Date.now(),
    });
  });
}

/** Finished entries a background flush must leave alone. */
function isResolved(o: QueuedOrder): boolean {
  return (
    o.status === "synced" ||
    o.status === "discarded" ||
    (o.status === "rejected" && o.acknowledged === true)
  );
}

/**
 * Staff chose "retry" on a needs-attention entry (e.g. after switching in a
 * manager by PIN — the flush then carries that manager's cookie).
 */
export async function requeueOrder(
  id: string,
  patch: { payload?: CreateOrderInput; queuedBy?: QueuedStaff | null } = {},
): Promise<void> {
  const entry = await db().orders.get(id);
  if (!entry || entry.status === "synced") return;
  await db().orders.update(id, {
    status: "pending",
    acknowledged: false,
    httpStatus: undefined,
    errorCode: undefined,
    ...(patch.payload ? { payload: patch.payload } : {}),
    ...(patch.queuedBy !== undefined ? { queuedBy: patch.queuedBy } : {}),
    updatedAt: Date.now(),
  });
}

/**
 * Re-place a needs-attention order WITHOUT its discount (a discount 403 whose
 * authorizing staff session is gone). Same order id — the server never created
 * it. The server re-prices anyway; the local totals are adjusted for display.
 */
export async function requeueWithoutDiscount(id: string): Promise<void> {
  const entry = await db().orders.get(id);
  if (!entry || entry.status === "synced") return;
  const p = entry.payload;
  const discount = p.totals.discount_cents;
  const payload: CreateOrderInput = {
    ...p,
    discount_cents: 0,
    totals: {
      ...p.totals,
      discount_cents: 0,
      taxable_cents: p.totals.taxable_cents + discount,
      total_cents: p.totals.total_cents + discount,
    },
  };
  await requeueOrder(id, { payload });
}

/** Staff explicitly discarded a needs-attention order (hidden, then pruned). */
export async function discardOrder(id: string): Promise<void> {
  await db().orders.update(id, {
    status: "discarded",
    updatedAt: Date.now(),
  });
}

/**
 * Drop finished entries older than `maxAgeMs` to keep the store small: synced,
 * discarded and acknowledged rejections. Needs-attention entries are never
 * pruned.
 */
export async function pruneSynced(maxAgeMs = 86_400_000): Promise<void> {
  const cutoff = Date.now() - maxAgeMs;
  const done = await db()
    .orders.where("status")
    .anyOf("synced", "discarded", "rejected")
    .toArray();
  const stale = done
    .filter((o) => o.updatedAt < cutoff && !needsAttention(o))
    .map((o) => o.id);
  if (stale.length) await db().orders.bulkDelete(stale);
}
