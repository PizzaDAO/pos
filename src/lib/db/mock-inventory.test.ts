/**
 * Inventory depletion + low-stock tests against the mock driver.
 *
 * Placing an order walks each line + its modifiers, resolves the per-location
 * inventory row for every linked recipe component, decrements it, and records a
 * `depletion` movement. A row at/under its threshold flags `low`.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  getPosDriver,
  DEMO_TENANT_ID,
  DEMO_LOCATION_DOWNTOWN_ID,
  type CreateOrderInput,
  type OrderItem,
} from "@/lib/db";
import { resetMockOrders } from "@/lib/db/mock";

const ITEM_MARGHERITA = "30000000-0000-0000-0000-000000000001";
const ITEM_PEPPERONI = "30000000-0000-0000-0000-000000000002";

function line(itemId: string, qty: number): OrderItem {
  return {
    id: `l-${itemId}-${qty}`,
    item_id: itemId,
    item_name: "Pizza",
    size_id: "s1",
    size_name: "L",
    base_price_cents: 1800,
    quantity: qty,
    modifiers: [],
    notes: null,
    voided: false,
    unit_price_cents: 1800,
    line_total_cents: 1800 * qty,
  };
}

let seq = 0;
async function placeOrder(
  items: OrderItem[],
  status?: CreateOrderInput["status"],
) {
  seq += 1;
  const input: CreateOrderInput = {
    id: `inv-order-${Date.now()}-${seq}`,
    tenant_id: DEMO_TENANT_ID,
    location_id: DEMO_LOCATION_DOWNTOWN_ID,
    channel: "in_store",
    currency: "USD",
    items,
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
    status,
  };
  return getPosDriver().createOrder(input);
}

async function onHand(name: string): Promise<number> {
  const inv = await getPosDriver().listInventory(
    DEMO_TENANT_ID,
    DEMO_LOCATION_DOWNTOWN_ID,
  );
  return inv.find((i) => i.name === name)?.on_hand ?? -1;
}

beforeEach(() => resetMockOrders());

describe("inventory depletion on order placement", () => {
  it("decrements linked recipe components by qty * line quantity", async () => {
    const doughBefore = await onHand("Pizza dough ball");
    const cheeseBefore = await onHand("Mozzarella");

    // Margherita consumes 1 dough + 150g cheese per pizza; order 2.
    await placeOrder([line(ITEM_MARGHERITA, 2)]);

    expect(await onHand("Pizza dough ball")).toBe(doughBefore - 2);
    expect(await onHand("Mozzarella")).toBe(cheeseBefore - 300);
  });

  it("records a depletion movement linked to the order", async () => {
    const order = await placeOrder([line(ITEM_MARGHERITA, 1)]);
    const moves = await getPosDriver().listInventoryMovements(
      DEMO_TENANT_ID,
      DEMO_LOCATION_DOWNTOWN_ID,
    );
    const forOrder = moves.filter((m) => m.order_id === order.id);
    expect(forOrder.length).toBeGreaterThan(0);
    expect(forOrder.every((m) => m.reason === "depletion")).toBe(true);
    expect(forOrder.every((m) => m.delta < 0)).toBe(true);
  });

  it("does NOT deplete for an order created already voided", async () => {
    const doughBefore = await onHand("Pizza dough ball");
    await placeOrder([line(ITEM_MARGHERITA, 3)], "voided");
    expect(await onHand("Pizza dough ball")).toBe(doughBefore);
  });

  it("flags low stock once on-hand crosses the threshold", async () => {
    // Downtown pepperoni starts at 600g, threshold 500g, 80g/pizza.
    // Two pepperoni pizzas = 160g → 440g, below threshold → low.
    await placeOrder([line(ITEM_PEPPERONI, 2)]);
    const inv = await getPosDriver().listInventory(
      DEMO_TENANT_ID,
      DEMO_LOCATION_DOWNTOWN_ID,
    );
    const pep = inv.find((i) => i.name === "Pepperoni");
    expect(pep?.on_hand).toBeLessThanOrEqual(pep!.low_threshold);
    expect(pep?.low).toBe(true);
  });

  it("never drives on-hand below zero", async () => {
    // Far more than stock — clamps at 0.
    await placeOrder([line(ITEM_PEPPERONI, 1000)]);
    expect(await onHand("Pepperoni")).toBe(0);
  });
});
