/**
 * End-of-day (Z-report) — /api/admin/eod (Phase 5).
 *
 * GET  ?tenantId=&locationId=&date=  → the existing close for a business day,
 *      or a LIVE (un-frozen) snapshot if the day hasn't been closed yet.
 *      Both include a `drawer` summary (lib/eod-drawer): expected cash, counts,
 *      over/short and how many drawers are still open.
 * POST { tenantId, locationId, date, countedCents? } → idempotently CLOSE the
 *      business day. `countedCents` (the cash counted at close) is frozen into
 *      the drawer summary with its over/short. Re-closing the same (location,
 *      date) returns the frozen snapshot.
 *
 * `date` is "yyyy-mm-dd" (location-tz business date; when omitted, today in the
 * location's time zone). No env vars; mock driver.
 *
 * Auth: owner|manager of the tenant; the location must belong to it.
 */
import { NextResponse } from "next/server";
import { businessDate } from "@openpizza/core";
import { getPosDriver, type SalesReport } from "@/lib/db";
import { requireTenantAccess } from "@/lib/auth/tenant-guard";
import { eodDrawerSummary, reportCashCents } from "@/lib/eod-drawer";
import { isMoneyCents } from "@/lib/security";

export const runtime = "nodejs";

/** Today's business date in the location's time zone (UTC if unknown). */
async function todayAt(tenantId: string, locationId: string): Promise<string> {
  const loc = (await getPosDriver().listLocations(tenantId)).find(
    (l) => l.id === locationId,
  );
  try {
    return businessDate(new Date(), loc?.timezone || "UTC");
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

/** The day's drawer summary (closed shifts' reconciliations, or cash sales). */
async function drawerFor(
  tenantId: string,
  locationId: string,
  date: string,
  report: SalesReport,
  countedCents?: number,
) {
  const driver = getPosDriver();
  const shifts = await driver.listShifts(tenantId, locationId);
  const relevant = shifts.filter(
    (s) => s.status !== "closed" || (s.closed_at ?? "").slice(0, 10) === date,
  );
  const withRecs = await Promise.all(
    relevant.map(async (shift) => ({
      shift,
      rec: await driver.getDrawerReconciliation(shift.id),
    })),
  );
  return eodDrawerSummary({
    businessDate: date,
    shifts: withRecs,
    reportCashCents: reportCashCents(report.paymentMix),
    countedCents,
  });
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const auth = await requireTenantAccess(searchParams.get("tenantId"), "admin", {
    locationId: searchParams.get("locationId"),
    requireLocation: true,
  });
  if (!auth.ok) return auth.res;
  const tenantId = auth.tenantId;
  const locationId = auth.locationId as string;
  const driver = getPosDriver();
  const date = searchParams.get("date") ?? (await todayAt(tenantId, locationId));
  const close = await driver.getBusinessDayClose(tenantId, locationId, date);
  if (close) return NextResponse.json({ close, closed: true });

  // Not closed yet — return a live preview report for the day so the UI can
  // show what WILL be frozen on close.
  const report = await driver.getSalesReport(tenantId, locationId, {
    from: date,
    to: date,
  });
  const drawer = await drawerFor(tenantId, locationId, date, report);
  return NextResponse.json({ close: null, closed: false, report, drawer, date });
}

export async function POST(request: Request) {
  let body: {
    tenantId?: string;
    locationId?: string;
    date?: string;
    countedCents?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (!body.tenantId || !body.locationId) {
    return NextResponse.json(
      { error: "tenantId and locationId are required." },
      { status: 422 },
    );
  }
  const auth = await requireTenantAccess(body.tenantId, "admin", {
    locationId: body.locationId,
    requireLocation: true,
  });
  if (!auth.ok) return auth.res;
  if (body.countedCents !== undefined && !isMoneyCents(body.countedCents)) {
    return NextResponse.json(
      { error: "countedCents must be non-negative integer cents." },
      { status: 422 },
    );
  }
  const driver = getPosDriver();
  const date = body.date ?? (await todayAt(body.tenantId, body.locationId));
  const existing = await driver.getBusinessDayClose(
    body.tenantId,
    body.locationId,
    date,
  );
  if (existing) {
    return NextResponse.json({ close: existing, closed: true }, { status: 201 });
  }
  const report = await driver.getSalesReport(body.tenantId, body.locationId, {
    from: date,
    to: date,
  });
  const drawer = await drawerFor(
    body.tenantId,
    body.locationId,
    date,
    report,
    body.countedCents as number | undefined,
  );
  const close = await driver.closeBusinessDay(
    body.tenantId,
    body.locationId,
    date,
    { drawer },
  );
  return NextResponse.json({ close, closed: true }, { status: 201 });
}
