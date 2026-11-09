/**
 * POST /api/shop/gift-cards/balance — a customer checks a gift card / store
 * credit balance on the storefront.
 *
 * Body: { tenantSlug?, locationSlug, code } -> { balanceCents, currency, last4,
 * status, kind }. Anonymous, so brute-force limited per IP AND per device
 * (`gc_device` cookie), each scoped to the tenant, in a lockout table shared by
 * every instance: unknown codes are a uniform 404 and lock the caller out after
 * too many. Pre-printed physical card numbers are till-only (a uniform 404 here).
 */
import { NextResponse } from "next/server";
import { readJsonBody } from "@/lib/security";
import { resolveStorefrontLocation } from "@/lib/shop/resolve-location";
import {
  admitLookup,
  errorResponse,
  featureOff,
  lookupIdentity,
  shopDevice,
  unknownCode,
  withDeviceCookie,
} from "@/lib/giftcards/http";
import { findAccountByCode } from "@/lib/giftcards/service";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const off = featureOff();
  if (off) return off;
  const device = shopDevice(request);
  const id = lookupIdentity(request, "shop", device.id);
  const parsed = await readJsonBody(request);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: parsed.status });
  const b = parsed.body as Record<string, unknown>;
  const resolved = await resolveStorefrontLocation({
    tenantSlug: b.tenantSlug,
    locationSlug: b.locationSlug,
  });
  if (!resolved.ok) {
    return NextResponse.json({ error: resolved.error }, { status: resolved.status });
  }
  const tenantId = resolved.location.tenant_id;
  const blocked = await admitLookup(id, tenantId);
  if (blocked) return withDeviceCookie(blocked, device);
  try {
    const account = await findAccountByCode(tenantId, b.code, { anonymous: true });
    if (!account || account.status === "pending") {
      return withDeviceCookie(await unknownCode(id, tenantId), device);
    }
    return withDeviceCookie(
      NextResponse.json({
        balanceCents: account.status === "active" ? account.balance_cents : 0,
        currency: account.currency,
        last4: account.code_last4,
        status: account.status,
        kind: account.kind,
      }),
      device,
    );
  } catch (err) {
    return errorResponse(err, "shop-giftcard-balance");
  }
}
