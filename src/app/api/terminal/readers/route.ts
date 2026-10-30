/**
 * GET /api/terminal/readers?tenantId=&locationId=
 *
 * The card-reader list for the till: this location's registered readers merged
 * with their live online/offline status, plus the card gate. Returns
 * `{ mode, ready, notReadyReason, readers, tipMode }`. `ready` is true only when the
 * tenant has a charges-enabled connected account AND at least one registered
 * reader (always true in simulated mode, which has one virtual reader).
 *
 * Auth: owner | manager | cashier of the tenant; the location must be the
 * tenant's.
 */
import { NextResponse } from "next/server";
import { getPosDriver } from "@/lib/db";
import { DEFAULT_TIP_MODE } from "@/lib/payments/terminal/locations";
import { enforceRateLimit } from "@/lib/security";
import { getCardReadiness } from "@/lib/payments/terminal/readers";
import {
  TILL_ROLES,
  authorizeLocation,
  errorResponse,
} from "@/lib/payments/terminal/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const limited = enforceRateLimit(request, "cardSync");
  if (limited) return limited;
  const { searchParams } = new URL(request.url);
  const auth = await authorizeLocation(
    searchParams.get("tenantId"),
    searchParams.get("locationId"),
    TILL_ROLES,
  );
  if (!auth.ok) return auth.res;
  try {
    const [readiness, row] = await Promise.all([
      getCardReadiness(auth.tenantId, auth.location.id),
      getPosDriver().getTerminalLocation(auth.location.id),
    ]);
    // `tipMode` lets the till hide its own tip selector when the reader tips.
    return NextResponse.json(
      { ...readiness, tipMode: row?.tip_mode ?? DEFAULT_TIP_MODE },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return errorResponse(err, "Could not load card readers.");
  }
}
