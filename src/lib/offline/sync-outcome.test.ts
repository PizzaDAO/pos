/**
 * @vitest-environment jsdom
 *
 * The terminal must SEE a server refusal: a non-retryable 4xx from /api/orders
 * marks the queued order `rejected` (not retried, not "placed"), while 5xx /
 * network failures stay queued for retry.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";
import type { CreateOrderInput } from "@/lib/db";
import { enqueueOrder, getPendingOrders } from "./queue";
import { syncEntry } from "./sync";

function payload(id: string): CreateOrderInput {
  return {
    id,
    tenant_id: "t1",
    location_id: "l1",
    channel: "in_store",
    currency: "USD",
    items: [],
    discount_cents: 500,
    totals: {
      subtotal_cents: 1000,
      discount_cents: 500,
      taxable_cents: 500,
      tax_cents: 0,
      tip_cents: 0,
      total_cents: 500,
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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("syncEntry outcome", () => {
  it("a 403 is a rejection: surfaced, not retried", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ error: "Only an owner or manager can apply a discount." }),
          { status: 403 },
        ),
      ),
    );
    await enqueueOrder(payload("rej-1"));
    const outcome = await syncEntry(entry("rej-1"));
    expect(outcome).toEqual({
      status: "rejected",
      httpStatus: 403,
      error: "Only an owner or manager can apply a discount.",
    });
    const pending = await getPendingOrders();
    expect(pending.some((o) => o.id === "rej-1")).toBe(false);
  });

  it("a 503 / network failure stays queued for retry", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 503 })),
    );
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

