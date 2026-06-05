/**
 * Offline order queue (IndexedDB via Dexie).
 *
 * Strategy: ALWAYS-queue. Every placed order is first written to a durable
 * IndexedDB queue keyed by its client UUID, then flushed to the DB abstraction.
 * Because the key is the order UUID and the driver's `createOrder` is an
 * idempotent upsert-by-UUID, flushing the same entry twice (e.g. after a
 * reconnect or a refresh mid-flight) never creates duplicates.
 *
 * This module is browser-only (IndexedDB). Guard usage behind `typeof window`.
 */
import Dexie, { type Table } from "dexie";
import type { CreateOrderInput } from "@/lib/db";

export type QueueEntryStatus = "pending" | "syncing" | "synced" | "error";

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
export async function enqueueOrder(payload: CreateOrderInput): Promise<void> {
  const now = Date.now();
  const existing = await db().orders.get(payload.id);
  if (existing && existing.status === "synced") return;
  await db().orders.put({
    id: payload.id,
    payload,
    status: "pending",
    attempts: existing?.attempts ?? 0,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  });
}

/** All entries not yet successfully synced, oldest first. */
export async function getPendingOrders(): Promise<QueuedOrder[]> {
  const all = await db().orders.orderBy("createdAt").toArray();
  return all.filter((o) => o.status !== "synced");
}

/** Count of entries still awaiting (or retrying) sync. */
export async function getPendingCount(): Promise<number> {
  return (await getPendingOrders()).length;
}

export async function markSyncing(id: string): Promise<void> {
  await db().orders.update(id, { status: "syncing", updatedAt: Date.now() });
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

/** Drop synced entries older than `maxAgeMs` to keep the store small. */
export async function pruneSynced(maxAgeMs = 86_400_000): Promise<void> {
  const cutoff = Date.now() - maxAgeMs;
  const synced = await db().orders.where("status").equals("synced").toArray();
  const stale = synced.filter((o) => o.updatedAt < cutoff).map((o) => o.id);
  if (stale.length) await db().orders.bulkDelete(stale);
}
