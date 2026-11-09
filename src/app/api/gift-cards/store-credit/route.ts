/**
 * POST /api/gift-cards/store-credit — issue store credit (e.g. instead of a
 * refund).
 *
 * Body: { tenantId, locationId?, accountId (client UUID), amountCents, reason,
 *         customerId? } -> { account, code } (the code is shown ONCE).
 * Up to the approval threshold (STORE_CREDIT_APPROVAL_CENTS, default $25) any
 * till role may issue it; above it the active staff member must be an owner or
 * manager (recorded as `approved_by`). Audited.
 */
import { NextResponse } from "next/server";
import { getPosDriver } from "@/lib/db";
import { enforceRateLimit, isUuid, readJsonBody } from "@/lib/security";
import {
  cleanText,
  errorResponse,
  featureOff,
  requireTillStaff,
} from "@/lib/giftcards/http";
import { businessDayStartIso, issueStoreCredit } from "@/lib/giftcards/service";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const off = featureOff();
  if (off) return off;
  const limited = enforceRateLimit(request, "payments");
  if (limited) return limited;
  const parsed = await readJsonBody(request);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: parsed.status });
  const b = parsed.body as Record<string, unknown>;
  const reason = cleanText(b.reason, 300);
  if (
    typeof b.tenantId !== "string" ||
    !isUuid(b.accountId) ||
    typeof b.amountCents !== "number" ||
    !reason ||
    (b.customerId != null && !isUuid(b.customerId))
  ) {
    return NextResponse.json(
      { error: "tenantId, accountId, amountCents and a reason are required." },
      { status: 422 },
    );
  }
  const locationId = typeof b.locationId === "string" ? b.locationId : null;
  const auth = await requireTillStaff(request, b.tenantId, locationId);
  if (!auth.ok) return auth.res;
  const { grant } = auth;
  if (!grant.role) {
    return NextResponse.json(
      { error: "Switch in with your staff PIN first.", code: "staff_required" },
      { status: 403 },
    );
  }
  try {
    const driver = getPosDriver();
    if (b.customerId) {
      const customer = await driver.getCustomer(b.customerId as string);
      if (!customer || customer.tenant_id !== grant.tenantId) {
        return NextResponse.json({ error: "Customer not found." }, { status: 404 });
      }
    }
    const currency = locationId
      ? (await driver.getStoreSettings(grant.tenantId, locationId)).currency
      : "USD";
    const location = locationId
      ? (await driver.listLocations(grant.tenantId)).find((l) => l.id === locationId) ?? null
      : null;
    const out = await issueStoreCredit({
      tenantId: grant.tenantId,
      locationId,
      accountId: b.accountId,
      amountCents: b.amountCents,
      reason,
      customerId: (b.customerId as string | undefined) ?? null,
      role: grant.role,
      actor: grant.actor,
      // The daily cap follows the PIN-switched staff member (else the device
      // login) and resets at the location's business-day start.
      capActorId: grant.staff?.id ?? grant.user.id,
      dayStartIso: businessDayStartIso(location),
      currency,
    });
    return NextResponse.json(out, { status: out.replayed ? 200 : 201 });
  } catch (err) {
    return errorResponse(err, "store-credit-issue");
  }
}
