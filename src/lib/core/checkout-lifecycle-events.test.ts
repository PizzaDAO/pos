/**
 * Core events vs main's online checkout lifecycle: an online order that is
 * still `awaiting_payment` is not announced (the kitchen does not see it
 * either); it is announced once, as `order.placed`, when it is paid, and an
 * `abandoned` checkout emits nothing. The contract maps the two statuses the
 * core vocabulary predates.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  getPosDriver,
  DEMO_LOCATION_DOWNTOWN_ID,
  DEMO_TENANT_ID,
  type CreateOrderInput,
} from "@/lib/db";
import { resetMockOnline, resetMockOrders, resetMockPayments } from "@/lib/db/mock";
import { memoryOutbox } from "./outbox";
import { toPosOrderStatus } from "./mappers";

beforeEach(() => {
  resetMockOrders();
  resetMockPayments();
  resetMockOnline();
  memoryOutbox.clear();
});

function onlineOrder(id: string): CreateOrderInput {
  return {
    id,
    tenant_id: DEMO_TENANT_ID,
    location_id: DEMO_LOCATION_DOWNTOWN_ID,
    channel: "online_pickup",
    currency: "USD",
    items: [],
    discount_cents: 0,
    totals: {
      subtotal_cents: 0,
      discount_cents: 0,
      taxable_cents: 0,
      tax_cents: 0,
      tip_cents: 0,
      total_cents: 0,
    },
    notes: null,
    status: "awaiting_payment",
  };
}

const types = () => memoryOutbox.rows.map((r) => r.event_type);

describe("core events for awaiting_payment / abandoned orders", () => {
  it("an unpaid checkout is announced only when it is paid", async () => {
    const d = getPosDriver();
    const id = "22222222-0000-4000-8000-000000000001";
    await d.createOrder(onlineOrder(id));
    expect(types()).toEqual([]);
    const paid = await d.transitionOrderStatus(id, ["awaiting_payment"], "paid");
    expect(paid?.status).toBe("paid");
    expect(types()).toEqual(["order.placed"]);
    expect(memoryOutbox.rows[0]!.changes).toEqual({
      status: ["awaiting_payment", "paid"],
    });
  });

  it("an abandoned checkout emits nothing", async () => {
    const d = getPosDriver();
    const id = "22222222-0000-4000-8000-000000000002";
    await d.createOrder(onlineOrder(id));
    await d.transitionOrderStatus(id, ["awaiting_payment"], "abandoned");
    expect(types()).toEqual([]);
  });

  it("maps the statuses the core contract predates", () => {
    expect(toPosOrderStatus("awaiting_payment")).toBe("placed");
    expect(toPosOrderStatus("abandoned")).toBe("voided");
    expect(toPosOrderStatus("in_kitchen")).toBe("in_kitchen");
  });
});
