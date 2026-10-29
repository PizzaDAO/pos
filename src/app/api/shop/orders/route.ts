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
 * PRICING IS SERVER-SIDE: the browser's line/modifier prices and totals are
 * ignored. Each line is re-priced from the location's menu (size price +
 * modifier prices incl. the half-and-half rule); unknown / unavailable / 86'd
 * items, sizes or modifiers are rejected with 422. The tip is an explicit,
 * bounded field; the delivery fee comes from the server-side quote.
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
import { priceOrder } from "@/lib/order-pricing";
import { maxTipCents, RepriceError } from "@/lib/reprice";
import { enforceRateLimit, isEmail, isMoneyCents } from "@/lib/security";
import { ensureCustomer } from "@/lib/shop/auth";
import { resolveStorefrontLocation } from "@/lib/shop/resolve-location";
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
  /** Storefront tenant slug (locations.slug is only unique per tenant). */
  tenantSlug?: string;
  locationSlug: string;
  /** Client lines — only ids/selections are used; prices are recomputed. */
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
    isEmail((b.customer as Record<string, unknown>).email) &&
    (b.tipCents === undefined || isMoneyCents(b.tipCents)) &&
    (b.notes === undefined ||
      (typeof b.notes === "string" && b.notes.length <= 1000))
  );
}

/** A trimmed, length-bounded optional string from client input, else null. */
function cleanText(v: unknown, max: number): string | null {
  return typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;
}

export async function POST(request: Request) {
  // Public order intake — rate-limit per IP.
  const limited = enforceRateLimit(request, "orders");
  if (limited) return limited;

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
    // Never hand out an in-store order through the public storefront.
    if (existing.channel === "in_store") {
      return NextResponse.json(
        { error: "Order id already in use." },
        { status: 409 },
      );
    }
    const delivery = await driver.getDeliveryForOrder(existing.id);
    return NextResponse.json({ order: existing, delivery }, { status: 200 });
  }

  // The tenant is derived from the resolved location — never the client.
  const resolved = await resolveStorefrontLocation({
    tenantSlug: body.tenantSlug,
    locationSlug: body.locationSlug,
  });
  if (!resolved.ok) {
    return NextResponse.json(
      { error: resolved.error },
      { status: resolved.status },
    );
  }
  const location = resolved.location;
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

  // ---- Server-side repricing (client prices are never trusted) -------------
  let activeItems: OrderItem[];
  let baseTotals: ReturnType<typeof computeOrderTotals>;
  try {
    const priced = await priceOrder({
      tenantId,
      locationId,
      items: body.items,
      discountCents: 0,
      tipCents: 0,
      voided: "drop",
      settings,
    });
    activeItems = priced.items;
    // Subtotal (pre-delivery) so zone minimums are checked correctly.
    baseTotals = priced.totals;
  } catch (err) {
    if (err instanceof RepriceError) {
      return NextResponse.json({ error: err.message }, { status: 422 });
    }
    throw err;
  }
  if (activeItems.length === 0) {
    return NextResponse.json({ error: "Cart is empty." }, { status: 422 });
  }

  // ---- Tip: explicit + bounded ---------------------------------------------
  const tipCents = body.tipCents ?? 0;
  if (tipCents > maxTipCents(baseTotals.total_cents)) {
    return NextResponse.json(
      { error: "Tip amount is too large." },
      { status: 422 },
    );
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
  const contactName = cleanText(body.customer.name, 120);
  const contactPhone = cleanText(body.customer.phone, 40);
  const customer = await ensureCustomer({
    tenantId,
    email: body.customer.email,
    name: contactName,
    phone: contactPhone,
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
    tipCents,
  });
  totals.total_cents += deliveryFeeCents;

  const orderFulfillment: OrderFulfillment = {
    type: body.fulfillmentType,
    scheduled_for: body.scheduledFor,
    promised_at: promisedAt,
    // Per-order contact (what the customer typed now), independent of the
    // stored customer record.
    contact: { name: contactName, phone: contactPhone },
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
    items: activeItems,
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

  // Don't echo the stored customer record (name/phone/verified) back to
  // whoever typed this email — only the id the client needs.
  return NextResponse.json(
    { order, customer: { id: customer.id }, delivery },
    { status: 201 },
  );
}
