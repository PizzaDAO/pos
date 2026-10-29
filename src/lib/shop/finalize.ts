/**
 * [SHARED: online checkout + terminal card reader] finalizeOnlinePayment.
 *
 * An ONLINE order is created `awaiting_payment`: invisible to the KDS, with no
 * inventory depleted and no delivery dispatched. The moment its settled tenders
 * cover the amount due, THIS function makes the order real:
 *
 *   1. Compare-and-set `awaiting_payment -> paid` (`transitionOrderStatus`). Only
 *      the single winner continues, so the Stripe webhook, the client sync, the
 *      watcher and the sweeper can all call this concurrently and the side
 *      effects below still run exactly once.
 *   2. ASAP orders get `promised_at` recomputed from NOW (prep starts at
 *      payment, not at checkout). Written in the same atomic update as (1).
 *   3. Inventory is depleted (skipped by `createOrder` for awaiting orders).
 *   4. A delivery order is dispatched from the quote persisted on the order
 *      (`fulfillment.delivery_provider` / `zone_id` / `eta_minutes`). If dispatch
 *      fails the order stays `paid` (and on the KDS); a `failed` delivery record
 *      is written so the failure is visible in admin dispatch.
 *
 * The terminal card-reader plan reuses this for its own transitions: call it from
 * any settlement path once covered tenders are settled.
 *
 * Idempotent and safe to call for an order in any state: a non-awaiting order
 * returns `{ won: false }` and does nothing.
 */
import { getPosDriver } from "@/lib/db";
import type {
  DeliveryAddress,
  DeliveryRecord,
  Order,
  OrderFulfillment,
} from "@/lib/db";
import type { DeliveryProviderKey } from "@/lib/delivery";
import { dispatchDelivery } from "@/lib/delivery/service";
import { captureError } from "@/lib/observability";
import { asapPromisedAt } from "./scheduling";

export interface FinalizeResult {
  /** The order after the call (null if it does not exist). */
  order: Order | null;
  /** True only for the one caller that performed the `awaiting_payment -> paid` move. */
  won: boolean;
}

export async function finalizeOnlinePayment(
  orderId: string,
): Promise<FinalizeResult> {
  const driver = getPosDriver();
  const order = await driver.getOrder(orderId);
  if (!order) return { order: null, won: false };
  if (order.status !== "awaiting_payment") return { order, won: false };

  const settings = await driver.getStoreSettings(
    order.tenant_id,
    order.location_id,
  );

  // (2) ASAP: prep starts at payment. A scheduled order keeps its slot.
  let fulfillmentPatch: OrderFulfillment | undefined;
  if (order.fulfillment?.scheduled_for === "asap" && settings.fulfillment) {
    fulfillmentPatch = {
      ...order.fulfillment,
      promised_at: asapPromisedAt(settings.fulfillment, new Date()).toISOString(),
    };
  }

  // (1) Compare-and-set. Losers stop here.
  const paid = await driver.transitionOrderStatus(
    orderId,
    ["awaiting_payment"],
    "paid",
    fulfillmentPatch ? { fulfillment: fulfillmentPatch } : undefined,
  );
  if (!paid) return { order: (await driver.getOrder(orderId)) ?? order, won: false };

  // (3) Inventory. A failure must not un-pay the order; surface it.
  try {
    await driver.depleteInventoryForOrder(orderId);
  } catch (err) {
    captureError(err, { scope: "finalizeOnlinePayment.deplete", orderId });
    console.error(`[finalize] inventory depletion failed for ${orderId}`, err);
  }

  // (4) Delivery dispatch from the persisted quote.
  const f = paid.fulfillment;
  if (f?.type === "delivery" && f.address && f.delivery_provider) {
    const pickup: DeliveryAddress = {
      line1: settings.fulfillment?.pickup_address ?? "Pickup",
      city: "",
      region: "",
      postal_code: "",
      country: "US",
    };
    try {
      await dispatchDelivery({
        orderId,
        tenantId: paid.tenant_id,
        locationId: paid.location_id,
        provider: f.delivery_provider as DeliveryProviderKey,
        pickup,
        dropoff: f.address,
        zoneId: f.zone_id ?? null,
        feeCents: f.delivery_fee_cents ?? 0,
        currency: paid.currency,
        etaMinutes: f.eta_minutes ?? null,
        scheduledFor: f.scheduled_for === "asap" ? undefined : f.scheduled_for,
      });
    } catch (err) {
      captureError(err, { scope: "finalizeOnlinePayment.dispatch", orderId });
      console.error(`[finalize] delivery dispatch failed for ${orderId}`, err);
      await recordFailedDispatch(paid, f).catch(() => undefined);
    }
  }

  return { order: paid, won: true };
}

/** A `failed` delivery record so the dispatcher sees the order needs attention. */
async function recordFailedDispatch(
  order: Order,
  f: OrderFulfillment,
): Promise<void> {
  const driver = getPosDriver();
  if (!f.address) return;
  if (await driver.getDeliveryForOrder(order.id)) return;
  const now = new Date().toISOString();
  const record: DeliveryRecord = {
    id: crypto.randomUUID(),
    order_id: order.id,
    tenant_id: order.tenant_id,
    location_id: order.location_id,
    provider: f.delivery_provider ?? "in_house_manual",
    status: "failed",
    zone_id: f.zone_id ?? null,
    fee_cents: f.delivery_fee_cents ?? 0,
    currency: order.currency,
    eta_minutes: f.eta_minutes ?? null,
    provider_delivery_id: null,
    tracking_ref: null,
    dropoff: f.address,
    driver_name: null,
    driver_phone: null,
    simulated: false,
    created_at: now,
    updated_at: now,
  };
  await driver.upsertDelivery(record);
}
