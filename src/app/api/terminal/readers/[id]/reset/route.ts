/**
 * POST /api/terminal/readers/[id]/reset  { tenantId, locationId }
 *
 * "Reset reader": cancel whatever the reader is doing (`cancel_action`). For a
 * reader stuck `in_progress` after a dropped payment; the cashier then re-syncs
 * the tender (the PaymentIntent stays the source of truth, so no double charge).
 * Auth: owner | manager | cashier.
 */
import { NextResponse } from "next/server";
import { enforceRateLimit, readJsonBody } from "@/lib/security";
import { resetReader } from "@/lib/payments/terminal/flow";
import {
  TILL_ROLES,
  authorizeLocation,
  errorResponse,
} from "@/lib/payments/terminal/http";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const limited = enforceRateLimit(request, "payments");
  if (limited) return limited;
  const parsed = await readJsonBody(request);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: parsed.status });
  const body = (parsed.body ?? {}) as { tenantId?: unknown; locationId?: unknown };
  const auth = await authorizeLocation(body.tenantId, body.locationId, TILL_ROLES);
  if (!auth.ok) return auth.res;
  const { id } = await ctx.params;
  try {
    await resetReader({ tenantId: auth.tenantId, locationId: auth.location.id, readerId: id });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err, "Could not reset the reader.");
  }
}
