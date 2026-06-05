/**
 * Delivery service (server-side) — the single orchestration point for quoting,
 * dispatching, assigning, and tracking deliveries against an order. Used by the
 * delivery API routes + the online-order intake. Talks to providers through the
 * registry and persists `DeliveryRecord`s through the DB abstraction.
 *
 * PROVIDER SELECTION: a location's `fulfillment.delivery_providers` lists the
 * providers it offers in preference order; `pickProvider` returns the first one
 * that is registered/available. The in-house provider is always available; the
 * DoorDash provider is always registered but runs simulated when unkeyed.
 *
 * IDEMPOTENCY: dispatch is keyed by the order id — re-dispatching an order
 * returns the existing DeliveryRecord rather than creating a second delivery.
 */
import "./providers";
import { getPosDriver } from "@/lib/db";
import type { DeliveryAddress, DeliveryRecord } from "@/lib/db";
import type {
  Address,
  Delivery,
  DeliveryProviderKey,
  DeliveryQuote,
  DeliveryStatus,
} from "./DeliveryProvider";
import {
  getDeliveryProvider,
  isDeliveryProviderAvailable,
} from "./registry";

function nowIso(): string {
  return new Date().toISOString();
}

/** Translate our DB DeliveryAddress to the provider Address shape. */
export function toProviderAddress(a: DeliveryAddress): Address {
  return {
    line1: a.line1,
    line2: a.line2,
    city: a.city,
    region: a.region,
    postalCode: a.postal_code,
    country: a.country,
  };
}

/** Map a provider DeliveryStatus to the persisted DeliveryRecord status. */
export function mapToRecordStatus(
  providerKey: DeliveryProviderKey,
  status: DeliveryStatus,
): DeliveryRecord["status"] {
  // In-house "dispatched" really means "waiting for a dispatcher to assign".
  if (providerKey === "in_house_manual" && status === "dispatched") {
    return "pending_assignment";
  }
  return status;
}

/**
 * Resolve the provider a location should use: the first entry in its configured
 * preference list that is registered/available. Returns null if none configured
 * or available (delivery effectively disabled).
 */
export async function pickProvider(
  tenantId: string,
  locationId: string,
): Promise<DeliveryProviderKey | null> {
  const driver = getPosDriver();
  const settings = await driver.getStoreSettings(tenantId, locationId);
  const configured = (settings.fulfillment?.delivery_providers ??
    []) as DeliveryProviderKey[];
  for (const key of configured) {
    if (isDeliveryProviderAvailable(key)) return key;
  }
  return null;
}

export interface QuoteDeliveryInput {
  tenantId: string;
  locationId: string;
  dropoff: DeliveryAddress;
  pickup: DeliveryAddress;
  subtotalCents: number;
  currency: string;
  scheduledFor?: string;
  /** Force a specific provider; otherwise the location's preferred one is used. */
  provider?: DeliveryProviderKey;
}

export interface QuotedDelivery {
  provider: DeliveryProviderKey;
  quote: DeliveryQuote;
}

/**
 * Quote a delivery via the location's provider. Throws
 * `DeliveryUnavailableError` (re-exported from `./errors`) when out of zone /
 * below minimum, and a plain Error when no provider is available.
 */
export async function quoteDelivery(
  input: QuoteDeliveryInput,
): Promise<QuotedDelivery> {
  const providerKey =
    input.provider ?? (await pickProvider(input.tenantId, input.locationId));
  if (!providerKey) throw new Error("Delivery is not available at this location.");
  const provider = getDeliveryProvider(providerKey);
  if (!provider) throw new Error(`Delivery provider not available: ${providerKey}`);

  const quote = await provider.quote({
    context: {
      tenantId: input.tenantId,
      locationId: input.locationId,
      idempotencyKey: `quote_${input.tenantId}_${input.locationId}`,
    },
    pickup: toProviderAddress(input.pickup),
    dropoff: toProviderAddress(input.dropoff),
    orderTotal: { amount: input.subtotalCents, currency: input.currency },
    scheduledFor: input.scheduledFor,
  });
  return { provider: providerKey, quote };
}

export interface DispatchDeliveryInput {
  orderId: string;
  tenantId: string;
  locationId: string;
  provider: DeliveryProviderKey;
  pickup: DeliveryAddress;
  dropoff: DeliveryAddress;
  zoneId: string | null;
  feeCents: number;
  currency: string;
  etaMinutes: number | null;
  quoteId?: string;
  scheduledFor?: string;
}

/**
 * Dispatch a delivery for a placed order and persist a DeliveryRecord. Idempotent
 * on the order id: a delivery already exists → return it unchanged.
 */
export async function dispatchDelivery(
  input: DispatchDeliveryInput,
): Promise<DeliveryRecord> {
  const driver = getPosDriver();
  const existing = await driver.getDeliveryForOrder(input.orderId);
  if (existing) return existing;

  const provider = getDeliveryProvider(input.provider);
  if (!provider) throw new Error(`Delivery provider not available: ${input.provider}`);

  const recordId =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `del-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  const result: Delivery = await provider.dispatch({
    context: {
      tenantId: input.tenantId,
      locationId: input.locationId,
      idempotencyKey: input.orderId,
    },
    orderId: input.orderId,
    pickup: toProviderAddress(input.pickup),
    dropoff: toProviderAddress(input.dropoff),
    quoteId: input.quoteId,
    scheduledFor: input.scheduledFor,
  });

  const record: DeliveryRecord = {
    id: recordId,
    order_id: input.orderId,
    tenant_id: input.tenantId,
    location_id: input.locationId,
    provider: input.provider,
    status: mapToRecordStatus(input.provider, result.status),
    zone_id: input.zoneId,
    fee_cents: result.fee?.amount ?? input.feeCents,
    currency: input.currency,
    eta_minutes: result.etaMinutes ?? input.etaMinutes,
    provider_delivery_id: result.deliveryId,
    tracking_ref: result.trackingRef ?? null,
    dropoff: input.dropoff,
    driver_name: result.driverName ?? null,
    driver_phone: result.driverPhone ?? null,
    simulated: result.trackingRef?.startsWith("sim://") ?? false,
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  return driver.upsertDelivery(record);
}

/**
 * Refresh a delivery's live state from its provider and persist it. For an
 * in-house delivery still `pending_assignment`, we DON'T overwrite with the
 * provider's simulated "assigned" state — assignment is a manual /admin action.
 */
export async function refreshDelivery(
  deliveryId: string,
): Promise<DeliveryRecord | null> {
  const driver = getPosDriver();
  const record = await driver.getDelivery(deliveryId);
  if (!record) return null;
  if (
    record.status === "delivered" ||
    record.status === "canceled" ||
    record.status === "pending_assignment"
  ) {
    return record;
  }
  // In-house deliveries are managed entirely by the platform (manual assignment
  // in /admin); the provider's track() returns only a SIMULATED driver, so we
  // never overlay it onto the authoritative DeliveryRecord. External providers
  // (DoorDash) own their tracking, so we pull their live state.
  if (record.provider === "in_house_manual") return record;
  const provider = getDeliveryProvider(record.provider as DeliveryProviderKey);
  if (!provider || !record.provider_delivery_id) return record;

  const live = await provider.track(
    {
      tenantId: record.tenant_id,
      locationId: record.location_id,
      idempotencyKey: record.order_id,
    },
    record.provider_delivery_id,
  );
  const status = mapToRecordStatus(
    record.provider as DeliveryProviderKey,
    live.status,
  );
  if (
    status === record.status &&
    (live.driverName ?? null) === record.driver_name
  ) {
    return record;
  }
  return driver.upsertDelivery({
    ...record,
    status,
    driver_name: live.driverName ?? record.driver_name,
    driver_phone: live.driverPhone ?? record.driver_phone,
    tracking_ref: live.trackingRef ?? record.tracking_ref,
  });
}

/**
 * Manual driver assignment (in-house dispatch, from /admin). Moves a
 * `pending_assignment` delivery to `assigned` with the given driver and flips
 * the order to `out_for_delivery` so the KDS + customer tracker reflect it.
 */
export async function assignDriver(input: {
  deliveryId: string;
  driverName: string;
  driverPhone?: string;
}): Promise<DeliveryRecord | null> {
  const driver = getPosDriver();
  const record = await driver.getDelivery(input.deliveryId);
  if (!record) return null;
  const updated = await driver.upsertDelivery({
    ...record,
    status: "assigned",
    driver_name: input.driverName,
    driver_phone: input.driverPhone ?? record.driver_phone,
  });
  await driver.updateOrderStatus(record.order_id, "out_for_delivery");
  return updated;
}
