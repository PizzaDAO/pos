/**
 * Owner reports — /api/admin/reports/owner.
 *
 * GET ?tenantId=&locationId=&from=&to=[&compare=1][&topN=]
 *   → JSON { range, previous, summary, previousSummary, deltas, bundle,
 *            previousBundle, timezones } for inclusive BUSINESS dates.
 * GET …&report=<kind>&format=csv
 *   → one report as CSV (summary | channels | tenders | hourly | items |
 *     categories | staff | accountant). The accountant export is one row per
 *     location per business day.
 *
 * Aggregation runs in SQL (report_sales_bundle) per location timezone and
 * business-day cutoff. Auth: owner|manager of the tenant (session-derived);
 * locationId must belong to it. Ranges are capped at 366 days.
 */
import { NextResponse } from "next/server";
import { getPosDriver } from "@/lib/db";
import { requireTenantAccess } from "@/lib/auth/tenant-guard";
import { railLabel } from "@/lib/reports";
import {
  REPORT_KINDS,
  bundleToCsv,
  compareSummaries,
  previousRange,
  rangeError,
  summarize,
  type OwnerReportKind,
} from "@/lib/owner-reports";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const locationParam = searchParams.get("locationId");
  const auth = await requireTenantAccess(searchParams.get("tenantId"), "admin", {
    locationId: !locationParam || locationParam === "all" ? null : locationParam,
  });
  if (!auth.ok) return auth.res;
  const { tenantId, locationId } = auth;

  const from = searchParams.get("from");
  const to = searchParams.get("to");
  const bad = rangeError(from, to);
  if (bad || !from || !to) return NextResponse.json({ error: bad }, { status: 422 });

  const topNRaw = Number(searchParams.get("topN") ?? 50);
  const topN = Number.isFinite(topNRaw) ? Math.min(Math.max(Math.trunc(topNRaw), 1), 200) : 50;

  const driver = getPosDriver();
  const bundle = await driver.getOwnerReportBundle(tenantId, locationId, from, to, topN);

  if (searchParams.get("format") === "csv") {
    const kind = searchParams.get("report") as OwnerReportKind | null;
    if (!kind || !REPORT_KINDS.includes(kind)) {
      return NextResponse.json(
        { error: `report must be one of ${REPORT_KINDS.join(", ")}.` },
        { status: 422 },
      );
    }
    const csv = bundleToCsv(kind, bundle, railLabel);
    return new NextResponse(csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${kind}-${from}_${to}.csv"`,
        "cache-control": "no-store",
      },
    });
  }

  const summary = summarize(bundle.daily);
  let previous: { from: string; to: string } | null = null;
  let previousBundle = null;
  let previousSummary = null;
  let deltas = null;
  if (searchParams.get("compare") === "1") {
    previous = previousRange(from, to);
    previousBundle = await driver.getOwnerReportBundle(tenantId, locationId, previous.from, previous.to, topN);
    previousSummary = summarize(previousBundle.daily);
    deltas = compareSummaries(summary, previousSummary);
  }

  const locations = await driver.listLocations(tenantId);
  return NextResponse.json({
    range: { from, to },
    previous,
    summary,
    previousSummary,
    deltas,
    bundle,
    previousBundle,
    locations: locations.map((l) => ({
      id: l.id,
      name: l.name,
      timezone: l.timezone,
      business_day_cutoff_minutes: l.business_day_cutoff_minutes ?? 0,
    })),
  });
}
