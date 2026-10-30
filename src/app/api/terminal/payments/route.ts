/**
 * POST /api/terminal/payments
 *   { paymentId, orderId, readerId, amountCents, tipCents? }
 *
 * Start (or resume) a card tender on a reader for an IN-STORE order. The order
 * decides the tenant, location and currency; the body only picks the amount (at
 * most the balance due) and the reader (which must belong to that location).
 * Idempotent on `paymentId`; a second start while a card tender is live returns
 * the live one (`resumed: true`). Auth: owner | manager | cashier.
 *
 * The tender is created `requires_action` and does NOT reduce the balance until
 * the reader approves; completion arrives via `GET /api/terminal/payments/[id]`
 * (polling) and the Connect webhook.
 */
import { NextResponse } from "next/server";
import { getPosDriver } from "@/lib/db";
import { requireTenantRole } from "@/lib/auth/api";
import { publicTender } from "@/lib/payments/public";
import { getOrderBalance } from "@/lib/payments/service";
import { startCardTender } from "@/lib/payments/terminal/flow";
import { TILL_ROLES, errorResponse } from "@/lib/payments/terminal/http";
import {
  enforceRateLimit,
  isMoneyCents,
  isUuid,
  readJsonBody,
} from "@/lib/security";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const limited = enforceRateLimit(request, "payments");
  if (limited) return limited;
  const parsed = await readJsonBody(request);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: parsed.status });
  const b = (parsed.body ?? {}) as Record<string, unknown>;
  if (
    !isUuid(b.paymentId) ||
    typeof b.orderId !== "string" ||
    !b.orderId ||
    typeof b.readerId !== "string" ||
    !b.readerId ||
    !isMoneyCents(b.amountCents) ||
    (b.tipCents !== undefined && !isMoneyCents(b.tipCents))
  ) {
    return NextResponse.json({ error: "Malformed card payment payload." }, { status: 422 });
  }

  const driver = getPosDriver();
  const order = await driver.getOrder(b.orderId);
  if (!order) return NextResponse.json({ error: "Order not found." }, { status: 404 });
  // The ORDER's tenant is the authority, never the body.
  const auth = await requireTenantRole(order.tenant_id, TILL_ROLES);
  if (!auth.ok) return auth.res;

  try {
    const { payment, resumed } = await startCardTender({
      paymentId: b.paymentId,
      orderId: order.id,
      readerId: b.readerId,
      amountCents: b.amountCents,
      tipCents: b.tipCents as number | undefined,
    });
    const refreshed = await driver.getOrder(order.id);
    return NextResponse.json(
      {
        payment: publicTender(payment),
        resumed,
        balanceCents: refreshed ? await getOrderBalance(refreshed) : 0,
        orderStatus: refreshed?.status,
      },
      { status: 201 },
    );
  } catch (err) {
    return errorResponse(err);
  }
}
