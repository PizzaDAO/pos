/**
 * Business-date bucketing for the Z-report / sales report / EOD drawer: orders
 * (created_at) and closed drawers (closed_at) fall on the LOCATION's local
 * business date, across a New York evening and both DST boundaries.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { businessDate } from "@openpizza/core";
import {
  getPosDriver,
  DEMO_TENANT_ID,
  DEMO_LOCATION_DOWNTOWN_ID,
  type Order,
  type Shift,
  type DrawerReconciliation,
} from "@/lib/db";
import { resetMockOrders } from "@/lib/db/mock";
import { buildSalesReport, locationBusinessDate } from "@/lib/reports";
import { eodDrawerSummary } from "@/lib/eod-drawer";

vi.mock("@/lib/auth/tenant-guard", () => ({
  requireTenantAccess: async (tenantId: string, _s: string, o?: { locationId?: string }) => ({
    ok: true,
    tenantId,
    locationId: o?.locationId ?? null,
    user: { id: "u1", email: "m@x" },
  }),
}));

import { GET, POST } from "@/app/api/admin/eod/route";

const NY = { timezone: "America/New_York", business_day_cutoff_minutes: 0 };

describe("locationBusinessDate", () => {
  it("a New York evening is still that day (not tomorrow's UTC date)", () => {
    // 22:30 EST Mon Nov 9 = 03:30Z Nov 10.
    expect(locationBusinessDate("2026-11-10T03:30:00Z", NY)).toBe("2026-11-09");
    expect(locationBusinessDate("2026-11-10T03:30:00Z", null)).toBe("2026-11-10");
  });

  it("matches core businessDate(at, tz) at cutoff 0, across DST", () => {
    for (const at of [
      "2026-11-10T03:30:00Z",
      "2026-03-08T04:30:00Z", // 23:30 EST Mar 7 (before spring-forward)
      "2026-03-09T03:30:00Z", // 23:30 EDT Mar 8 (after)
      "2026-11-01T05:30:00Z", // 01:30 EDT/EST Nov 1 (fall-back hour)
      "2026-11-02T04:30:00Z", // 23:30 EST Nov 1
    ]) {
      expect(locationBusinessDate(at, NY)).toBe(businessDate(at, NY.timezone));
    }
    expect(locationBusinessDate("2026-03-08T04:30:00Z", NY)).toBe("2026-03-07");
    expect(locationBusinessDate("2026-03-09T03:30:00Z", NY)).toBe("2026-03-08");
    expect(locationBusinessDate("2026-11-02T04:30:00Z", NY)).toBe("2026-11-01");
  });

  it("applies the business-day cutoff (02:00 local belongs to the day before)", () => {
    const late = { ...NY, business_day_cutoff_minutes: 240 };
    // 02:00 EST Nov 10 = 07:00Z Nov 10.
    expect(locationBusinessDate("2026-11-10T07:00:00Z", late)).toBe("2026-11-09");
    expect(locationBusinessDate("2026-11-10T07:00:00Z", NY)).toBe("2026-11-10");
  });
});

function order(id: string, created_at: string): Order {
  return {
    id,
    tenant_id: "t",
    location_id: "ny",
    channel: "in_store",
    status: "paid",
    currency: "USD",
    items: [],
    totals: {
      subtotal_cents: 1000,
      discount_cents: 0,
      taxable_cents: 1000,
      tax_cents: 0,
      tip_cents: 0,
      total_cents: 1000,
    },
    created_at,
  } as unknown as Order;
}

describe("buildSalesReport buckets by the location's business date", () => {
  const orders = [
    order("eve", "2026-11-10T03:30:00Z"), // Nov 9 22:30 EST
    order("noon", "2026-11-09T17:00:00Z"), // Nov 9 12:00 EST
    order("prev-eve", "2026-11-09T03:30:00Z"), // Nov 8 22:30 EST
    order("dst", "2026-03-09T03:30:00Z"), // Mar 8 23:30 EDT
  ];
  const report = (from: string, clock = true) =>
    buildSalesReport({
      tenantId: "t",
      locationId: "ny",
      range: { from, to: from },
      orders,
      payments: [],
      categoryOf: () => null,
      locationName: () => "NY",
      ...(clock ? { locationClock: () => NY } : {}),
    });

  it("an NY evening order lands on the local day", () => {
    const r = report("2026-11-09");
    expect(r.order_count).toBe(2);
    expect(r.byDay.map((b) => b.key)).toEqual(["2026-11-09"]);
    expect(report("2026-11-10").order_count).toBe(0);
  });

  it("across spring-forward", () => {
    expect(report("2026-03-08").order_count).toBe(1);
    expect(report("2026-03-09").order_count).toBe(0);
  });

  it("without a location clock, falls back to UTC dates", () => {
    expect(report("2026-11-10", false).order_count).toBe(1);
  });
});

const rec = (expected: number): DrawerReconciliation => ({
  opening_float_cents: 0,
  cash_sales_cents: expected,
  paid_in_cents: 0,
  payouts_cents: 0,
  expected_cents: expected,
  counted_cents: expected,
  over_short_cents: 0,
});
const closedShift = (id: string, closed_at: string): Shift => ({
  id,
  tenant_id: "t",
  location_id: "ny",
  staff_id: "s",
  status: "closed",
  opened_at: closed_at,
  closed_at,
  opening_float_cents: 0,
  counted_cents: 0,
  close_note: null,
  created_at: closed_at,
});

describe("eodDrawerSummary uses the location's business date for closed drawers", () => {
  it("a drawer closed 11pm Nov 9 NY counts for Nov 9; last night's does not", () => {
    const d = eodDrawerSummary({
      businessDate: "2026-11-09",
      location: NY,
      shifts: [
        { shift: closedShift("tonight", "2026-11-10T04:00:00Z"), rec: rec(5000) },
        { shift: closedShift("last-night", "2026-11-09T04:00:00Z"), rec: rec(9999) },
      ],
      reportCashCents: 0,
    });
    expect(d.shift_count).toBe(1);
    expect(d.expected_cents).toBe(5000);
  });

  it("across fall-back (Nov 1, 25-hour day)", () => {
    const d = eodDrawerSummary({
      businessDate: "2026-11-01",
      location: NY,
      shifts: [
        { shift: closedShift("late", "2026-11-02T04:30:00Z"), rec: rec(100) }, // 23:30 EST Nov 1
        { shift: closedShift("next", "2026-11-02T05:30:00Z"), rec: rec(200) }, // 00:30 EST Nov 2
      ],
      reportCashCents: 0,
    });
    expect(d.expected_cents).toBe(100);
  });
});

describe("/api/admin/eod on an NY evening (mock driver, demo location is New York)", () => {
  beforeEach(() => {
    resetMockOrders();
    vi.useFakeTimers({ toFake: ["Date"] });
  });
  afterEach(() => vi.useRealTimers());

  it("a drawer closed at 11pm local and an evening order land on the local date, frozen on close", async () => {
    const loc = (await getPosDriver().listLocations(DEMO_TENANT_ID)).find(
      (l) => l.id === DEMO_LOCATION_DOWNTOWN_ID,
    );
    expect(loc?.timezone).toBe("America/New_York");
    const driver = getPosDriver();
    // 23:00 EST Wed Jan 15 2031 = 04:00Z Jan 16.
    vi.setSystemTime(new Date("2031-01-16T04:00:00Z"));
    const staffId = `eod-ny-${Math.random().toString(36).slice(2, 8)}`;
    await driver.upsertStaff({
      id: staffId,
      tenant_id: DEMO_TENANT_ID,
      name: "Closer",
      role: "cashier",
      active: true,
      created_at: new Date().toISOString(),
    });
    const shift = await driver.openShift({
      tenantId: DEMO_TENANT_ID,
      locationId: DEMO_LOCATION_DOWNTOWN_ID,
      staffId,
      openingFloatCents: 10000,
    });
    await driver.closeShift({ shiftId: shift.id, countedCents: 10000 });

    // No date given: today at the location is Jan 15 (UTC is already Jan 16).
    const res = await GET(
      new Request(
        `http://x/api/admin/eod?tenantId=${DEMO_TENANT_ID}&locationId=${DEMO_LOCATION_DOWNTOWN_ID}`,
      ),
    );
    const body = await res.json();
    expect(body.date).toBe("2031-01-15");
    expect(body.drawer.shift_count).toBe(1);
    expect(body.drawer.expected_cents).toBe(10000);

    const closed = await POST(
      new Request("http://x/api/admin/eod", {
        method: "POST",
        body: JSON.stringify({
          tenantId: DEMO_TENANT_ID,
          locationId: DEMO_LOCATION_DOWNTOWN_ID,
          countedCents: 9900,
        }),
      }),
    );
    const c = await closed.json();
    expect(c.close.business_date).toBe("2031-01-15");
    expect(c.close.drawer).toMatchObject({
      shift_count: 1,
      expected_cents: 10000,
      counted_cents: 9900,
      over_short_cents: -100,
    });
  });
});
