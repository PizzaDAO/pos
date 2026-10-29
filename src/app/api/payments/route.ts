/**
 * Payments endpoint.
 *
 * POST /api/payments — take one tender against an order. Idempotent on the
 * client-supplied `paymentId` (UUID): retries return the existing tender rather
 * than charging again. Resolves the tenant's Connect account for card rails,
 * computes the platform application fee, calls the rail (real when keys are
 * present, simulated otherwise), persists the payment, and marks the order
 * `paid` once the balance reaches zero. For ONLINE orders (`online_*` channel)
 * the amount and tip are derived from the order, never the client body, and the
 * Stripe `clientSecret` is returned in this response only (not stored).
 *
 * GET /api/payments?orderId= — list tenders + remaining balance for an order.
 * Tenant members only; tenders are returned without rail internals.
 *
 * No env vars are required; with none, rails settle via the simulated path.
 */
import { NextResponse } from "next/server";
import { getPosDriver } from "@/lib/db";
import { requireTenantMember } from "@/lib/auth/api";
import { publicTender } from "@/lib/payments/public";
import {
  CardPaymentsNotReadyError,
  resolveCardConnectAccountId,
} from "@/lib/payments/connect";
import type { PaymentRailKey } from "@/lib/payments/PaymentRail";
import {
  PaymentConflictError,
  takePaymentDetailed,
  deriveOnlineTender,
  getOrderBalance,
} from "@/lib/payments/service";
import { enforceRateLimit, isMoneyCents, readJsonBody } from "@/lib/security";

export const runtime = "nodejs";

interface TakePaymentBody {
  paymentId: string;
  orderId: string;
  tenantId: string;
  locationId: string;
  rail: PaymentRailKey | "cash";
  amountCents: number;
  tipCents?: number;
  currency: string;
  cashTenderedCents?: number;
  metadata?: Record<string, string>;
}

function isValid(body: unknown): body is TakePaymentBody {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  return (
    typeof b.paymentId === "string" &&
    typeof b.orderId === "string" &&
    typeof b.tenantId === "string" &&
    typeof b.locationId === "string" &&
    typeof b.rail === "string" &&
    // Amount + optional tip must be non-negative integer cents (reject NaN /
    // negative / fractional / absurd values before they reach the rail).
    isMoneyCents(b.amountCents) &&
    (b.tipCents === undefined || isMoneyCents(b.tipCents)) &&
    (b.cashTenderedCents === undefined || isMoneyCents(b.cashTenderedCents)) &&
    typeof b.currency === "string"
  );
}

export async function POST(request: Request) {
  // Rate-limit payment capture per IP to blunt charge-spam / card-testing abuse.
  const limited = enforceRateLimit(request, "payments");
  if (limited) return limited;

  const parsed = await readJsonBody(request);
  if (!parsed.ok) {
    return NextResponse.json(
      { error: parsed.error },
      { status: parsed.status },
    );
  }
  const body = parsed.body;
  if (!isValid(body)) {
    return NextResponse.json(
      { error: "Malformed payment payload." },
      { status: 422 },
    );
  }

  const driver = getPosDriver();
  const order = await driver.getOrder(body.orderId);
  if (!order) {
    return NextResponse.json({ error: "Order not found." }, { status: 404 });
  }

  // NEVER trust the client's tenant/location: the order is the source of truth.
  // A body that names a different tenant/location is rejected outright.
  if (
    body.tenantId !== order.tenant_id ||
    body.locationId !== order.location_id
  ) {
    return NextResponse.json(
      { error: "tenantId/locationId do not match the order." },
      { status: 400 },
    );
  }
  const tenantId = order.tenant_id;
  const locationId = order.location_id;

  // Idempotent retry: return the existing tender BEFORE the card gate, so a
  // retry after a successful charge is never turned into a refusal.
  try {
    const existing = await driver.getPayment(body.paymentId);
    if (existing) {
      if (existing.order_id !== order.id) {
        return NextResponse.json(
          { error: "paymentId already used for another order." },
          { status: 409 },
        );
      }
      const current = await driver.getOrder(order.id);
      return NextResponse.json(
        {
          payment: publicTender(existing),
          balanceCents: current ? await getOrderBalance(current) : 0,
          orderStatus: current?.status,
        },
        { status: 201 },
      );
    }
  } catch {
    // Fall through: takePayment repeats the idempotency check.
  }

  // ONLINE orders: the server decides what is owed. The client's amountCents /
  // tipCents are ignored (the order total already includes the customer's tip,
  // which rides on the tender's tip, so trusting the body double-charges it).
  let amountCents = body.amountCents;
  let tipCents = body.tipCents ?? 0;
  const isOnline = order.channel !== "in_store";
  if (isOnline) {
    // An anonymous caller can never settle an online order with cash.
    if (body.rail === "cash") {
      const auth = await requireTenantMember(tenantId);
      if (!auth.ok) return auth.res;
    }
    ({ amountCents, tipCents } = await deriveOnlineTender(order));
    if (amountCents <= 0) {
      return NextResponse.json(
        { error: "This order has nothing left to pay." },
        { status: 409 },
      );
    }
  }

  // Resolve the connected account for card rails (simulated when no Stripe key).
  // In real mode a tenant without a charges-enabled account is refused (409).
  try {
    let connectAccountId: string | null = null;
    if (body.rail === "stripe_terminal" || body.rail === "stripe_online") {
      connectAccountId = await resolveCardConnectAccountId(tenantId);
    }
    const { payment, clientSecret } = await takePaymentDetailed({
      paymentId: body.paymentId,
      orderId: body.orderId,
      tenantId,
      locationId,
      rail: body.rail,
      amountCents,
      tipCents,
      currency: body.currency,
      connectAccountId,
      cashTenderedCents: body.cashTenderedCents,
      metadata: body.metadata,
    });

    const refreshed = await driver.getOrder(body.orderId);
    const balance = refreshed ? await getOrderBalance(refreshed) : 0;
    return NextResponse.json(
      {
        payment: publicTender(payment),
        clientSecret,
        balanceCents: balance,
        orderStatus: refreshed?.status,
      },
      { status: 201 },
    );
  } catch (err) {
    if (
      err instanceof CardPaymentsNotReadyError ||
      err instanceof PaymentConflictError
    ) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Payment failed." },
      { status: 502 },
    );
  }
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const orderId = searchParams.get("orderId");
  if (!orderId) {
    return NextResponse.json(
      { error: "orderId is required." },
      { status: 400 },
    );
  }
  const driver = getPosDriver();
  const order = await driver.getOrder(orderId);
  if (!order) {
    return NextResponse.json({ error: "Order not found." }, { status: 404 });
  }
  // Tenders + totals are staff-only: authorize against the ORDER's tenant.
  const auth = await requireTenantMember(order.tenant_id);
  if (!auth.ok) return auth.res;
  const payments = await driver.listPaymentsForOrder(orderId);
  const balance = await getOrderBalance(order);
  return NextResponse.json({
    order,
    payments: payments.map(publicTender),
    balanceCents: balance,
    orderStatus: order.status,
  });
}
