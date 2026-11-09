/**
 * POST { tenantId, locationId, printerId } -> queue a "Print test ticket" job on
 * that printer. Owner | manager. The printer prints it on its next poll.
 */
import { NextResponse } from "next/server";
import { getPosDriver } from "@/lib/db";
import { ADMIN_ROLES, authorizeLocation } from "@/lib/payments/terminal/http";
import { enqueueTestTicket } from "@/lib/printing/queue";
import { publicJob } from "@/lib/printing/public";
import { enforceRateLimit, readJsonBody } from "@/lib/security";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const limited = enforceRateLimit(request, "payments");
  if (limited) return limited;
  const parsed = await readJsonBody(request);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: parsed.status });
  const b = (parsed.body ?? {}) as Record<string, unknown>;
  const auth = await authorizeLocation(b.tenantId, b.locationId, ADMIN_ROLES);
  if (!auth.ok) return auth.res;
  const printer =
    typeof b.printerId === "string"
      ? await getPosDriver().getPrinter(b.printerId).catch(() => null)
      : null;
  if (
    !printer ||
    printer.tenant_id !== auth.tenantId ||
    printer.location_id !== auth.location.id
  ) {
    return NextResponse.json({ error: "Printer not found." }, { status: 404 });
  }
  const job = await enqueueTestTicket(printer);
  return NextResponse.json({ job: publicJob(job) }, { status: 201 });
}
