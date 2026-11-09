/**
 * POST /api/shop/gift-cards/redeem — apply a gift card / store credit to an
 * unpaid ONLINE checkout.
 *
 * Body: { orderId, code }. The server decides the amount: as much of what the
 * order still owes as the card covers. Once the card is debited, any open card
 * intent for the order is canceled (strictly), so the customer then pays only
 * the remainder with a fresh one; if it cannot be canceled the value goes back
 * to the card. Physical card numbers are till-only. The tender id is derived from (order, card): a retry returns the
 * same tender, and one card is applied at most once per order. If the checkout
 * is later canceled or expires, the value goes back to the card.
 * Anonymous; brute-force limited per IP and per device like the balance check.
 */
import { NextResponse } from "next/server";
import { getPosDriver } from "@/lib/db";
import { deriveTenderId } from "@/lib/payments/ids";
import { publicTender } from "@/lib/payments/public";
import { cancelSupersededTenders, getOrderBalance } from "@/lib/payments/service";
import { orderExpiresAt } from "@/lib/shop/lifecycle";
import { enforceRateLimit, isUuid, readJsonBody } from "@/lib/security";
import {
  admitLookup,
  errorResponse,
  featureOff,
  lookupIdentity,
  shopDevice,
  unknownCode,
  withDeviceCookie,
} from "@/lib/giftcards/http";
import {
  findAccountByCode,
  redeemStoredValue,
  releaseStoredValueTender,
} from "@/lib/giftcards/service";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const off = featureOff();
  if (off) return off;
  const limited = enforceRateLimit(request, "payments");
  if (limited) return limited;
  const device = shopDevice(request);
  const id = lookupIdentity(request, "shop", device.id);
  const parsed = await readJsonBody(request);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: parsed.status });
  const b = parsed.body as Record<string, unknown>;
  if (!isUuid(b.orderId) || typeof b.code !== "string") {
    return NextResponse.json({ error: "Malformed request." }, { status: 422 });
  }
  const driver = getPosDriver();
  const order = await driver.getOrder(b.orderId);
  if (!order || order.channel === "in_store") {
    return NextResponse.json({ error: "Order not found." }, { status: 404 });
  }
  if (order.status !== "awaiting_payment") {
    return NextResponse.json({ error: "This order can no longer be paid." }, { status: 409 });
  }
  if (order.core_ext?.stored_value) {
    return NextResponse.json(
      { error: "A gift card cannot be paid with a gift card." },
      { status: 422 },
    );
  }
  if (Date.now() > orderExpiresAt(order, await driver.listPaymentsForOrder(order.id)).getTime()) {
    return NextResponse.json(
      { error: "This checkout expired. Please start again.", code: "checkout_abandoned" },
      { status: 409 },
    );
  }

  const blocked = await admitLookup(id, order.tenant_id);
  if (blocked) return withDeviceCookie(blocked, device);

  try {
    const account = await findAccountByCode(order.tenant_id, b.code, { anonymous: true });
    if (!account || account.status === "pending") {
      return withDeviceCookie(await unknownCode(id, order.tenant_id), device);
    }
    const paymentId = deriveTenderId(order.id, `${account.kind}:${account.id}`, 0);
    const { payment, account: after, replayed } = await redeemStoredValue({
      order,
      account,
      paymentId,
      actorId: null,
      staffId: null,
    });
    // Only now, with the card debited, close any open card intent: it was for
    // the full amount and must not stay payable. If it cannot be closed (the
    // customer is paying it right now) the card is credited back.
    if (!replayed) {
      try {
        await cancelSupersededTenders(order.id, paymentId);
      } catch {
        await releaseStoredValueTender(payment.id);
        return withDeviceCookie(
          NextResponse.json(
            { error: "A card payment is in progress for this order. Wait for it to finish.", code: "payment_pending" },
            { status: 409 },
          ),
          device,
        );
      }
    }
    const current = await driver.getOrder(order.id);
    return withDeviceCookie(
      NextResponse.json({
        payment: publicTender(payment),
        account: { balance_cents: after.balance_cents, kind: after.kind },
        balanceCents: current ? await getOrderBalance(current) : 0,
        orderStatus: current?.status,
      }),
      device,
    );
  } catch (err) {
    return errorResponse(err, "shop-giftcard-redeem");
  }
}
