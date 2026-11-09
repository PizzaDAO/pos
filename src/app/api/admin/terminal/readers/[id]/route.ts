/**
 * DELETE /api/admin/terminal/readers/[id]?tenantId=&locationId=
 *
 * Remove a registered reader (`DELETE /v1/terminal/readers/:id` on the connected
 * account, then our row). Auth: owner | manager.
 */
import { NextResponse } from "next/server";
import { removeTerminalReader } from "@/lib/payments/terminal/readers";
import {
  authorizeAdminLocation,
  errorResponse,
} from "@/lib/payments/terminal/http";
import { enforceRateLimit } from "@/lib/security";

export const runtime = "nodejs";

export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const limited = enforceRateLimit(request, "payments");
  if (limited) return limited;
  const { searchParams } = new URL(request.url);
  const auth = await authorizeAdminLocation(
    request,
    searchParams.get("tenantId"),
    searchParams.get("locationId"),
  );
  if (!auth.ok) return auth.res;
  const { id } = await ctx.params;
  try {
    await removeTerminalReader({
      tenantId: auth.tenantId,
      locationId: auth.location.id,
      readerId: id,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err, "Could not remove the reader.");
  }
}
