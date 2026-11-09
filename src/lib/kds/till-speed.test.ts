import { describe, it, expect } from "vitest";
import type { Order, OrderItem } from "@/lib/db";
import {
  buildTickets,
  DEFAULT_KDS_THRESHOLDS,
  hasKitchenWork,
} from "./board";
import { newTickets } from "./alert";
import { noPrepBumpCount } from "./status";
import type { KitchenTicket } from "./types";

const line = (over: Partial<OrderItem>): OrderItem =>
  ({
    id: "l",
    item_id: "i",
    item_name: "Item",
    size_id: null,
    size_name: null,
    base_price_cents: 0,
    quantity: 1,
    modifiers: [],
    notes: null,
    voided: false,
    unit_price_cents: 0,
    line_total_cents: 0,
    ...over,
  }) as OrderItem;

const order = (id: string, items: OrderItem[]): Order =>
  ({
    id,
    status: "placed",
    channel: "in_store",
    items,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }) as Order;

describe("drink-only (no prep) orders", () => {
  const soda = line({ station: "none" });
  const pie = line({ id: "p", station: "oven" });
  it("have no kitchen work but stay on the board for hand-off", () => {
    expect(hasKitchenWork(order("a", [soda]))).toBe(false);
    const tickets = buildTickets(
      [order("a", [soda]), order("b", [soda, pie])],
      new Date(),
      DEFAULT_KDS_THRESHOLDS,
    );
    expect(tickets.map((t) => t.order.id).sort()).toEqual(["a", "b"]);
  });
  it("one tap bumps through to completed (delivery stops at Ready)", () => {
    expect(noPrepBumpCount("placed", "in_store")).toBe(3);
    expect(noPrepBumpCount("paid", "online_pickup")).toBe(3);
    expect(noPrepBumpCount("in_kitchen", "in_store")).toBe(2);
    expect(noPrepBumpCount("placed", "online_delivery")).toBe(2);
  });
  it("keep a ticket when fired food was voided (STOP line)", () => {
    const voidedPie = line({ id: "v", station: "oven", voided: true, fired_at: "2026-01-01T00:00:00Z" });
    expect(hasKitchenWork(order("c", [soda, voidedPie]))).toBe(true);
  });
});

describe("newTickets", () => {
  const t = (id: string) => ({ order: { id } }) as KitchenTicket;
  it("is empty on first load and finds only unseen ids afterwards", () => {
    expect(newTickets(null, [t("a")])).toEqual([]);
    expect(newTickets(new Set(["a"]), [t("a"), t("b")]).map((x) => x.order.id)).toEqual(["b"]);
  });
});
