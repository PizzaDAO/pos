/**
 * @vitest-environment jsdom
 *
 * The offline queue must NEVER silently drop an order:
 *   - a non-retryable 4xx during a BACKGROUND flush → `needs_attention`
 *     (counted, listed, resolvable/discardable), never hidden;
 *   - only the INTERACTIVE placement (cashier present) may show an immediate
 *     rejection (the cart is kept, the entry hidden);
 *   - a 401 is retried on every flush (succeeds after re-login);
 *   - a discount 403 can be re-placed without the discount;
 *   - the queued-time staff session is sent with the flush;
 *   - 5xx / network failures stay queued for retry.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";
import type { CreateOrderInput } from "@/lib/db";
import {
  discardOrder,
  enqueueOrder,
  getAttentionOrders,
  getPendingCount,
  getPendingOrders,
  getQueueCounts,
  getQueuedOrder,
  markSynced,
  pruneSynced,
  requeueWithoutDiscount,
  type QueuedStaff,
} from "./queue";
import { flushQueue, placeOrderNow, syncEntry } from "./sync";

function payload(id: string, discount = 500): CreateOrderInput {
  return {
    id,
    tenant_id: "t1",
    location_id: "l1",
    channel: "in_store",
    currency: "USD",
    items: [],
    discount_cents: discount,
    totals: {
      subtotal_cents: 1000,
      discount_cents: discount,
      taxable_cents: 1000 - discount,
      tax_cents: 0,
      tip_cents: 0,
      total_cents: 1000 - discount,
    },
    notes: null,
  };
}

function entry(id: string) {
  return {
    id,
    payload: payload(id),
    status: "pending" as const,
    attempts: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

const DISCOUNT_403 = {
  error: "Only an owner or manager can apply a discount.",
  code: "discount_forbidden",
};

function respond(status: number, body: unknown = {}) {
  const fn = vi.fn(
    async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify(body), { status }),
  );
  vi.stubGlobal("fetch", fn);
  return fn;
}

beforeEach(async () => {
  // Start every test from an empty queue (prune everything finished, then
  // resolve whatever is left).
  for (const e of await getPendingOrders()) await markSynced(e.id);
  for (const e of await getAttentionOrders()) await discardOrder(e.id);
  await pruneSynced(-1);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("background flush never drops a refused order", () => {
  it("a 403 discount refusal → needs attention: counted, listed, not hidden", async () => {
    respond(403, DISCOUNT_403);
    await enqueueOrder(payload("bg-403"));
    const result = await flushQueue();
    expect(result.needsAttention).toBe(1);

    const e = await getQueuedOrder("bg-403");
    expect(e?.status).toBe("needs_attention");
    expect(e?.errorCode).toBe("discount_forbidden");
    expect(e?.httpStatus).toBe(403);
    expect((await getAttentionOrders()).map((o) => o.id)).toEqual(["bg-403"]);
    // The pending number shown to staff still includes it.
    expect(await getPendingCount()).toBe(1);
    expect(await getQueueCounts()).toEqual({ pending: 0, attention: 1 });
    // Not pruned, however old.
    await pruneSynced(-1);
    expect(await getQueuedOrder("bg-403")).toBeDefined();
  });

  it("a 422 refusal → needs attention, not auto-retried; staff can discard it", async () => {
    const fetch = respond(422, { error: "Item is 86'd." });
    await enqueueOrder(payload("bg-422", 0));
    await flushQueue();
    expect((await getQueuedOrder("bg-422"))?.status).toBe("needs_attention");
    fetch.mockClear();
    await flushQueue();
    expect(fetch).not.toHaveBeenCalled(); // waits for staff, no hammering

    await discardOrder("bg-422");
    expect(await getAttentionOrders()).toEqual([]);
    expect(await getPendingCount()).toBe(0);
  });

  it("a 401 (signed out) is retried on every flush and goes through after re-login", async () => {
    respond(401, { error: "Not signed in." });
    await enqueueOrder(payload("bg-401", 0));
    await flushQueue();
    expect((await getQueuedOrder("bg-401"))?.status).toBe("needs_attention");
    expect(await getPendingCount()).toBe(1);

    // Re-login: the next background flush succeeds on its own.
    const ok = respond(201, { order: {} });
    await flushQueue();
    expect(ok).toHaveBeenCalledTimes(1);
    expect((await getQueuedOrder("bg-401"))?.status).toBe("synced");
    expect(await getPendingCount()).toBe(0);
  });

  it("a discount 403 can be re-placed WITHOUT the discount (same order id)", async () => {
    respond(403, DISCOUNT_403);
    await enqueueOrder(payload("bg-nodisc"));
    await flushQueue();

    const ok = respond(201, { order: {} });
    await requeueWithoutDiscount("bg-nodisc");
    await flushQueue();
    const sent = JSON.parse(String(ok.mock.calls[0]![1]!.body)) as CreateOrderInput;
    expect(sent.id).toBe("bg-nodisc");
    expect(sent.discount_cents).toBe(0);
    expect(sent.totals.total_cents).toBe(1000);
    expect((await getQueuedOrder("bg-nodisc"))?.status).toBe("synced");
  });

  it("legacy hidden `rejected` entries (no acknowledged flag) resurface as needs attention", async () => {
    respond(403, DISCOUNT_403);
    await enqueueOrder(payload("legacy-rej"));
    // Simulate the old build: status rejected, no acknowledged flag.
    const { default: Dexie } = await import("dexie");
    const db = new Dexie("pos-offline");
    db.version(1).stores({ orders: "id, status, createdAt" });
    await db.table("orders").update("legacy-rej", { status: "rejected" });
    db.close();
    expect((await getAttentionOrders()).map((o) => o.id)).toContain("legacy-rej");
    expect(await getPendingCount()).toBeGreaterThanOrEqual(1);
  });

  it("5xx / network failures stay queued for retry", async () => {
    respond(503);
    await enqueueOrder(payload("err-1"));
    expect((await syncEntry(entry("err-1"))).status).toBe("error");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    expect((await syncEntry(entry("err-1"))).status).toBe("error");
    const pending = await getPendingOrders();
    expect(pending.some((o) => o.id === "err-1")).toBe(true);
  });
});

describe("interactive placement (cashier present)", () => {
  const manager: QueuedStaff = { id: "s-mgr", role: "manager", sessionId: "sess-123" };

  it("shows the rejection immediately; the entry is hidden (cart kept by the caller)", async () => {
    respond(403, DISCOUNT_403);
    const outcome = await placeOrderNow(payload("int-403"), manager, true);
    expect(outcome).toEqual({
      status: "rejected",
      httpStatus: 403,
      error: DISCOUNT_403.error,
      code: "discount_forbidden",
    });
    expect((await getQueuedOrder("int-403"))?.status).toBe("rejected");
    expect(await getAttentionOrders()).toEqual([]);
    expect(await getPendingCount()).toBe(0);
  });

  it("records the active staff at queue time and sends its session with the flush", async () => {
    const fetch = respond(201, { order: {} });
    expect((await placeOrderNow(payload("int-ok"), manager, true)).status).toBe("synced");
    const body = JSON.parse(String(fetch.mock.calls[0]![1]!.body)) as Record<string, unknown>;
    expect(body.queued_staff_session_id).toBe("sess-123");
    expect((await getQueuedOrder("int-ok"))?.queuedBy).toEqual(manager);
  });

  it("offline: queued with its staff; the later background flush carries the session", async () => {
    const outcome = await placeOrderNow(payload("int-offline"), manager, false);
    expect(outcome.status).toBe("error");
    expect(await getPendingCount()).toBe(1);
    const fetch = respond(201, { order: {} });
    await flushQueue();
    const body = JSON.parse(String(fetch.mock.calls[0]![1]!.body)) as Record<string, unknown>;
    expect(body.queued_staff_session_id).toBe("sess-123");
    expect(body.id).toBe("int-offline");
  });

  it("a background flush running concurrently never grabs an order being placed", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fetch = vi.fn(async () => {
      await gate;
      return new Response(JSON.stringify(DISCOUNT_403), { status: 403 });
    });
    vi.stubGlobal("fetch", fetch);
    const placing = placeOrderNow(payload("int-race"), manager, true);
    await new Promise((r) => setTimeout(r, 10)); // enqueued, request in flight
    const flushing = flushQueue();
    release();
    const [outcome] = await Promise.all([placing, flushing]);
    expect(outcome.status).toBe("rejected");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await getQueuedOrder("int-race"))?.status).toBe("rejected");
  });
});
