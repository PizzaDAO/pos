/**
 * POST /api/shop/gift-cards — buy a gift card on the storefront.
 *
 * Body: { orderId (client UUID), tenantSlug?, locationSlug, amountCents,
 *         email (buyer), recipientName?, recipientEmail? }
 *
 * Creates the pending card and its online sale order (`awaiting_payment`, no
 * menu lines, no tax). The buyer then pays it through the normal online payment
 * path (POST /api/payments with the card rail); the card activates once that
 * settles, and the (inert) recipient delivery hook runs. `code` is returned in
 * the FIRST creation response only; a retry with the same orderId gets
 * `code: null`. The response also sets a short-lived signed `gc_reveal_<order>` cookie (one per purchase)
 * so this browser alone can reveal the code once after paying (/reveal).
 */
import { NextResponse } from "next/server";
import { getPosDriver } from "@/lib/db";
import { enforceRateLimit, isEmail, isUuid, readJsonBody } from "@/lib/security";
import { resolveStorefrontLocation } from "@/lib/shop/resolve-location";
import { ensureCustomer } from "@/lib/shop/auth";
import {
  ONLINE_PAYMENT_UNAVAILABLE_CODE,
  ONLINE_PAYMENT_UNAVAILABLE_MESSAGE,
  anyOnlinePaymentAllowed,
} from "@/lib/shop/training-online";
import { canUseOnlineOrdering, resolveEntitlements } from "@/lib/saas/entitlements";
import { cleanText, errorResponse, featureOff, revealCookieName } from "@/lib/giftcards/http";
import { REVEAL_TTL_MS, signRevealToken } from "@/lib/giftcards/codes";
import { createGiftCardSale } from "@/lib/giftcards/service";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const off = featureOff();
  if (off) return off;
  const limited = enforceRateLimit(request, "orders");
  if (limited) return limited;
  const parsed = await readJsonBody(request);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: parsed.status });
  const b = parsed.body as Record<string, unknown>;
  if (
    !isUuid(b.orderId) ||
    typeof b.amountCents !== "number" ||
    !isEmail(b.email) ||
    (b.recipientEmail != null && b.recipientEmail !== "" && !isEmail(b.recipientEmail))
  ) {
    return NextResponse.json({ error: "Enter an amount and a valid email." }, { status: 422 });
  }
  const resolved = await resolveStorefrontLocation({
    tenantSlug: b.tenantSlug,
    locationSlug: b.locationSlug,
  });
  if (!resolved.ok) {
    return NextResponse.json({ error: resolved.error }, { status: resolved.status });
  }
  const location = resolved.location;
  const driver = getPosDriver();

  const existing = await driver.getOrder(b.orderId);
  if (existing && existing.tenant_id !== location.tenant_id) {
    return NextResponse.json({ error: "That order id is already used." }, { status: 409 });
  }
  if (!existing) {
    if (!anyOnlinePaymentAllowed(location.tenant_id)) {
      return NextResponse.json(
        { error: ONLINE_PAYMENT_UNAVAILABLE_MESSAGE, code: ONLINE_PAYMENT_UNAVAILABLE_CODE },
        { status: 503 },
      );
    }
    const gate = canUseOnlineOrdering(
      resolveEntitlements(await driver.getSubscription(location.tenant_id)),
    );
    if (!gate.allowed) {
      return NextResponse.json({ error: gate.reason, code: "plan_limit" }, { status: 402 });
    }
  }

  try {
    const settings = await driver.getStoreSettings(location.tenant_id, location.id);
    const customer = existing
      ? null
      : await ensureCustomer({ tenantId: location.tenant_id, email: (b.email as string).trim() });
    const sale = await createGiftCardSale({
      tenantId: location.tenant_id,
      locationId: location.id,
      orderId: b.orderId,
      amountCents: b.amountCents,
      channel: "online",
      recipientName: cleanText(b.recipientName, 120),
      recipientEmail: cleanText(b.recipientEmail, 254),
      customerId: customer?.id ?? null,
      currency: settings.currency,
    });
    const res = NextResponse.json(
      { order: sale.order, code: sale.code, account: sale.account },
      { status: sale.replayed ? 200 : 201 },
    );
    // Bind the purchase to this browser: only it can reveal the code once after
    // paying (POST /api/shop/gift-cards/reveal). A replay never re-issues it.
    if (!sale.replayed) {
      res.cookies.set(revealCookieName(sale.order.id), signRevealToken(sale.order.id), {
        httpOnly: true,
        sameSite: "strict",
        secure: process.env.NODE_ENV === "production",
        path: "/api/shop/gift-cards",
        maxAge: REVEAL_TTL_MS / 1000,
      });
    }
    return res;
  } catch (err) {
    return errorResponse(err, "shop-giftcard-sale");
  }
}
