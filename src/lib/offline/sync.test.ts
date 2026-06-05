/**
 * Store-and-forward end-to-end idempotency at the DB layer.
 *
 * The offline flush POSTs each queued order to /api/orders, which calls
 * `driver.createOrder` — an idempotent upsert-by-UUID. This test simulates the
 * server side of a double-flush + reconnect-retry by calling `createOrder`
 * repeatedly with the same client UUID and asserting exactly one order ever
 * exists. (The IndexedDB half is covered in queue.test.ts.)
 */
import { describe, it, expect, beforeEach } from "vitest";
import { getPosDriver, type CreateOrderInput } from "@/lib/db";
import { resetMockOrders } from "@/lib/db/mock";

function payload(id: string): CreateOrderInput {
  return {
    id,
    tenant_id: "10000000-0000-0000-0000-000000000001",
    location_id: "10000000-0000-0000-0000-000000000101",
    channel: "in_store",
    currency: "USD",
    items: [],
    discount_cents: 0,
    totals: {
      subtotal_cents: 1500,
      discount_cents: 0,
      taxable_cents: 1500,
      tax_cents: 0,
      tip_cents: 0,
      total_cents: 1500,
    },
    notes: null,
  };
}

beforeEach(() => resetMockOrders());

describe("offline sync — createOrder upsert never duplicates", () => {
  it("re-submitting the same order UUID returns the same order, assigns the number once", async () => {
    const driver = getPosDriver();
    const id = "offline-order-1";

    const first = await driver.createOrder(payload(id));
    const number = first.order_number;

    // Double-flush + a later reconnect retry: same payload, same id, 3x.
    const again = await driver.createOrder(payload(id));
    const yetAgain = await driver.createOrder(payload(id));

    expect(again.id).toBe(first.id);
    expect(again.order_number).toBe(number);
    expect(yetAgain.order_number).toBe(number);

    const all = await driver.listOrders(
      payload(id).tenant_id,
      payload(id).location_id,
    );
    expect(all.filter((o) => o.id === id)).toHaveLength(1);
  });

  it("assigns DISTINCT order numbers to distinct client UUIDs", async () => {
    const driver = getPosDriver();
    const a = await driver.createOrder(payload("offline-a"));
    const b = await driver.createOrder(payload("offline-b"));
    expect(a.order_number).not.toBe(b.order_number);
  });
});
