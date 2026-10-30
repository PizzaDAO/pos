/**
 * Card-reader setup for a location (Admin > Payments > Card readers).
 *
 * GET ?tenantId=&locationId= -> { mode, tipMode, address, readers, ready,
 *   notReadyReason }: the terminal setup + registered readers (with live status).
 * PUT { tenantId, locationId, address?, tipMode? } -> saves the structured
 *   address and/or tip mode, and (re)creates the Stripe Terminal Location +
 *   tipping Configuration on the tenant's connected account.
 *
 * Auth: owner | manager of the tenant. Reader pairing is in ./readers.
 */
import { NextResponse } from "next/server";
import { getPosDriver } from "@/lib/db";
import type { TerminalTipMode } from "@/lib/db/payment-types";
import {
  DEFAULT_TIP_MODE,
  ensureTerminalLocation,
  isTerminalTipMode,
  parseTerminalAddress,
} from "@/lib/payments/terminal/locations";
import { getCardReadiness } from "@/lib/payments/terminal/readers";
import {
  ADMIN_ROLES,
  authorizeLocation,
  errorResponse,
} from "@/lib/payments/terminal/http";
import { enforceRateLimit, readJsonBody } from "@/lib/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function setupBody(tenantId: string, locationId: string) {
  const [row, readiness] = await Promise.all([
    getPosDriver().getTerminalLocation(locationId),
    getCardReadiness(tenantId, locationId),
  ]);
  return {
    mode: readiness.mode,
    tipMode: row?.tip_mode ?? DEFAULT_TIP_MODE,
    address: row?.address ?? null,
    hasTerminalLocation: !!row?.stripe_location_id,
    ready: readiness.ready,
    notReadyReason: readiness.notReadyReason,
    readers: readiness.readers,
  };
}

export async function GET(request: Request) {
  const limited = enforceRateLimit(request, "payments");
  if (limited) return limited;
  const { searchParams } = new URL(request.url);
  const auth = await authorizeLocation(
    searchParams.get("tenantId"),
    searchParams.get("locationId"),
    ADMIN_ROLES,
  );
  if (!auth.ok) return auth.res;
  try {
    return NextResponse.json(await setupBody(auth.tenantId, auth.location.id), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    return errorResponse(err, "Could not load card reader setup.");
  }
}

export async function PUT(request: Request) {
  const limited = enforceRateLimit(request, "payments");
  if (limited) return limited;
  const parsed = await readJsonBody(request);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: parsed.status });
  const b = (parsed.body ?? {}) as Record<string, unknown>;
  const auth = await authorizeLocation(b.tenantId, b.locationId, ADMIN_ROLES);
  if (!auth.ok) return auth.res;

  let address;
  if (b.address !== undefined) {
    const a = parseTerminalAddress(b.address);
    if (!a.ok) return NextResponse.json({ error: a.error }, { status: 422 });
    address = a.address;
  }
  if (b.tipMode !== undefined && !isTerminalTipMode(b.tipMode)) {
    return NextResponse.json({ error: "tipMode must be reader, pos or none." }, { status: 422 });
  }
  if (address === undefined && b.tipMode === undefined) {
    return NextResponse.json({ error: "Nothing to update." }, { status: 422 });
  }
  try {
    await ensureTerminalLocation({
      tenantId: auth.tenantId,
      locationId: auth.location.id,
      address,
      tipMode: b.tipMode as TerminalTipMode | undefined,
    });
    return NextResponse.json(await setupBody(auth.tenantId, auth.location.id));
  } catch (err) {
    return errorResponse(err, "Could not save card reader setup.");
  }
}
