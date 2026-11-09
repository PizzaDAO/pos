/**
 * POST /api/marketplace/orders/{id}   body: { action: "accept" | "reject" | "ready", reason? }
 *
 * Till staff accept / reject an ingested marketplace order or mark it ready; the
 * matching status callback goes to the provider only when that provider is fully
 * configured (otherwise it is recorded as skipped). Idempotent. The order's own
 * tenant is authorized (never a client-supplied one).
 */
import { NextResponse } from "next/server";
import { requireOrderAccess } from "@/lib/auth/tenant-guard";
import { respondToMarketplaceOrder } from "@/lib/marketplace/service";
import { MarketplaceError } from "@/lib/marketplace/types";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  let body: { action?: unknown; reason?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const action =
    body.action === "accept" ||
    body.action === "reject" ||
    body.action === "ready"
      ? body.action
      : null;
  if (!action) {
    return NextResponse.json(
      { error: 'Body must be { action: "accept" | "reject" | "ready" }.' },
      { status: 422 },
    );
  }
  const auth = await requireOrderAccess(id, "terminal");
  if (!auth.ok) return auth.res;
  try {
    const reason =
      typeof body.reason === "string" ? body.reason.slice(0, 200) : null;
    const result = await respondToMarketplaceOrder(id, action, { reason });
    return NextResponse.json({
      order: result.order,
      acceptance: result.acceptance,
      changed: result.changed,
      callback: result.callback,
    });
  } catch (err) {
    if (err instanceof MarketplaceError) {
      const status = err.code === "not_found" ? 404 : 409;
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status },
      );
    }
    throw err;
  }
}
