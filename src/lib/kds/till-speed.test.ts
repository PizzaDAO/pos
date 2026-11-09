import { describe, it, expect } from "vitest";
import type { Menu, Order, OrderItem, OrderItemModifier } from "@/lib/db";
import {
  buildTickets,
  defaultModifierIds,
  DEFAULT_KDS_THRESHOLDS,
  hasKitchenWork,
} from "./board";
import { withoutDefaultModifiers } from "./format";
import { newTickets } from "./alert";
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

describe("drink-only orders", () => {
  const soda = line({ station: "none" });
  const pie = line({ id: "p", station: "oven" });
  it("have no kitchen work and never become tickets", () => {
    expect(hasKitchenWork(order("a", [soda]))).toBe(false);
    const tickets = buildTickets(
      [order("a", [soda]), order("b", [soda, pie])],
      new Date(),
      DEFAULT_KDS_THRESHOLDS,
    );
    expect(tickets.map((t) => t.order.id)).toEqual(["b"]);
  });
  it("keep a ticket when fired food was voided (STOP line)", () => {
    const voidedPie = line({ id: "v", station: "oven", voided: true, fired_at: "2026-01-01T00:00:00Z" });
    expect(hasKitchenWork(order("c", [soda, voidedPie]))).toBe(true);
  });
});

describe("default modifiers on tickets", () => {
  const menu = {
    categories: [
      {
        items: [
          {
            modifierGroups: [
              { supports_half: false, min_select: 1, modifiers: [{ id: "hand" }, { id: "thin" }] },
              { supports_half: false, min_select: 1, modifiers: [{ id: "tomato" }, { id: "white" }] },
              { supports_half: true, min_select: 0, modifiers: [{ id: "mush" }] },
              { supports_half: false, min_select: 0, modifiers: [{ id: "opt" }] },
            ],
          },
        ],
      },
    ],
  } as unknown as Menu;
  it("collects the first option of each required single-select group", () => {
    expect(defaultModifierIds(menu).sort()).toEqual(["hand", "tomato"]);
  });
  it("hides defaults, keeping changes and toppings", () => {
    const m = (id: string, placement: OrderItemModifier["placement"] = "whole") =>
      ({ modifier_id: id, modifier_name: id, placement }) as OrderItemModifier;
    const shown = withoutDefaultModifiers(
      [m("hand"), m("white"), m("mush", "left"), m("tomato", "left")],
      new Set(["hand", "tomato"]),
    );
    expect(shown.map((x) => x.modifier_id)).toEqual(["white", "mush", "tomato"]);
    const same = [m("hand")];
    expect(withoutDefaultModifiers(same, new Set())).toBe(same);
  });
});

describe("newTickets", () => {
  const t = (id: string) => ({ order: { id } }) as KitchenTicket;
  it("is empty on first load and finds only unseen ids afterwards", () => {
    expect(newTickets(null, [t("a")])).toEqual([]);
    expect(newTickets(new Set(["a"]), [t("a"), t("b")]).map((x) => x.order.id)).toEqual(["b"]);
  });
});
