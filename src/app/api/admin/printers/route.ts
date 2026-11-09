/**
 * Network kitchen printers for a location (Admin > Printers).
 *
 * GET    ?tenantId=&locationId=  -> { printers, autoPrint, jobs }
 * POST   { tenantId, locationId, label, protocol, format?, columns? }
 *        -> 201 { printer, token, setupUrl }  (the token is shown ONCE)
 * PATCH  { tenantId, locationId, autoPrint }  -> per-location auto-print (default off)
 * DELETE ?tenantId=&locationId=&printerId=    -> remove a printer (revokes its token)
 *
 * Auth: owner | manager. Tokens are stored hashed; the printers themselves talk
 * to /api/print/{star,epson}/<token>.
 */
import { NextResponse } from "next/server";
import { getPosDriver } from "@/lib/db";
import { authorizeAdminLocation } from "@/lib/payments/terminal/http";
import { createPrinter, printHealth, publicOrigin } from "@/lib/printing/queue";
import { publicJob, publicPrinter, setupUrl } from "@/lib/printing/public";
import type { PrinterFormat, PrinterProtocol } from "@/lib/printing/types";
import { enforceRateLimit, readJsonBody } from "@/lib/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_PRINTERS_PER_LOCATION = 5;

async function body(tenantId: string, locationId: string) {
  const driver = getPosDriver();
  const [printers, settings, jobs] = await Promise.all([
    driver.listPrinters(tenantId, locationId),
    driver.getPrintSettings(locationId),
    driver.listPrintJobs(tenantId, locationId, 10),
  ]);
  return {
    printers: printers.map(publicPrinter),
    autoPrint: settings?.auto_print ?? false,
    jobs: jobs.map(publicJob),
    health: await printHealth(tenantId, locationId),
  };
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const auth = await authorizeAdminLocation(
    request,
    searchParams.get("tenantId"),
    searchParams.get("locationId"),
  );
  if (!auth.ok) return auth.res;
  return NextResponse.json(await body(auth.tenantId, auth.location.id), {
    headers: { "Cache-Control": "no-store" },
  });
}

export async function POST(request: Request) {
  const limited = enforceRateLimit(request, "payments");
  if (limited) return limited;
  const parsed = await readJsonBody(request);
  if (!parsed.ok)
    return NextResponse.json(
      { error: parsed.error },
      { status: parsed.status },
    );
  const b = (parsed.body ?? {}) as Record<string, unknown>;
  const auth = await authorizeAdminLocation(request, b.tenantId, b.locationId);
  if (!auth.ok) return auth.res;

  const protocol = b.protocol;
  if (protocol !== "star_cloudprnt" && protocol !== "epson_sdp") {
    return NextResponse.json(
      { error: "protocol must be star_cloudprnt or epson_sdp." },
      { status: 422 },
    );
  }
  const columns = b.columns === undefined ? 42 : b.columns;
  if (columns !== 42 && columns !== 48) {
    return NextResponse.json(
      { error: "columns must be 42 or 48." },
      { status: 422 },
    );
  }
  const format = b.format === undefined ? "markup" : b.format;
  if (format !== "markup" && format !== "text") {
    return NextResponse.json(
      { error: "format must be markup or text." },
      { status: 422 },
    );
  }
  const label = typeof b.label === "string" ? b.label.trim() : "";
  if (!label)
    return NextResponse.json(
      { error: "A printer name is required." },
      { status: 422 },
    );

  const existing = await getPosDriver().listPrinters(
    auth.tenantId,
    auth.location.id,
  );
  if (existing.length >= MAX_PRINTERS_PER_LOCATION) {
    return NextResponse.json(
      {
        error: `A location can have at most ${MAX_PRINTERS_PER_LOCATION} printers.`,
      },
      { status: 409 },
    );
  }

  const { printer, token } = await createPrinter({
    tenantId: auth.tenantId,
    locationId: auth.location.id,
    label,
    protocol: protocol as PrinterProtocol,
    format: format as PrinterFormat,
    columns,
  });
  return NextResponse.json(
    {
      printer: publicPrinter(printer),
      token,
      setupUrl: setupUrl(publicOrigin(request.url), printer.protocol, token),
    },
    { status: 201, headers: { "Cache-Control": "no-store" } },
  );
}

export async function PATCH(request: Request) {
  const parsed = await readJsonBody(request);
  if (!parsed.ok)
    return NextResponse.json(
      { error: parsed.error },
      { status: parsed.status },
    );
  const b = (parsed.body ?? {}) as Record<string, unknown>;
  const auth = await authorizeAdminLocation(request, b.tenantId, b.locationId);
  if (!auth.ok) return auth.res;
  if (typeof b.autoPrint !== "boolean") {
    return NextResponse.json(
      { error: "autoPrint must be a boolean." },
      { status: 422 },
    );
  }
  await getPosDriver().setPrintAutoPrint(
    auth.tenantId,
    auth.location.id,
    b.autoPrint,
  );
  return NextResponse.json(await body(auth.tenantId, auth.location.id));
}

export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url);
  const auth = await authorizeAdminLocation(
    request,
    searchParams.get("tenantId"),
    searchParams.get("locationId"),
  );
  if (!auth.ok) return auth.res;
  const printerId = searchParams.get("printerId") ?? "";
  const driver = getPosDriver();
  // Must be a printer of THIS location (not just this tenant).
  const printer = await driver.getPrinter(printerId).catch(() => null);
  if (
    !printer ||
    printer.tenant_id !== auth.tenantId ||
    printer.location_id !== auth.location.id
  ) {
    return NextResponse.json({ error: "Printer not found." }, { status: 404 });
  }
  await driver.deletePrinter(auth.tenantId, printer.id);
  return NextResponse.json(await body(auth.tenantId, auth.location.id));
}
