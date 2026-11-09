/**
 * POST /api/gift-cards/sales — sell a gift card at the till.
 *
 * Body: { tenantId, locationId, orderId (client UUID), amountCents,
 *         physicalCode? (a pre-printed card number), recipientName?, recipientEmail? }
 *
 * Creates the PENDING card and its sale order (no menu lines, no tax, status
 * `draft`); the till then takes payment on `order.id` like any order. The card
 * activates when that order is paid. A generated code is returned ONCE (`code`);
 * a retry with the same orderId returns the same sale with `code: null`.
 * Auth: owner | manager | cashier.
 */
import { NextResponse } from "next/server";
import { getPosDriver } from "@/lib/db";
import { enforceRateLimit, isEmail, isUuid, readJsonBody } from "@/lib/security";
import {
  cleanText,
  errorResponse,
  featureOff,
  requireTillStaff,
} from "@/lib/giftcards/http";
import { createGiftCardSale } from "@/lib/giftcards/service";

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
    typeof b.tenantId !== "string" ||
    typeof b.locationId !== "string" ||
    !isUuid(b.orderId) ||
    typeof b.amountCents !== "number" ||
    (b.physicalCode !== undefined && b.physicalCode !== null && typeof b.physicalCode !== "string") ||
    (b.recipientEmail != null && b.recipientEmail !== "" && !isEmail(b.recipientEmail))
  ) {
    return NextResponse.json({ error: "Malformed gift card sale." }, { status: 422 });
  }
  const auth = await requireTillStaff(request, b.tenantId, b.locationId);
  if (!auth.ok) return auth.res;
  const { grant } = auth;
  try {
    const settings = await getPosDriver().getStoreSettings(grant.tenantId, b.locationId);
    const sale = await createGiftCardSale({
      tenantId: grant.tenantId,
      locationId: b.locationId,
      orderId: b.orderId,
      amountCents: b.amountCents,
      channel: "in_store",
      physicalCode: cleanText(b.physicalCode, 64),
      recipientName: cleanText(b.recipientName, 120),
      recipientEmail: cleanText(b.recipientEmail, 254),
      staffId: grant.staff?.id ?? null,
      actorId: grant.user.id,
      currency: settings.currency,
    });
    return NextResponse.json(sale, { status: sale.replayed ? 200 : 201 });
  } catch (err) {
    return errorResponse(err, "giftcard-sale");
  }
}
