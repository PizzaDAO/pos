/**
 * End-of-day drawer summary (pure). Shared by the Z-report preview and the
 * close, so the "expected cash" a manager confirms against is exactly what is
 * frozen into the close.
 *
 * - Shifts that CLOSED on the business date (the location's local date, less
 *   its cutoff: `locationBusinessDate`) contribute their reconciliation
 *   (float + cash sales + paid-in − payouts = expected; their own counts).
 * - With no shifts that day (a store not using drawers), expected cash is the
 *   day's cash takings from the sales report.
 * - A count entered at Close day (`countedCents`) replaces the shift counts, and
 *   over/short is recomputed from it.
 * - Drawers still open are counted so the UI can warn (their cash is not in
 *   expected until they are closed).
 */
import type { BusinessDayClose, DrawerReconciliation, Shift } from "@/lib/db";
import {
  locationBusinessDate,
  railFamily,
  type LocationClock,
} from "@/lib/reports";

export type EodDrawer = BusinessDayClose["drawer"];

export function reportCashCents(
  paymentMix: readonly { rail: string; amount_cents: number; tip_cents: number }[],
): number {
  return paymentMix
    .filter((s) => railFamily(s.rail) === "cash")
    .reduce((sum, s) => sum + s.amount_cents + s.tip_cents, 0);
}

export function eodDrawerSummary(input: {
  businessDate: string;
  /** The location's time zone + cutoff (business dates are local to it). */
  location?: LocationClock | null;
  shifts: readonly { shift: Shift; rec: DrawerReconciliation }[];
  /** The day's cash takings (from the sales report), used with no shifts. */
  reportCashCents: number;
  /** Cash counted at Close day; omitted = use the shifts' own counts. */
  countedCents?: number;
}): EodDrawer {
  const day = input.shifts.filter(
    ({ shift }) =>
      shift.status === "closed" &&
      shift.closed_at != null &&
      locationBusinessDate(shift.closed_at, input.location) === input.businessDate,
  );
  const openDrawers = input.shifts.filter(({ shift }) => shift.status !== "closed").length;
  let opening = 0;
  let cashSales = 0;
  let expected = 0;
  let counted = 0;
  for (const { rec } of day) {
    opening += rec.opening_float_cents;
    cashSales += rec.cash_sales_cents;
    expected += rec.expected_cents;
    counted += rec.counted_cents ?? rec.expected_cents;
  }
  const fromSales = day.length === 0;
  if (fromSales) {
    cashSales = input.reportCashCents;
    expected = input.reportCashCents;
    counted = expected;
  }
  const countedAtClose = input.countedCents !== undefined;
  if (countedAtClose) counted = input.countedCents!;
  return {
    opening_float_cents: opening,
    cash_sales_cents: cashSales,
    expected_cents: expected,
    counted_cents: counted,
    over_short_cents: counted - expected,
    shift_count: day.length,
    open_drawer_count: openDrawers,
    expected_source: fromSales ? "sales" : "shifts",
    counted_at_close: countedAtClose,
  };
}
