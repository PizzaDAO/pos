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
  OrderStatus,
} from "@/lib/db";
import type { DeliveryProviderKey } from "@/lib/delivery";
import { dispatchDelivery, quoteDelivery } from "@/lib/delivery/service";
import { captureError } from "@/lib/observability";
import { asapPromisedAt } from "./scheduling";

/** A quote with no stated expiry is trusted for this long after checkout. */
const QUOTE_FALLBACK_TTL_MS = 15 * 60_000;

export interface FinalizeResult {
  /** The order after the call (null if it does not exist). */
  order: Order | null;
  /** True only for the one caller that performed the move to `paid`. */
  won: boolean;
}

export interface FinalizeOptions {
  /**
   * Statuses the order may be promoted FROM (default `awaiting_payment`). The
   * admin "accept late payment" action passes `["abandoned"]`.
   */
  from?: OrderStatus[];
  /** Extra fulfillment keys written in the SAME atomic update (e.g. resolving a late payment). */
  fulfillmentExtra?: Partial<OrderFulfillment>;
}

export async function finalizeOnlinePayment(
  orderId: string,
  opts: FinalizeOptions = {},
): Promise<FinalizeResult> {
  const driver = getPosDriver();
  const from = opts.from ?? ["awaiting_payment"];
  const order = await driver.getOrder(orderId);
  if (!order) return { order: null, won: false };
  if (!from.includes(order.status) || !order.fulfillment) {
    return { order, won: false };
  }

  const settings = await driver.getStoreSettings(
    order.tenant_id,
    order.location_id,
  );

  // (2) ASAP: prep starts at payment. A scheduled order keeps its slot. `paid_at`
  // marks the promotion; `finalized_at` (set after the steps below) marks that the
  // post-payment steps completed, so a crash in between is recoverable.
  const now = new Date();
  const fulfillmentPatch: OrderFulfillment = {
    ...order.fulfillment,
    ...opts.fulfillmentExtra,
    paid_at: now.toISOString(),
    finalized_at: undefined,
  };
  delete fulfillmentPatch.finalized_at;
  if (order.fulfillment.scheduled_for === "asap" && settings.fulfillment) {
    fulfillmentPatch.promised_at = asapPromisedAt(
      settings.fulfillment,
      now,
    ).toISOString();
  }

  // (1) Compare-and-set. Losers stop here.
  const paid = await driver.transitionOrderStatus(orderId, from, "paid", {
    fulfillment: fulfillmentPatch,
  });
  if (!paid) {
    return { order: (await driver.getOrder(orderId)) ?? order, won: false };
  }

  await runPostPaymentSteps(paid);
  return { order: (await driver.getOrder(orderId)) ?? paid, won: true };
}

/**
 * Steps (3) and (4): deplete inventory and dispatch the delivery, then stamp
 * `fulfillment.finalized_at`. IDEMPOTENT -- depletion skips an order that already
 * has depletion movements, `dispatchDelivery` returns an existing delivery -- so
 * the crash-recovery sweep (`recoverUnfinalizedOrders`) re-runs it safely for an
 * order whose process died after the compare-and-set.
 *
 * A depletion failure leaves `finalized_at` unset (the sweep retries and alerts).
 * A dispatch failure is surfaced via a `failed` delivery record + alert and does
 * NOT block `finalized_at` (retrying a persistently failing provider forever would
 * not help; the dispatcher handles the failed record).
 */
export async function runPostPaymentSteps(paid: Order): Promise<boolean> {
  const driver = getPosDriver();
  const orderId = paid.id;
  let ok = true;

  // (3) Inventory. A failure must not un-pay the order; surface it.
  try {
    await driver.depleteInventoryForOrder(orderId);
  } catch (err) {
    ok = false;
    captureError(err, { scope: "finalizeOnlinePayment.deplete", orderId });
    console.error(`[finalize] inventory depletion failed for ${orderId}`, err);
  }

  // (4) Delivery dispatch from the persisted quote.
  const f = paid.fulfillment;
  if (f?.type === "delivery" && f.address && f.delivery_provider) {
    const settings = await driver.getStoreSettings(
      paid.tenant_id,
      paid.location_id,
    );
    const pickup: DeliveryAddress = {
      line1: settings.fulfillment?.pickup_address ?? "Pickup",
      city: "",
      region: "",
      postal_code: "",
      country: "US",
    };
    try {
      let quoteId = f.zone_id;
      let etaMinutes = f.eta_minutes ?? null;
      // The quote was taken at checkout. A LATE payment (admin Accept, a slow
      // crypto confirmation) may outlive it: re-quote with the same provider and
      // dispatch on the fresh quote. The customer's fee stays what they paid.
      const expiresAt = f.quote_expires_at
        ? new Date(f.quote_expires_at).getTime()
        : new Date(paid.created_at).getTime() + QUOTE_FALLBACK_TTL_MS;
      if (Date.now() > expiresAt) {
        const fresh = await quoteDelivery({
          tenantId: paid.tenant_id,
          locationId: paid.location_id,
          dropoff: f.address,
          pickup,
          subtotalCents: paid.totals.subtotal_cents,
          currency: paid.currency,
          scheduledFor: f.scheduled_for === "asap" ? undefined : f.scheduled_for,
          provider: f.delivery_provider as DeliveryProviderKey,
        });
        quoteId = fresh.quote.quoteId ?? quoteId;
        etaMinutes = fresh.quote.etaMinutes ?? etaMinutes;
        await driver.mergeOrderFulfillment(orderId, {
          zone_id: quoteId,
          eta_minutes: etaMinutes,
          quote_expires_at: fresh.quote.expiresAt,
        });
      }
      await dispatchDelivery({
        orderId,
        tenantId: paid.tenant_id,
        locationId: paid.location_id,
        provider: f.delivery_provider as DeliveryProviderKey,
        pickup,
        dropoff: f.address,
        zoneId: f.zone_id ?? null,
        quoteId,
        feeCents: f.delivery_fee_cents ?? 0,
        currency: paid.currency,
        etaMinutes,
        scheduledFor: f.scheduled_for === "asap" ? undefined : f.scheduled_for,
      });
    } catch (err) {
      captureError(err, { scope: "finalizeOnlinePayment.dispatch", orderId });
      console.error(`[finalize] delivery dispatch failed for ${orderId}`, err);
      await recordFailedDispatch(paid, f).catch(() => undefined);
    }
  }

  if (ok) {
    await driver.mergeOrderFulfillment(orderId, {
      finalized_at: new Date().toISOString(),
    });
  }
  return ok;
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
