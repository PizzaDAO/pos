/**
 * POST /api/admin/terminal/readers
 *   { tenantId, locationId, registrationCode, label }
 *
 * Register a card reader by the pairing code it shows (S700: Settings >
 * Generate pairing code). Runs `POST /v1/terminal/readers` on the tenant's
 * connected account against this location's Terminal Location (which needs the
 * saved address), then stores the reader. Test mode also accepts
 * `simulated-wpe` for a simulated reader. Auth: owner | manager.
 */
import { NextResponse } from "next/server";
import { registerTerminalReader } from "@/lib/payments/terminal/readers";
import {
  ADMIN_ROLES,
  authorizeLocation,
  errorResponse,
} from "@/lib/payments/terminal/http";
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
  if (typeof b.registrationCode !== "string" || !b.registrationCode.trim()) {
    return NextResponse.json({ error: "registrationCode is required." }, { status: 422 });
  }
  try {
    const reader = await registerTerminalReader({
      tenantId: auth.tenantId,
      locationId: auth.location.id,
      registrationCode: b.registrationCode,
      label: typeof b.label === "string" ? b.label : "",
    });
    return NextResponse.json(
      {
        reader: {
          id: reader.id,
          label: reader.label,
          deviceType: reader.device_type,
          serialNumber: reader.serial_number,
        },
      },
      { status: 201 },
    );
  } catch (err) {
    return errorResponse(err, "Could not register the reader.");
  }
}
