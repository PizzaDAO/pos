import { describe, it, expect } from "vitest";
import type { Order } from "@/lib/db";
import { buildTickets, DEFAULT_KDS_THRESHOLDS } from "./board";
import {
  handoffLabel,
  isHandoffStatus,
  kitchenHandsOffDelivery,
  nextBumpStatus,
} from "./status";

const o = (
  status: Order["status"],
  channel: Order["channel"],
  provider?: string,
): Pick<Order, "status" | "channel" | "fulfillment"> => ({
  status,
  channel,
  fulfillment: provider
    ? ({ delivery_provider: provider } as Order["fulfillment"])
    : undefined,
});

describe("KDS hand-off", () => {
  it("a Ready pickup/in-store ticket is 'Picked up' and bumps to completed", () => {
    expect(nextBumpStatus("ready", "in_store")).toBe("completed");
    expect(nextBumpStatus("ready", "online_pickup")).toBe("completed");
    expect(handoffLabel(o("ready", "in_store"))).toBe("Picked up");
    expect(handoffLabel(o("ready", "online_pickup"))).toBe("Picked up");
  });

  it("in-house manual delivery: Out with driver, then Delivered", () => {
    expect(nextBumpStatus("ready", "online_delivery")).toBe("out_for_delivery");
    expect(handoffLabel(o("ready", "online_delivery", "in_house_manual"))).toBe("Out with driver");
    // No recorded provider means in-house (same default as dispatch).
    expect(handoffLabel(o("ready", "online_delivery"))).toBe("Out with driver");
    expect(handoffLabel(o("out_for_delivery", "online_delivery", "in_house_manual"))).toBe("Delivered");
  });

  it("provider-run delivery gets no hand-off button", () => {
    for (const p of ["doordash_drive", "openpizza_driver"]) {
      expect(handoffLabel(o("ready", "online_delivery", p))).toBeNull();
      expect(handoffLabel(o("out_for_delivery", "online_delivery", p))).toBeNull();
      expect(kitchenHandsOffDelivery(o("ready", "online_delivery", p))).toBe(false);
    }
  });

  it("only hand-off-lane tickets offer a hand-off", () => {
    expect(handoffLabel(o("in_kitchen", "in_store"))).toBeNull();
    expect(handoffLabel(o("completed", "in_store"))).toBeNull();
  });

  it("out_for_delivery stays in the hand-off lane, not the live grid", () => {
    expect(isHandoffStatus("out_for_delivery")).toBe(true);
    expect(isHandoffStatus("ready")).toBe(true);
    expect(isHandoffStatus("in_kitchen")).toBe(false);
    expect(isHandoffStatus("recall")).toBe(false);
  });

  it("handed-off (completed) orders drop off the board", () => {
    const base = {
      tenant_id: "t",
      location_id: "l",
      channel: "in_store",
      items: [],
      created_at: new Date().toISOString(),
    };
    const tickets = buildTickets(
      [
        { ...base, id: "a", status: "ready" },
        { ...base, id: "b", status: "completed" },
      ] as unknown as Order[],
      new Date(),
      DEFAULT_KDS_THRESHOLDS,
    );
    expect(tickets.map((t) => t.order.id)).toEqual(["a"]);
  });

  it("the delivery record's provider wins over the order's quoted one", () => {
    const switched = o("out_for_delivery", "online_delivery", "openpizza_driver");
    expect(handoffLabel(switched)).toBeNull();
    expect(handoffLabel(switched, "in_house_manual")).toBe("Delivered");
    expect(handoffLabel(o("ready", "online_delivery", "in_house_manual"), "doordash_drive")).toBeNull();
  });
});
