/** Follow-ups: closed-day channel fee sums (P2) and per-location country updates (P3). */
import { beforeEach, describe, expect, it } from "vitest";
import { DEMO_LOCATION_DOWNTOWN_ID, DEMO_TENANT_ID, getPosDriver, type Order } from "@/lib/db";
import { resetMockOnline, resetMockOrders, resetMockPayments } from "@/lib/db/mock";
import { buildSalesReport } from "@/lib/reports";
import { toContractDailySales } from "./mappers";

beforeEach(() => {
  resetMockOrders();
  resetMockPayments();
  resetMockOnline();
});

const order = (id: string, channel: Order["channel"], fees: number): Order =>
  ({
    id,
    tenant_id: DEMO_TENANT_ID,
    location_id: DEMO_LOCATION_DOWNTOWN_ID,
    status: "paid",
    channel,
    currency: "USD",
    items: [],
    discount_cents: 0,
    totals: {
      subtotal_cents: 1000,
      discount_cents: 0,
      taxable_cents: 1000,
      tax_cents: 0,
      tip_cents: 0,
      total_cents: 1000 + fees,
      ...(fees ? { fees_cents: fees } : {}),
    },
    notes: null,
    order_number: id,
    created_at: "2026-06-04T20:00:00.000Z",
    updated_at: "2026-06-04T20:00:00.000Z",
  }) as Order;

describe("P2: closed-day snapshot channel buckets sum to the day's service fee", () => {
  it("by_channel.service_fee_cents sums to service_fee_cents", () => {
    const report = buildSalesReport({
      tenantId: DEMO_TENANT_ID,
      locationId: DEMO_LOCATION_DOWNTOWN_ID,
      range: { from: null, to: null },
      orders: [order("a", "online_pickup", 300), order("b", "in_store", 0), order("c", "online_pickup", 200)],
      payments: [],
      categoryOf: () => null,
      locationName: () => "x",
    });
    const daily = toContractDailySales(
      {
        id: "x", tenant_id: DEMO_TENANT_ID, location_id: DEMO_LOCATION_DOWNTOWN_ID,
        business_date: "2026-06-04", report, drawer: {}, closed_at: "2026-06-05T00:00:00.000Z",
      } as never,
      "USD",
    );
    expect(daily.service_fee_cents).toBe(500);
    expect(daily.by_channel.reduce((n, b) => n + b.service_fee_cents, 0)).toBe(daily.service_fee_cents);
  });
});

describe("P3: setLocationCountry", () => {
  it("sets and clears the country, scoped to the tenant", async () => {
    const d = getPosDriver();
    const set = await d.setLocationCountry(DEMO_TENANT_ID, DEMO_LOCATION_DOWNTOWN_ID, "GB");
    expect(set?.country).toBe("GB");
    expect((await d.listLocations(DEMO_TENANT_ID)).find((l) => l.id === DEMO_LOCATION_DOWNTOWN_ID)?.country).toBe("GB");
    expect(await d.setLocationCountry("20000000-0000-4000-8000-0000000000bb", DEMO_LOCATION_DOWNTOWN_ID, "FR")).toBeNull();
    expect((await d.setLocationCountry(DEMO_TENANT_ID, DEMO_LOCATION_DOWNTOWN_ID, null))?.country ?? null).toBeNull();
  });
});
