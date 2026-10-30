/**
 * Payments endpoint.
 *
 * POST /api/payments — take one tender against an order. Idempotent on the
 * client-supplied `paymentId` (UUID): retries return the existing tender rather
 * than charging again. Resolves the tenant's Connect account for card rails,
 * computes the platform application fee, calls the rail (real when keys are
 * present, simulated otherwise), persists the payment, and marks the order
 * `paid` once the balance reaches zero. For ONLINE orders (`online_*` channel)
 * the amount and tip are derived from the order, never the client body, the
 * tender id is DERIVED from the order id + rail (the client's `paymentId` is
 * ignored, so a retry always lands on the same tender), only an
 * `awaiting_payment` order inside its rail's expiry window can be paid (409
 * otherwise), and the Stripe `clientSecret` is returned in this response only
 * (not stored). The response's `orderStatus` is `paid` only once the order is
 * actually settled; anything else means the customer still has to act.
 *
 * GET /api/payments?orderId= — list tenders + remaining balance for an order.
 * Tenant members only; tenders are returned without rail internals.
 *
 * No env vars are required; with none, rails settle via the simulated path.
 */
import { NextResponse } from "next/server";
import { getPosDriver } from "@/lib/db";
import { requireTenantMember, requireTenantRole } from "@/lib/auth/api";
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
  cancelPendingTender,
  cancelSupersededTenders,
  voidIfOverpaying,
  freshClientSecret,
  getOrderBalance,
  nextOnlineTenderId,
} from "@/lib/payments/service";
import { LiveTenderConflictError } from "@/lib/db/payment-types";
import { cancelOnlineCheckout, orderExpiresAt } from "@/lib/shop/lifecycle";
import { asapAvailability } from "@/lib/shop/scheduling";
import {
  isOnlineOrderRail,
  onlineRailAvailable,
} from "@/lib/payments/online-rails";
import { cardRailsSimulated } from "@/lib/payments/env";
import { closeOpenCardTender } from "@/lib/payments/terminal/flow";
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
  // The ORDER decides the currency, never the client: a body naming another
  // currency is rejected (a $25 USD order must not be payable as 2,500 KRW).
  if (body.currency.toUpperCase() !== order.currency.toUpperCase()) {
    return NextResponse.json(
      { error: "currency does not match the order." },
      { status: 400 },
    );
  }
  const tenantId = order.tenant_id;
  const locationId = order.location_id;

  // IN-STORE orders are taken at the till: every rail (cash, card, crypto) needs
  // a signed-in owner/manager/cashier of the order's tenant. The terminal's
  // Supabase session carries the device user's membership role (the staff PIN
  // switch does not change it). Online orders stay anonymous for card/crypto.
  if (order.channel === "in_store") {
    const auth = await requireTenantRole(tenantId, [
      "owner",
      "manager",
      "cashier",
    ]);
    if (!auth.ok) return auth.res;

    // Card-present tenders are server-driven: the PaymentIntent must be handed to
    // a reader (POST /api/terminal/payments). Creating one here would leave a
    // card_present intent nobody processes. (In simulated mode the legacy instant
    // approval stays until the terminal UI moves to the reader flow.)
    if (body.rail === "stripe_terminal" && !cardRailsSimulated()) {
      return NextResponse.json(
        {
          error: "Card payments in store go through the card reader.",
          code: "use_terminal_reader",
        },
        { status: 400 },
      );
    }
  }

  // Cash on an ONLINE order takes a till role, exactly like an in-store tender.
  // Checked BEFORE any tender lookup, so an anonymous caller cannot probe (or be
  // handed back) an existing cash tender by guessing a payment id.
  if (order.channel !== "in_store" && body.rail === "cash") {
    const auth = await requireTenantRole(tenantId, ["owner", "manager", "cashier"]);
    if (!auth.ok) return auth.res;
  }

  // ONLINE orders: the server owns the tender id (derived from order + rail).
  let paymentId = body.paymentId;
  const isOnline = order.channel !== "in_store";
  // (Cash is the exception: a till role may take SEVERAL cash tenders to split a
  // bill, so it keeps the client's tender id -- the same idempotency model as the
  // terminal -- instead of one derived id per rail.)
  if (isOnline && isOnlineOrderRail(body.rail) && body.rail !== "cash") {
    paymentId = await nextOnlineTenderId(order.id, body.rail);
  }

  // Idempotent retry: return the existing tender BEFORE the card gate, so a
  // retry after a successful charge is never turned into a refusal.
  try {
    const existing = await driver.getPayment(paymentId);
    if (existing) {
      if (existing.order_id !== order.id) {
        return NextResponse.json(
          { error: "paymentId already used for another order." },
          { status: 409 },
        );
      }
      const current = await driver.getOrder(order.id);
      // A stripe_online tender still awaiting the customer gets a fresh secret
      // from Stripe (this response only; never stored).
      const clientSecret = await freshClientSecret(existing);
      return NextResponse.json(
        {
          payment: publicTender(
            (await driver.getPayment(existing.id)) ?? existing,
          ),
          clientSecret,
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
  if (isOnline) {
    if (!isOnlineOrderRail(body.rail)) {
      return NextResponse.json(
        { error: "That payment method is not available for online orders." },
        { status: 422 },
      );
    }
    // Lifecycle gate: only an unpaid checkout can take a tender. (`placed` is a
    // legacy online order created before the lifecycle shipped.)
    if (order.status !== "awaiting_payment" && order.status !== "placed") {
      return NextResponse.json(
        {
          error:
            order.status === "abandoned"
              ? "This checkout expired. Please start again."
              : "This order can no longer be paid.",
          code: order.status === "abandoned" ? "checkout_abandoned" : undefined,
        },
        { status: 409 },
      );
    }
    if (order.status === "awaiting_payment") {
      // TTL gate: the SAME expiry the sweeper uses (earliest window of the
      // order's live tenders, else the requested rail's). Past it, try to give
      // the order up. `checkout_abandoned` is only ever returned when the order
      // really is abandoned; if a payment exists/may be in flight, tell the
      // client to keep waiting on it instead.
      const existingTenders = await driver.listPaymentsForOrder(order.id);
      if (
        Date.now() >
        orderExpiresAt(order, existingTenders, body.rail).getTime()
      ) {
        const cancelled = await cancelOnlineCheckout(order.id).catch(
          () => null,
        );
        if (cancelled?.ok) {
          return NextResponse.json(
            {
              error: "This checkout expired. Please start again.",
              code: "checkout_abandoned",
            },
            { status: 409 },
          );
        }
        return NextResponse.json(
          {
            error:
              "Your payment is still being confirmed. Please keep waiting.",
            code: "payment_pending",
          },
          { status: 409 },
        );
      }
      // An ASAP order is only payable while the store can still make it.
      if (order.fulfillment?.scheduled_for === "asap") {
        const settings = await driver.getStoreSettings(tenantId, locationId);
        if (settings.fulfillment) {
          const avail = asapAvailability(settings.fulfillment, new Date());
          if (!avail.available) {
            return NextResponse.json(
              { error: avail.reason ?? "ASAP ordering is unavailable." },
              { status: 422 },
            );
          }
        }
      }
    }
    // (Cash was authorized above.)
    if (body.rail !== "cash" && !onlineRailAvailable(body.rail)) {
      // An unconfigured crypto rail would simulate and auto-confirm: no money.
      return NextResponse.json(
        { error: "That payment method is not available right now." },
        { status: 409 },
      );
    }
    // Exactly one rail is live per order: every OTHER open tender (card intent,
    // pending USDC, pending Coinbase charge) is canceled before a new one is made.
    try {
      await cancelSupersededTenders(order.id, paymentId);
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "Payment failed." },
        { status: 502 },
      );
    }
    const owed = await deriveOnlineTender(order);
    amountCents = owed.amountCents;
    tipCents = owed.tipCents;
    // Split cash: a till role may take part of the bill (never more than is owed).
    if (body.rail === "cash" && body.amountCents > 0 && body.amountCents < amountCents) {
      amountCents = body.amountCents;
      // The tip rides on the FINAL covering tender only, never on a partial one.
      tipCents = 0;
    }
    if (amountCents <= 0) {
      return NextResponse.json(
        { error: "This order has nothing left to pay." },
        { status: 409 },
      );
    }
  }

  // IN-STORE: a card tender may be live on the reader (the customer can still tap).
  // Taking cash / crypto now would double charge, so close it first, STRICTLY. If
  // the card already went through, or the customer is mid-authorization, refuse
  // (409) and let the cashier re-check the balance.
  if (order.channel === "in_store" && body.rail !== "stripe_terminal") {
    const closed = await closeOpenCardTender(order.id).catch(() => "in_flight" as const);
    if (closed === "settled" || closed === "in_flight") {
      const current = await driver.getOrder(order.id);
      return NextResponse.json(
        {
          error:
            closed === "settled"
              ? "This order was already paid by card. Check the balance."
              : "The customer is paying by card on the reader. Wait for it to finish or cancel it first.",
          code: closed === "settled" ? "already_paid_by_card" : "card_in_progress",
          balanceCents: current ? await getOrderBalance(current) : undefined,
          orderStatus: current?.status,
        },
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
      paymentId,
      orderId: body.orderId,
      tenantId,
      locationId,
      rail: body.rail,
      amountCents,
      tipCents,
      currency: order.currency,
      connectAccountId,
      cashTenderedCents: body.cashTenderedCents,
      metadata: body.metadata,
    });

    // Concurrent split cash: two tills may both have derived the same remaining
    // balance. After the insert, a tender that is covered by EARLIER settled
    // tenders is voided (deterministic by created_at, id: exactly one survives).
    if (isOnline && body.rail === "cash" && (await voidIfOverpaying(payment))) {
      return NextResponse.json(
        {
          error:
            "This order was already paid in full by another payment. This cash tender was voided; do not keep the cash.",
          code: "already_paid",
        },
        { status: 409 },
      );
    }

    const refreshed = await driver.getOrder(body.orderId);
    // The sweeper / a cancel may have abandoned the order between the gate above
    // and the tender being written. Never hand out a secret or a URL for it:
    // close the provider object and the tender, and tell the client to start over.
    if (
      isOnline &&
      refreshed &&
      (refreshed.status === "abandoned" || refreshed.status === "voided")
    ) {
      await cancelPendingTender(payment);
      return NextResponse.json(
        {
          error: "This checkout expired. Please start again.",
          code: "checkout_abandoned",
        },
        { status: 409 },
      );
    }
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
      err instanceof PaymentConflictError ||
      err instanceof LiveTenderConflictError
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
