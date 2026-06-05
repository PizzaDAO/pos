/**
 * Drawer reconciliation + end-of-day (Z-report) tests against the mock driver.
 *
 * Over/short = counted − expected, where expected = float + cash sales + paid-in
 * − payouts. Closing a business day is idempotent: re-closing returns the frozen
 * snapshot rather than recomputing.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  getPosDriver,
  DEMO_TENANT_ID,
  DEMO_LOCATION_DOWNTOWN_ID,
} from "@/lib/db";
import { resetMockOrders } from "@/lib/db/mock";

const STAFF = "80000000-0000-0000-0000-000000000001";

beforeEach(() => resetMockOrders());

async function openShiftWithEvents(float: number) {
  const driver = getPosDriver();
  const staffId = `${STAFF}-${Math.random().toString(36).slice(2, 8)}`;
  // Ensure the staff row exists (unique per test to avoid an already-open shift).
  await driver.upsertStaff({
    id: staffId,
    tenant_id: DEMO_TENANT_ID,
    name: "Cashier",
    role: "cashier",
    active: true,
    created_at: new Date().toISOString(),
  });
  const shift = await driver.openShift({
    tenantId: DEMO_TENANT_ID,
    locationId: DEMO_LOCATION_DOWNTOWN_ID,
    staffId,
    openingFloatCents: float,
  });
  return shift;
}

describe("drawer reconciliation over/short math", () => {
  it("computes expected = float + sales + paid_in − payouts and over/short", async () => {
    const driver = getPosDriver();
    const shift = await openShiftWithEvents(10000); // $100 float

    const ev = (type: "sale" | "paid_in" | "payout", amount: number) =>
      driver.addShiftCashEvent({
        id: "",
        shift_id: shift.id,
        tenant_id: DEMO_TENANT_ID,
        location_id: DEMO_LOCATION_DOWNTOWN_ID,
        type,
        amount_cents: amount,
        order_id: null,
        note: null,
        created_at: new Date().toISOString(),
      });

    await ev("sale", 5000); // +$50 cash sales
    await ev("paid_in", 2000); // +$20 paid in
    await ev("payout", -1500); // −$15 payout (stored signed)

    // expected = 10000 + 5000 + 2000 − 1500 = 15500
    const recBefore = await driver.getDrawerReconciliation(shift.id);
    expect(recBefore.expected_cents).toBe(15500);
    expect(recBefore.over_short_cents).toBeNull(); // not counted yet

    // Close counting $156.00 → over by $1.00.
    await driver.closeShift({ shiftId: shift.id, countedCents: 15600 });
    const rec = await driver.getDrawerReconciliation(shift.id);
    expect(rec.counted_cents).toBe(15600);
    expect(rec.over_short_cents).toBe(100);
  });

  it("reports a shortage as a negative over/short", async () => {
    const driver = getPosDriver();
    const shift = await openShiftWithEvents(10000);
    await driver.addShiftCashEvent({
      id: "",
      shift_id: shift.id,
      tenant_id: DEMO_TENANT_ID,
      location_id: DEMO_LOCATION_DOWNTOWN_ID,
      type: "sale",
      amount_cents: 5000,
      order_id: null,
      note: null,
      created_at: new Date().toISOString(),
    });
    // expected 15000, count 14900 → short $1.
    await driver.closeShift({ shiftId: shift.id, countedCents: 14900 });
    const rec = await driver.getDrawerReconciliation(shift.id);
    expect(rec.over_short_cents).toBe(-100);
  });
});

describe("end-of-day Z-report — idempotent close", () => {
  it("returns the SAME frozen snapshot when a business day is re-closed", async () => {
    const driver = getPosDriver();
    const day = "2026-06-04";
    const first = await driver.closeBusinessDay(
      DEMO_TENANT_ID,
      DEMO_LOCATION_DOWNTOWN_ID,
      day,
    );
    const second = await driver.closeBusinessDay(
      DEMO_TENANT_ID,
      DEMO_LOCATION_DOWNTOWN_ID,
      day,
    );
    expect(second.id).toBe(first.id);
    expect(second.closed_at).toBe(first.closed_at);
    expect(second.report).toEqual(first.report);
  });

  it("getBusinessDayClose returns null before a close and the snapshot after", async () => {
    const driver = getPosDriver();
    const day = "2026-06-05";
    expect(
      await driver.getBusinessDayClose(
        DEMO_TENANT_ID,
        DEMO_LOCATION_DOWNTOWN_ID,
        day,
      ),
    ).toBeNull();
    const close = await driver.closeBusinessDay(
      DEMO_TENANT_ID,
      DEMO_LOCATION_DOWNTOWN_ID,
      day,
    );
    const fetched = await driver.getBusinessDayClose(
      DEMO_TENANT_ID,
      DEMO_LOCATION_DOWNTOWN_ID,
      day,
    );
    expect(fetched?.id).toBe(close.id);
  });
});
