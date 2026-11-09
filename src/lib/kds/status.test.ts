import { describe, it, expect } from "vitest";
import type { Order } from "@/lib/db";
import { buildTickets, DEFAULT_KDS_THRESHOLDS } from "./board";
import { handoffLabel, nextBumpStatus } from "./status";

describe("KDS hand-off", () => {
  it("a Ready pickup/in-store ticket bumps to completed", () => {
    expect(nextBumpStatus("ready", "in_store")).toBe("completed");
    expect(nextBumpStatus("ready", "online_pickup")).toBe("completed");
    expect(handoffLabel("ready", "in_store")).toBe("Picked up");
  });

  it("a Ready delivery ticket goes out with the driver", () => {
    expect(nextBumpStatus("ready", "online_delivery")).toBe("out_for_delivery");
    expect(handoffLabel("ready", "online_delivery")).toBe("Out with driver");
  });

  it("only Ready tickets offer a hand-off", () => {
    expect(handoffLabel("in_kitchen", "in_store")).toBeNull();
    expect(handoffLabel("completed", "in_store")).toBeNull();
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
});
