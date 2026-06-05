/**
 * @vitest-environment jsdom
 *
 * Offline-queue idempotency tests. Uses a real (fake) IndexedDB so the Dexie
 * upsert-by-UUID behaviour is exercised exactly as in the browser. The queue is
 * the first half of the store-and-forward guarantee; the second half (the
 * driver's `createOrder` upsert) is covered in offline-sync.test.ts.
 */
import { describe, it, expect, beforeEach } from "vitest";
import "fake-indexeddb/auto";
import type { CreateOrderInput } from "@/lib/db";
import {
  enqueueOrder,
  getPendingOrders,
  getPendingCount,
  markSynced,
} from "@/lib/offline/queue";

function payload(id: string): CreateOrderInput {
  return {
    id,
    tenant_id: "t1",
    location_id: "l1",
    channel: "in_store",
    currency: "USD",
    items: [],
    discount_cents: 0,
    totals: {
      subtotal_cents: 1000,
      discount_cents: 0,
      taxable_cents: 1000,
      tax_cents: 0,
      tip_cents: 0,
      total_cents: 1000,
    },
    notes: null,
  };
}

beforeEach(async () => {
  // Clear any prior entries so each test starts from an empty queue.
  for (const e of await getPendingOrders()) {
    await markSynced(e.id);
  }
});

describe("offline queue — idempotent upsert by order UUID", () => {
  it("enqueuing the same order id twice keeps a single pending entry", async () => {
    const id = `q-${Date.now()}-1`;
    await enqueueOrder(payload(id));
    await enqueueOrder(payload(id));
    const pending = (await getPendingOrders()).filter((e) => e.id === id);
    expect(pending).toHaveLength(1);
  });

  it("does not re-enqueue an order that already synced", async () => {
    const id = `q-${Date.now()}-2`;
    await enqueueOrder(payload(id));
    await markSynced(id);
    await enqueueOrder(payload(id)); // double-flush / refresh mid-flight
    const stillPending = (await getPendingOrders()).filter((e) => e.id === id);
    expect(stillPending).toHaveLength(0);
  });

  it("tracks multiple distinct orders independently", async () => {
    const a = `q-${Date.now()}-a`;
    const b = `q-${Date.now()}-b`;
    await enqueueOrder(payload(a));
    await enqueueOrder(payload(b));
    const count = await getPendingCount();
    expect(count).toBeGreaterThanOrEqual(2);
    const ids = (await getPendingOrders()).map((e) => e.id);
    expect(ids).toContain(a);
    expect(ids).toContain(b);
  });
});
