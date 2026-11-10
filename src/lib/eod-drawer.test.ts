import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  getPosDriver,
  DEMO_TENANT_ID,
  DEMO_LOCATION_DOWNTOWN_ID,
  type DrawerReconciliation,
  type Shift,
} from "@/lib/db";
import { resetMockOrders } from "@/lib/db/mock";
import { eodDrawerSummary, reportCashCents } from "./eod-drawer";
import { todayInZone } from "@/app/(admin)/admin/components/end-of-day";

vi.mock("@/lib/auth/tenant-guard", () => ({
  requireTenantAccess: async (tenantId: string, _s: string, o?: { locationId?: string }) => ({
    ok: true,
    tenantId,
    locationId: o?.locationId ?? null,
    user: { id: "u1", email: "m@x" },
  }),
}));

import { GET, POST } from "@/app/api/admin/eod/route";

function shift(over: Partial<Shift>): Shift {
  return {
    id: "s",
    tenant_id: "t",
    location_id: "l",
    staff_id: "x",
    status: "closed",
    opened_at: "2026-11-09T14:00:00Z",
    closed_at: "2026-11-09T22:00:00Z",
    opening_float_cents: 10000,
    counted_cents: 15000,
    close_note: null,
    created_at: "2026-11-09T14:00:00Z",
    ...over,
  };
}
function rec(expected: number, counted: number | null): DrawerReconciliation {
  return {
    opening_float_cents: 10000,
    cash_sales_cents: expected - 10000,
    paid_in_cents: 0,
    payouts_cents: 0,
    expected_cents: expected,
    counted_cents: counted,
    over_short_cents: counted === null ? null : counted - expected,
  };
}

describe("eodDrawerSummary", () => {
  it("sums closed shifts for the day, flags open drawers", () => {
    const d = eodDrawerSummary({
      businessDate: "2026-11-09",
      shifts: [
        { shift: shift({ id: "a" }), rec: rec(15000, 14900) },
        { shift: shift({ id: "b", closed_at: "2026-11-08T22:00:00Z" }), rec: rec(99999, 0) },
        { shift: shift({ id: "c", status: "open", closed_at: null }), rec: rec(12000, null) },
      ],
      reportCashCents: 5000,
    });
    expect(d).toMatchObject({
      expected_cents: 15000,
      counted_cents: 14900,
      over_short_cents: -100,
      shift_count: 1,
      open_drawer_count: 1,
      expected_source: "shifts",
      counted_at_close: false,
    });
  });

  it("a count at close replaces shift counts; no shifts uses cash sales", () => {
    const d = eodDrawerSummary({
      businessDate: "2026-11-09",
      shifts: [],
      reportCashCents: 7843,
      countedCents: 7800,
    });
    expect(d).toMatchObject({
      expected_cents: 7843,
      counted_cents: 7800,
      over_short_cents: -43,
      expected_source: "sales",
      counted_at_close: true,
    });
  });

  it("reportCashCents takes cash rails with tips only", () => {
    expect(
      reportCashCents([
        { rail: "cash", amount_cents: 1000, tip_cents: 100 },
        { rail: "stripe_terminal", amount_cents: 5000, tip_cents: 0 },
      ]),
    ).toBe(1100);
  });
});

describe("todayInZone", () => {
  it("uses the location's zone, not UTC", () => {
    // 01:30 UTC on Nov 10 is still Nov 9 in New York.
    const at = new Date("2026-11-10T01:30:00Z");
    expect(todayInZone("America/New_York", at)).toBe("2026-11-09");
    expect(todayInZone(undefined, at)).toBe("2026-11-10");
    expect(todayInZone("Not/AZone", at)).toBe("2026-11-10");
  });
});

describe("/api/admin/eod", () => {
  beforeEach(() => resetMockOrders());
  const DAY = "2031-01-15";

  it("rejects a malformed date with 400 (not a 500)", async () => {
    for (const bad of ["garbage", "2026-02-31", "2026-11-09T00:00:00Z"]) {
      const g = await GET(
        new Request(
          `http://x/api/admin/eod?tenantId=${DEMO_TENANT_ID}&locationId=${DEMO_LOCATION_DOWNTOWN_ID}&date=${encodeURIComponent(bad)}`,
        ),
      );
      expect(g.status).toBe(400);
      const p = await POST(
        new Request("http://x/api/admin/eod", {
          method: "POST",
          body: JSON.stringify({ tenantId: DEMO_TENANT_ID, locationId: DEMO_LOCATION_DOWNTOWN_ID, date: bad }),
        }),
      );
      expect(p.status).toBe(400);
    }
  });

  it("GET previews the drawer; POST freezes the counted cash and over/short", async () => {
    const pre = await GET(
      new Request(
        `http://x/api/admin/eod?tenantId=${DEMO_TENANT_ID}&locationId=${DEMO_LOCATION_DOWNTOWN_ID}&date=${DAY}`,
      ),
    );
    const preBody = await pre.json();
    expect(preBody.closed).toBe(false);
    expect(preBody.drawer).toBeTruthy();
    const expected = preBody.drawer.expected_cents as number;

    const res = await POST(
      new Request("http://x/api/admin/eod", {
        method: "POST",
        body: JSON.stringify({
          tenantId: DEMO_TENANT_ID,
          locationId: DEMO_LOCATION_DOWNTOWN_ID,
          date: DAY,
          countedCents: expected + 250,
        }),
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.close.drawer).toMatchObject({
      counted_cents: expected + 250,
      over_short_cents: 250,
      counted_at_close: true,
    });
    const stored = await getPosDriver().getBusinessDayClose(
      DEMO_TENANT_ID,
      DEMO_LOCATION_DOWNTOWN_ID,
      DAY,
    );
    expect(stored?.drawer.counted_cents).toBe(expected + 250);
  });

  it("rejects a bad count", async () => {
    const res = await POST(
      new Request("http://x/api/admin/eod", {
        method: "POST",
        body: JSON.stringify({
          tenantId: DEMO_TENANT_ID,
          locationId: DEMO_LOCATION_DOWNTOWN_ID,
          date: "2031-01-16",
          countedCents: -5,
        }),
      }),
    );
    expect(res.status).toBe(422);
  });
});
