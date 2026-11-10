import { describe, expect, it } from "vitest";
import { DEMO_LOCATION_DOWNTOWN_ID, DEMO_TENANT_ID, getPosDriver, OrderIdTakenError } from "@/lib/db";

const input = (tenant: string) => ({
  id: "mock-order-id-1",
  tenant_id: tenant,
  location_id: DEMO_LOCATION_DOWNTOWN_ID,
  channel: "in_store" as const,
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
});

describe("mock createOrder order ids", () => {
  it("is idempotent within a tenant and refuses another tenant's id", async () => {
    const d = getPosDriver();
    const a = await d.createOrder(input(DEMO_TENANT_ID));
    expect((await d.createOrder(input(DEMO_TENANT_ID))).id).toBe(a.id);
    await expect(d.createOrder(input("someone-else"))).rejects.toBeInstanceOf(OrderIdTakenError);
  });
});
