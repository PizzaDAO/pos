/**
 * POST /api/gift-cards/reloads — add money to an active gift card at the till.
 *
 * Body: { tenantId, locationId, orderId (client UUID), code, amountCents }
 *
 * Creates the reload order (no menu lines, no tax); the till takes payment on
 * `order.id`, and the amount lands on the card when it is paid. Counts toward
 * the code lookup limits. Auth: owner | manager | cashier.
 */
import { NextResponse } from "next/server";
import { getPosDriver } from "@/lib/db";
import { enforceRateLimit, isUuid, readJsonBody } from "@/lib/security";
import {
  admitLookup,
  errorResponse,
  featureOff,
  lookupIdentity,
  requireTillStaff,
  unknownCode,
} from "@/lib/giftcards/http";
import { createGiftCardReload, StoredValueError } from "@/lib/giftcards/service";

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
    typeof b.code !== "string" ||
    typeof b.amountCents !== "number"
  ) {
    return NextResponse.json({ error: "Malformed reload." }, { status: 422 });
  }
  const auth = await requireTillStaff(request, b.tenantId, b.locationId);
  if (!auth.ok) return auth.res;
  const { grant } = auth;
  const id = lookupIdentity(request, "till", grant.user.id);
  const blocked = await admitLookup(id, grant.tenantId);
  if (blocked) return blocked;
  try {
    const settings = await getPosDriver().getStoreSettings(grant.tenantId, b.locationId);
    const out = await createGiftCardReload({
      tenantId: grant.tenantId,
      locationId: b.locationId,
      orderId: b.orderId,
      code: b.code,
      amountCents: b.amountCents,
      staffId: grant.staff?.id ?? null,
      currency: settings.currency,
    });
    return NextResponse.json(out, { status: out.replayed ? 200 : 201 });
  } catch (err) {
    if (err instanceof StoredValueError && err.code === "not_found") return unknownCode(id, grant.tenantId);
    return errorResponse(err, "giftcard-reload");
  }
}
