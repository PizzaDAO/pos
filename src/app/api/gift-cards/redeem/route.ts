/**
 * POST /api/gift-cards/redeem — pay (part of) an IN-STORE order with a gift card
 * or store credit at the till.
 *
 * Body: { orderId, code, paymentId (client UUID, idempotency key), amountCents? }
 * `amountCents` omitted = as much as the card covers. Never more than the card
 * holds or the order still owes (checked again under the database lock), so a
 * split with other tenders works and two tills cannot overspend one card. A
 * retry with the same paymentId returns the same tender.
 * Auth: owner | manager | cashier of the order's tenant.
 */
import { NextResponse } from "next/server";
import { getPosDriver } from "@/lib/db";
import { closeOpenCardTender } from "@/lib/payments/terminal/flow";
import { publicTender } from "@/lib/payments/public";
import { getOrderBalance } from "@/lib/payments/service";
import { enforceRateLimit, isMoneyCents, isUuid, readJsonBody } from "@/lib/security";
import {
  admitLookup,
  errorResponse,
  featureOff,
  lookupIdentity,
  requireTillStaff,
  unknownCode,
} from "@/lib/giftcards/http";
import { findAccountByCode, redeemStoredValue } from "@/lib/giftcards/service";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const off = featureOff();
  if (off) return off;
  const limited = enforceRateLimit(request, "payments");
  if (limited) return limited;
  const parsed = await readJsonBody(request);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: parsed.status });
  const b = parsed.body as Record<string, unknown>;
  if (
    !isUuid(b.orderId) ||
    !isUuid(b.paymentId) ||
    typeof b.code !== "string" ||
    (b.amountCents !== undefined && b.amountCents !== null && !isMoneyCents(b.amountCents))
  ) {
    return NextResponse.json({ error: "Malformed gift card payment." }, { status: 422 });
  }
  const driver = getPosDriver();
  const order = await driver.getOrder(b.orderId);
  if (!order) return NextResponse.json({ error: "Order not found." }, { status: 404 });
  const auth = await requireTillStaff(request, order.tenant_id);
  if (!auth.ok) return auth.res;
  if (order.channel !== "in_store") {
    return NextResponse.json(
      { error: "Online orders take gift cards at checkout." },
      { status: 422 },
    );
  }
  const id = lookupIdentity(request, "till", auth.grant.user.id);
  const blocked = admitLookup(id);
  if (blocked) return blocked;

  try {
    const account = await findAccountByCode(order.tenant_id, b.code);
    if (!account) return unknownCode(id);

    // A card tender may still be live on the reader: close it first, strictly
    // (same rule as every other in-store tender), so nothing double-pays.
    const closed = await closeOpenCardTender(order.id).catch(() => "in_flight" as const);
    if (closed === "settled" || closed === "in_flight" || closed === "needs_review") {
      return NextResponse.json(
        {
          error:
            closed === "settled"
              ? "This order was already paid by card. Check the balance."
              : "A card payment is in progress on this order. Finish or cancel it first.",
          code: "card_in_progress",
        },
        { status: 409 },
      );
    }

    const { payment, account: after, replayed } = await redeemStoredValue({
      order,
      account,
      paymentId: b.paymentId,
      amountCents: (b.amountCents as number | null | undefined) ?? null,
      actorId: auth.grant.user.id,
      staffId: auth.grant.staff?.id ?? null,
    });
    const current = await driver.getOrder(order.id);
    return NextResponse.json(
      {
        payment: publicTender(payment),
        account: after,
        balanceCents: current ? await getOrderBalance(current) : 0,
        orderStatus: current?.status,
      },
      { status: replayed ? 200 : 201 },
    );
  } catch (err) {
    return errorResponse(err, "giftcard-redeem");
  }
}
