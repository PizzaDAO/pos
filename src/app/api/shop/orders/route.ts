/**
 * Online-order intake — POST /api/shop/orders
 *
 * The single entry point for a customer placing an order from /shop. It:
 *  1. Resolves the customer (guest upsert by email) via the DB abstraction.
 *  2. Validates the requested fulfillment time against store hours + prep
 *     (ASAP) or the scheduling window (scheduled) — server-side, never trusting
 *     the client.
 *  3. For DELIVERY: re-quotes the address through the DeliveryProvider (the zone
 *     GATE — out-of-zone/below-minimum is rejected here too), folds the delivery
 *     fee into the order, then dispatches the delivery and persists a record.
 *  4. Creates the order with the correct CHANNEL (online_pickup/online_delivery)
 *     and status `placed` so it lands on the Phase 3 KDS board.
 *
 * Idempotent on the client order UUID (createOrder upserts by id). No env vars
 * required — payments + delivery providers run simulated with none.
 */
import { NextResponse } from "next/server";
import {
  getPosDriver,
  type CreateOrderInput,
  type DeliveryAddress,
  type OrderFulfillment,
  type OrderItem,
} from "@/lib/db";
import { computeOrderTotals } from "@/lib/pricing";
import { ensureCustomer } from "@/lib/shop/auth";
import {
  asapAvailability,
  checkScheduledTime,
} from "@/lib/shop/scheduling";
import { quoteDelivery, dispatchDelivery } from "@/lib/delivery/service";
import { DeliveryUnavailableError } from "@/lib/delivery";
import {
  canUseOnlineOrdering,
  resolveEntitlements,
} from "@/lib/saas/entitlements";

export const runtime = "nodejs";

interface ShopOrderBody {
  id: string;
  locationSlug: string;
  items: OrderItem[];
  fulfillmentType: "pickup" | "delivery";
  scheduledFor: "asap" | string;
  customer: { email: string; name?: string; phone?: string };
  address?: DeliveryAddress;
  deliveryNotes?: string;
  notes?: string;
  tipCents?: number;
}

function isValid(body: unknown): body is ShopOrderBody {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  return (
    typeof b.id === "string" &&
    typeof b.locationSlug === "string" &&
    Array.isArray(b.items) &&
    (b.fulfillmentType === "pickup" || b.fulfillmentType === "delivery") &&
    (b.scheduledFor === "asap" || typeof b.scheduledFor === "string") &&
    typeof b.customer === "object" &&
    b.customer !== null &&
    typeof (b.customer as Record<string, unknown>).email === "string"
  );
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (!isValid(body)) {
    return NextResponse.json(
      { error: "Malformed order payload." },
      { status: 422 },
    );
  }

  const driver = getPosDriver();

  // Idempotency: if this order id was already placed, return it unchanged.
  const existing = await driver.getOrder(body.id);
  if (existing) {
    const delivery = await driver.getDeliveryForOrder(existing.id);
    return NextResponse.json({ order: existing, delivery }, { status: 200 });
  }

  const location = await driver.getLocationBySlug(body.locationSlug);
  if (!location) {
    return NextResponse.json({ error: "Location not found." }, { status: 404 });
  }
  const tenantId = location.tenant_id;
  const locationId = location.id;

  // ---- Plan gate: online ordering requires the Pro plan or higher. ----------
  // The tenant's subscription tier gates customer online ordering (Phase 6). A
  // Starter-plan tenant's storefront cannot accept online orders; the server is
  // authoritative here even though the storefront also reflects it.
  const subscription = await driver.getSubscription(tenantId);
  const onlineGate = canUseOnlineOrdering(resolveEntitlements(subscription));
  if (!onlineGate.allowed) {
    return NextResponse.json(
      { error: onlineGate.reason, code: "plan_limit" },
      { status: 402 },
    );
  }

  const settings = await driver.getStoreSettings(tenantId, locationId);
  const fulfillment = settings.fulfillment;
  if (!fulfillment) {
    return NextResponse.json(
      { error: "Online ordering is not configured for this location." },
      { status: 422 },
    );
  }

  const activeItems = body.items.filter((i) => !i.voided);
  if (activeItems.length === 0) {
    return NextResponse.json({ error: "Cart is empty." }, { status: 422 });
  }

  // ---- Fulfillment-type gate ------------------------------------------------
  if (body.fulfillmentType === "pickup" && !fulfillment.pickup_enabled) {
    return NextResponse.json(
      { error: "Pickup is not available at this location." },
      { status: 422 },
    );
  }
  if (body.fulfillmentType === "delivery" && !fulfillment.delivery_enabled) {
    return NextResponse.json(
      { error: "Delivery is not available at this location." },
      { status: 422 },
    );
  }

  // ---- Time gate (hours + prep / scheduling window) -------------------------
  const now = new Date();
  let promisedAt: string;
  if (body.scheduledFor === "asap") {
    const avail = asapAvailability(fulfillment, now);
    if (!avail.available || !avail.promisedAt) {
      return NextResponse.json(
        { error: avail.reason ?? "ASAP ordering is unavailable." },
        { status: 422 },
      );
    }
    promisedAt = avail.promisedAt;
  } else {
    const check = checkScheduledTime(
      fulfillment,
      now,
      new Date(body.scheduledFor),
    );
    if (!check.ok || !check.promisedAt) {
      return NextResponse.json(
        { error: check.reason ?? "Invalid scheduled time." },
        { status: 422 },
      );
    }
    promisedAt = check.promisedAt;
  }

  // ---- Customer (guest upsert) ---------------------------------------------
  const customer = await ensureCustomer({
    tenantId,
    email: body.customer.email,
    name: body.customer.name ?? null,
    phone: body.customer.phone ?? null,
  });

  // ---- Subtotal (pre-delivery) so zone minimums are checked correctly -------
  const baseTotals = computeOrderTotals({
    items: activeItems,
    discountCents: 0,
    taxRateBps: settings.tax_rate_bps,
    tipCents: 0,
  });

  // ---- Delivery quote + zone gate ------------------------------------------
  let deliveryFeeCents = 0;
  let quotedProvider: import("@/lib/delivery").DeliveryProviderKey | null = null;
  let zoneId: string | null = null;
  let etaMinutes: number | null = null;
  const pickupAddress: DeliveryAddress = {
    line1: fulfillment.pickup_address ?? "Pickup",
    city: "",
    region: "",
    postal_code: "",
    country: "US",
  };

  if (body.fulfillmentType === "delivery") {
    if (!body.address) {
      return NextResponse.json(
        { error: "Delivery address is required." },
        { status: 422 },
      );
    }
    try {
      const { provider, quote } = await quoteDelivery({
        tenantId,
        locationId,
        dropoff: body.address,
        pickup: pickupAddress,
        subtotalCents: baseTotals.subtotal_cents,
        currency: settings.currency,
        scheduledFor:
          body.scheduledFor === "asap" ? undefined : body.scheduledFor,
      });
      quotedProvider = provider;
      deliveryFeeCents = quote.fee.amount;
      zoneId = quote.quoteId ?? null;
      etaMinutes = quote.etaMinutes ?? null;
    } catch (err) {
      if (err instanceof DeliveryUnavailableError) {
        return NextResponse.json(
          { error: err.message, deliverable: false },
          { status: 422 },
        );
      }
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "Delivery quote failed." },
        { status: 502 },
      );
    }
  }

  // ---- Final totals: subtotal + delivery fee, taxed, + tip ------------------
  // The delivery fee is modeled as a non-taxable add-on folded into the order
  // total (kept out of the taxable base — common for delivery fees).
  const totals = computeOrderTotals({
    items: activeItems,
    discountCents: 0,
    taxRateBps: settings.tax_rate_bps,
    tipCents: body.tipCents ?? 0,
  });
  totals.total_cents += deliveryFeeCents;

  const orderFulfillment: OrderFulfillment = {
    type: body.fulfillmentType,
    scheduled_for: body.scheduledFor,
    promised_at: promisedAt,
    ...(body.fulfillmentType === "delivery"
      ? {
          address: body.address,
          zone_id: zoneId ?? undefined,
          delivery_fee_cents: deliveryFeeCents,
          delivery_notes: body.deliveryNotes,
        }
      : {}),
  };

  const payload: CreateOrderInput = {
    id: body.id,
    tenant_id: tenantId,
    location_id: locationId,
    channel:
      body.fulfillmentType === "delivery" ? "online_delivery" : "online_pickup",
    currency: settings.currency,
    items: body.items,
    discount_cents: 0,
    totals,
    notes: body.notes?.trim() ? body.notes.trim() : null,
    status: "placed",
    customer_id: customer.id,
    fulfillment: orderFulfillment,
  };

  const order = await driver.createOrder(payload);

  // ---- Dispatch the delivery (queues in-house for manual assignment) --------
  let delivery = null;
  if (body.fulfillmentType === "delivery" && quotedProvider && body.address) {
    delivery = await dispatchDelivery({
      orderId: order.id,
      tenantId,
      locationId,
      provider: quotedProvider,
      pickup: pickupAddress,
      dropoff: body.address,
      zoneId,
      feeCents: deliveryFeeCents,
      currency: settings.currency,
      etaMinutes,
      scheduledFor:
        body.scheduledFor === "asap" ? undefined : body.scheduledFor,
    });
  }

  return NextResponse.json({ order, customer, delivery }, { status: 201 });
}
