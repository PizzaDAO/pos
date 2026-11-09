/**
 * POST { orderId, reprint? } -> print a kitchen ticket for an order.
 *
 * Network printer when the order's location has one registered (queues a job per
 * printer; always a fresh ticket, so this is also "reprint"), else
 * `{ via: "browser" }` and the caller opens the browser print view. Auth: a
 * kitchen-surface role on the ORDER's tenant (never a client-supplied tenant).
 */
import { NextResponse } from "next/server";
import { requireOrderAccess } from "@/lib/auth/tenant-guard";
import { resolveTicketPrinter } from "@/lib/printing/provider";
import { enforceRateLimit, readJsonBody } from "@/lib/security";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const limited = enforceRateLimit(request, "orders");
  if (limited) return limited;
  const parsed = await readJsonBody(request);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: parsed.status });
  const b = (parsed.body ?? {}) as Record<string, unknown>;
  if (typeof b.orderId !== "string" || !b.orderId) {
    return NextResponse.json({ error: "orderId is required." }, { status: 422 });
  }
  const auth = await requireOrderAccess(b.orderId, "kitchen");
  if (!auth.ok) return auth.res;
  const printer = await resolveTicketPrinter(auth.order.tenant_id, auth.order.location_id);
  const result = await printer.print(auth.order, { reprint: b.reprint === true });
  return NextResponse.json(result, { status: result.ok ? 200 : 409 });
}
