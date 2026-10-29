import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { POST } from "./route";

// Uptown is pickup-only; Caesar Salad (single size, no modifier groups) = 899.
const SALAD = "30000000-0000-0000-0000-000000000020";
const SALAD_SIZE = "40000000-0000-0000-0000-000000000031";

let seq = 0;

function tamperedLine(over: Record<string, unknown> = {}) {
  return {
    id: "line-1",
    item_id: SALAD,
    item_name: "Free salad",
    size_id: SALAD_SIZE,
    size_name: "Regular",
    base_price_cents: 1,
    quantity: 2,
    modifiers: [],
    notes: null,
    voided: false,
    unit_price_cents: 1,
    line_total_cents: 2,
    ...over,
  };
}

function req(body: unknown, ip = "7.7.7.7") {
  return new Request("http://localhost/api/shop/orders", {
    method: "POST",
    headers: { "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
}

function order(over: Record<string, unknown> = {}) {
  seq += 1;
  return {
    id: `shop-order-${seq}`,
    locationSlug: "tonys-uptown",
    items: [tamperedLine()],
    fulfillmentType: "pickup",
    scheduledFor: "asap",
    customer: { email: `buyer${seq}@example.com` },
    ...over,
  };
}

describe("POST /api/shop/orders", () => {
  beforeEach(() => {
    // Wednesday noon: inside the seeded 11:00-22:00 hours.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 5, 3, 12, 0, 0));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("ignores client prices: totals come from the menu", async () => {
    const res = await POST(req(order({ tipCents: 100 })));
    expect(res.status).toBe(201);
    const { order: placed } = await res.json();
    // 2 x $8.99 from the menu, not 2 x 1c.
    expect(placed.items[0].base_price_cents).toBe(899);
    expect(placed.items[0].item_name).toBe("Caesar Salad");
    expect(placed.totals.subtotal_cents).toBe(1798);
    expect(placed.totals.tip_cents).toBe(100);
    expect(placed.totals.total_cents).toBe(
      placed.totals.subtotal_cents + placed.totals.tax_cents + 100,
    );
  });

  it("rejects an unknown item with 422", async () => {
    const res = await POST(
      req(order({ items: [tamperedLine({ item_id: "nope" })] })),
    );
    expect(res.status).toBe(422);
  });

  it("rejects a tip above the subtotal and a fractional tip", async () => {
    expect((await POST(req(order({ tipCents: 99_999 })))).status).toBe(422);
    expect((await POST(req(order({ tipCents: 1.5 })))).status).toBe(422);
  });

  it("rate-limits order intake per IP", async () => {
    // The limiter is off under Vitest; turn it on for this test.
    vi.stubEnv("VITEST", "");
    vi.stubEnv("NODE_ENV", "development");
    const statuses: number[] = [];
    for (let i = 0; i < 61; i += 1) {
      // Malformed payloads are cheap and still count against the bucket.
      statuses.push((await POST(req({}, "8.8.8.8"))).status);
    }
    expect(statuses.slice(0, 60).every((s) => s === 422)).toBe(true);
    expect(statuses[60]).toBe(429);
  });
});
