/**
 * Printer health for the KDS / Admin banner.
 *
 * GET  ?tenantId=&locationId=  -> { configured, failedCount, lastError, offlinePrinters }
 * POST { tenantId, locationId } -> put failed (unexpired) tickets back in the queue
 *
 * Auth: a kitchen-surface role of the tenant.
 */
import { NextResponse } from "next/server";
import { requireTenantAccess } from "@/lib/auth/tenant-guard";
import { getPosDriver } from "@/lib/db";
import { printHealth, retryFailed } from "@/lib/printing/queue";
import { readJsonBody } from "@/lib/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function status(tenantId: string, locationId: string) {
  const [printers, health] = await Promise.all([
    getPosDriver().listPrinters(tenantId, locationId),
    printHealth(tenantId, locationId),
  ]);
  return { configured: printers.length > 0, ...health };
}

export async function GET(request: Request) {
  const q = new URL(request.url).searchParams;
  const auth = await requireTenantAccess(q.get("tenantId"), "kitchen", {
    locationId: q.get("locationId"),
    requireLocation: true,
  });
  if (!auth.ok) return auth.res;
  return NextResponse.json(await status(auth.tenantId, auth.locationId as string), {
    headers: { "Cache-Control": "no-store" },
  });
}

export async function POST(request: Request) {
  const parsed = await readJsonBody(request);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: parsed.status });
  const b = (parsed.body ?? {}) as Record<string, unknown>;
  const auth = await requireTenantAccess(
    typeof b.tenantId === "string" ? b.tenantId : null,
    "kitchen",
    { locationId: typeof b.locationId === "string" ? b.locationId : null, requireLocation: true },
  );
  if (!auth.ok) return auth.res;
  const retried = await retryFailed(auth.tenantId, auth.locationId as string);
  return NextResponse.json({ retried, ...(await status(auth.tenantId, auth.locationId as string)) });
}
