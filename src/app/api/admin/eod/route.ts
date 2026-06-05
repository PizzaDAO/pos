/**
 * End-of-day (Z-report) — /api/admin/eod (Phase 5).
 *
 * GET  ?tenantId=&locationId=&date=  → the existing close for a business day,
 *      or a LIVE (un-frozen) snapshot if the day hasn't been closed yet.
 * POST { tenantId, locationId, date } → idempotently CLOSE the business day.
 *      Re-closing the same (location, date) returns the frozen snapshot.
 *
 * `date` is "yyyy-mm-dd" (location-tz business date). No env vars; mock driver.
 */
import { NextResponse } from "next/server";
import { getPosDriver } from "@/lib/db";

export const runtime = "nodejs";

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const tenantId = searchParams.get("tenantId");
  const locationId = searchParams.get("locationId");
  const date = searchParams.get("date") ?? todayIso();
  if (!tenantId || !locationId) {
    return NextResponse.json(
      { error: "tenantId and locationId are required." },
      { status: 400 },
    );
  }
  const driver = getPosDriver();
  const close = await driver.getBusinessDayClose(tenantId, locationId, date);
  if (close) return NextResponse.json({ close, closed: true });

  // Not closed yet — return a live preview report for the day so the UI can
  // show what WILL be frozen on close.
  const report = await driver.getSalesReport(tenantId, locationId, {
    from: date,
    to: date,
  });
  return NextResponse.json({ close: null, closed: false, report });
}

export async function POST(request: Request) {
  let body: { tenantId?: string; locationId?: string; date?: string };
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
  const date = body.date ?? todayIso();
  const close = await getPosDriver().closeBusinessDay(
    body.tenantId,
    body.locationId,
    date,
  );
  return NextResponse.json({ close, closed: true }, { status: 201 });
}
