/**
 * POST { tenantId, locationId, printerId } -> rotate a printer's token. The old
 * setup URL stops working at once; the new one is returned ONCE. Owner | manager.
 */
import { NextResponse } from "next/server";
import { getPosDriver } from "@/lib/db";
import { ADMIN_ROLES, authorizeLocation } from "@/lib/payments/terminal/http";
import { publicOrigin, rotatePrinterToken } from "@/lib/printing/queue";
import { publicPrinter, setupUrl } from "@/lib/printing/public";
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
  const existing =
    typeof b.printerId === "string"
      ? await getPosDriver().getPrinter(b.printerId).catch(() => null)
      : null;
  if (!existing || existing.tenant_id !== auth.tenantId || existing.location_id !== auth.location.id) {
    return NextResponse.json({ error: "Printer not found." }, { status: 404 });
  }
  const rotated = await rotatePrinterToken(auth.tenantId, existing.id);
  if (!rotated) return NextResponse.json({ error: "Printer not found." }, { status: 404 });
  return NextResponse.json(
    {
      printer: publicPrinter(rotated.printer),
      token: rotated.token,
      setupUrl: setupUrl(publicOrigin(request.url), rotated.printer.protocol, rotated.token),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
