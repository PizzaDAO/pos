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
import type { DeliveryDispatchRequest } from "@openpizza/core";
import { getPosDriver } from "@/lib/db";
import type { DeliveryAddress, DeliveryRecord } from "@/lib/db";
import { loadDelivery } from "@/lib/core/loaders";
import { captureError } from "@/lib/observability";
import { recordAudit } from "@/lib/security";
import { DriverDispatchError } from "./providers/openpizza-driver";
import { isDriverTenant } from "./driver-hub";
import { DRIVER_CONFLICT_MARK } from "./attention";
import type {
  Address,
  Delivery,
  DeliveryProviderKey,
  DeliveryQuote,
  DeliveryStatus,
} from "./DeliveryProvider";
import { getDeliveryProvider, isDeliveryProviderAvailable } from "./registry";

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
    if (!isDeliveryProviderAvailable(key)) continue;
    // A provider with a gate (the driver module) must also say it is usable now;
    // otherwise the location falls through to its next provider.
    const gate = getDeliveryProvider(key)?.available;
    if (
      gate &&
      !(await gate.call(getDeliveryProvider(key), tenantId, locationId))
    ) {
      continue;
    }
    return key;
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
  if (!providerKey)
    throw new Error("Delivery is not available at this location.");
  const provider = getDeliveryProvider(providerKey);
  if (!provider)
    throw new Error(`Delivery provider not available: ${providerKey}`);

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
  if (existing) {
    // A driver dispatch that never got confirmed is a retry, not a duplicate.
    return isUnconfirmedDriverDispatch(existing)
      ? attemptDriverDispatch(existing)
      : existing;
  }

  const provider = getDeliveryProvider(input.provider);
  if (!provider)
    throw new Error(`Delivery provider not available: ${input.provider}`);

  if (input.provider === "openpizza_driver") {
    return dispatchViaDriver(input);
  }

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
  try {
    return await driver.upsertDelivery(record);
  } catch (err) {
    // One delivery per order is a DB constraint (deliveries_order_id_uidx): a
    // concurrent dispatch (e.g. the crash-recovery sweep racing a late finalize)
    // lost the insert. The winner's record is THE delivery.
    if (
      err instanceof Error &&
      err.message.includes("deliveries_order_id_uidx")
    ) {
      const winner = await driver.getDeliveryForOrder(input.orderId);
      if (winner) return winner;
    }
    throw err;
  }
}

/**
 * Cancel the delivery attached to an order (e.g. the order was voided before
 * payment). Cancels with the provider when it owns the delivery, then marks the
 * record `canceled`. No-op when there is no (live) delivery.
 */
export async function cancelDeliveryForOrder(
  orderId: string,
): Promise<DeliveryRecord | null> {
  const driver = getPosDriver();
  const record = await driver.getDeliveryForOrder(orderId);
  if (
    !record ||
    record.status === "canceled" ||
    record.status === "delivered"
  ) {
    return record;
  }
  const provider = getDeliveryProvider(record.provider as DeliveryProviderKey);
  if (provider && record.provider_delivery_id) {
    if (record.provider === "openpizza_driver") {
      // The driver owns this delivery: only a confirmed cancel marks it canceled.
      // A refusal (409: already picked up) or an unreachable driver leaves it live
      // (the order.canceled event still reaches the driver); the reason is stored
      // for the admin board.
      try {
        await provider.cancel(
          {
            tenantId: record.tenant_id,
            locationId: record.location_id,
            idempotencyKey: record.id,
          },
          record.provider_delivery_id,
        );
      } catch (err) {
        const message =
          err instanceof DriverDispatchError && !err.retryable
            ? `cancel refused (${err.status ?? "?"}): ${err.message}`
            : `cancel not confirmed: ${err instanceof Error ? err.message : String(err)}`;
        const res = await driver.updateDriverDispatch(
          record.id,
          record.tenant_id,
          {
            expect_status: record.status,
            dispatch_error: message.slice(0, 500),
          },
        );
        console.error(`[pos][ALERT] ${message} (delivery ${record.id})`);
        return res.ok ? res.delivery : (res.delivery ?? record);
      }
    } else {
      await provider.cancel(
        {
          tenantId: record.tenant_id,
          locationId: record.location_id,
          idempotencyKey: record.order_id,
        },
        record.provider_delivery_id,
      );
    }
  }
  // Compare-and-set: a delivery that finished meanwhile (the partner reported
  // delivered, say) is returned as it is, never overwritten from this stale copy.
  const res = await driver.transitionDelivery(record.id, record.tenant_id, {
    status: "canceled",
  });
  if (res.ok || res.reason === "terminal") return res.delivery;
  return null;
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
  // Partner-driven providers (the driver module) push their state through
  // `deliveries.updateStatus`; there is nothing to pull.
  if (
    record.provider === "in_house_manual" ||
    record.provider === "openpizza_driver"
  ) {
    return record;
  }
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
  const res = await driver.transitionDelivery(record.id, record.tenant_id, {
    status,
    driver_name: live.driverName ?? record.driver_name,
    driver_phone: live.driverPhone ?? record.driver_phone,
    tracking_ref: live.trackingRef ?? record.tracking_ref,
  });
  if (res.ok || res.reason === "terminal") return res.delivery;
  return null;
}

/** `assignDriver` refused: the delivery is run by another provider. */
export class DeliveryNotAssignableError extends Error {
  constructor(readonly provider: string) {
    super(
      `This delivery is run by ${provider}; it cannot be assigned by hand.`,
    );
    this.name = "DeliveryNotAssignableError";
  }
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
  // Only an in-house delivery is assigned by hand: a driver-run (or DoorDash)
  // delivery has its own state, and a hand-assignment would fork it.
  if (record.provider !== "in_house_manual") {
    throw new DeliveryNotAssignableError(record.provider);
  }
  const res = await driver.transitionDelivery(record.id, record.tenant_id, {
    status: "assigned",
    driver_name: input.driverName,
    driver_phone: input.driverPhone ?? record.driver_phone,
  });
  // A finished delivery cannot be assigned (nor its order moved back).
  if (!res.ok) return null;
  await driver.updateOrderStatus(record.order_id, "out_for_delivery");
  return res.delivery;
}

// ---------------------------------------------------------------------------
// Outbound dispatch to the Open Pizza driver module
// ---------------------------------------------------------------------------

/** The sweep waits this long before it retries a fresh `quoted` record. */
export const DRIVER_RETRY_MIN_AGE_MS = 30_000;
/** After this long without a confirmed dispatch the record is failed (and alerted). */
export const DRIVER_GIVE_UP_MS = 15 * 60_000;
/** The manual-fallback button is held this long on a record with no provider id. */
/** Total wall-clock budget of one sweep (the cron has maxDuration 60 s). */
export const DRIVER_SWEEP_BUDGET_MS = 20_000;
/** A parked conflict row is looked at again this long after it was parked / last alerted. */
export const CONFLICT_RECHECK_MS = 60 * 60_000;
export const DRIVER_MANUAL_HOLD_MS = 2 * 60_000;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 5 * 60_000;

function isUnconfirmedDriverDispatch(r: DeliveryRecord): boolean {
  return (
    r.provider === "openpizza_driver" &&
    r.status === "quoted" &&
    r.provider_delivery_id === null
  );
}

/** Insert the record as `quoted` FIRST (the driver reports back by its id), then call the driver. */
async function dispatchViaDriver(
  input: DispatchDeliveryInput,
): Promise<DeliveryRecord> {
  const driver = getPosDriver();
  const id =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `del-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const record: DeliveryRecord = {
    id,
    order_id: input.orderId,
    tenant_id: input.tenantId,
    location_id: input.locationId,
    provider: input.provider,
    status: "quoted",
    zone_id: input.zoneId,
    fee_cents: input.feeCents,
    currency: input.currency,
    eta_minutes: input.etaMinutes,
    provider_delivery_id: null,
    tracking_ref: null,
    dropoff: input.dropoff,
    driver_name: null,
    driver_phone: null,
    simulated: false,
    dispatch_attempts: 0,
    dispatch_error: null,
    dispatch_next_at: null,
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  let stored: DeliveryRecord;
  try {
    stored = await driver.upsertDelivery(record);
  } catch (err) {
    // deliveries_order_id_uidx: a concurrent dispatch won the insert; its record is THE delivery.
    if (
      err instanceof Error &&
      err.message.includes("deliveries_order_id_uidx")
    ) {
      const winner = await driver.getDeliveryForOrder(input.orderId);
      if (winner) return winner;
    }
    throw err;
  }
  return attemptDriverDispatch(stored);
}

function backoffMs(attempts: number): number {
  return Math.min(
    BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1),
    BACKOFF_MAX_MS,
  );
}

/** The contract dispatch body: only fields fixed at payment time (no `ready`, no `pickup`). */
async function buildDriverPayload(
  record: DeliveryRecord,
): Promise<DeliveryDispatchRequest | null> {
  const d = await loadDelivery(record.tenant_id, record.id);
  if (!d) return null;
  return {
    delivery_id: record.id,
    order_id: record.order_id,
    location_id: record.location_id,
    source: "pos",
    fee_cents: d.fee_cents,
    tip_cents: d.tip_cents,
    amount_due_cents: d.amount_due_cents,
    promised_at: d.promised_at ?? null,
    dropoff: {
      address: d.dropoff.address,
      contact: d.dropoff.contact ?? null,
      notes: d.dropoff.notes ?? null,
    },
    items_summary: d.items_summary ?? null,
    high_value: false,
  } as DeliveryDispatchRequest;
}

async function failDriverDispatch(
  record: DeliveryRecord,
  attempts: number,
  message: string,
): Promise<DeliveryRecord> {
  console.error(
    `[pos][ALERT] driver dispatch failed for delivery ${record.id} (order ${record.order_id}): ${message}`,
  );
  const res = await getPosDriver().updateDriverDispatch(
    record.id,
    record.tenant_id,
    {
      expect_status: "quoted",
      status: "failed",
      dispatch_attempts: attempts,
      dispatch_error: message.slice(0, 500),
      dispatch_next_at: null,
    },
  );
  return res.ok ? res.delivery : (res.delivery ?? record);
}

/**
 * One attempt to hand a `quoted` driver delivery to the driver module.
 * Never throws for a driver outcome: the result is the stored record.
 *   200/201            -> `dispatched` (or the newer status the driver already pushed)
 *   timeout/network/5xx/429 -> stays `quoted`, attempts + 1, retried by the sweep
 *   other 4xx          -> `failed` + [pos][ALERT], never retried
 * Retries send the identical body and the same Idempotency-Key.
 */
export async function attemptDriverDispatch(
  record: DeliveryRecord,
): Promise<DeliveryRecord> {
  const driver = getPosDriver();
  const provider = getDeliveryProvider("openpizza_driver");
  const attempts = (record.dispatch_attempts ?? 0) + 1;
  if (!provider)
    return failDriverDispatch(record, attempts, "provider not registered");

  // Re-read right before calling out: a person may have switched it to manual, or
  // the order may have been canceled, since this copy was read.
  const fresh = await driver.getDelivery(record.id);
  if (
    !fresh ||
    fresh.provider !== "openpizza_driver" ||
    fresh.status !== "quoted" ||
    // Waiting on the driver's push after a 409: do not send it again.
    fresh.dispatch_error === DRIVER_CONFLICT_MARK
  ) {
    return fresh ?? record;
  }

  const payload = await buildDriverPayload(record);
  if (!payload) {
    return failDriverDispatch(record, attempts, "order or location not found");
  }
  const dropoff = toProviderAddress(record.dropoff);
  try {
    const result = await provider.dispatch({
      context: {
        tenantId: record.tenant_id,
        locationId: record.location_id,
        idempotencyKey: `pos-delivery:${record.id}`,
      },
      orderId: record.order_id,
      // The driver reads the pickup from the location itself.
      pickup: {
        line1: "",
        city: "",
        region: "",
        postalCode: "",
        country: "US",
      },
      dropoff,
      deliveryId: record.id,
      payload,
    });
    const res = await driver.updateDriverDispatch(record.id, record.tenant_id, {
      expect_status: "quoted",
      status: mapToRecordStatus("openpizza_driver", result.status),
      provider_delivery_id: result.deliveryId,
      tracking_ref: result.trackingRef ?? null,
      eta_minutes: result.etaMinutes ?? record.eta_minutes,
      driver_name: result.driverName ?? null,
      driver_phone: result.driverPhone ?? null,
      dispatch_attempts: attempts,
      dispatch_error: null,
      dispatch_next_at: null,
    });
    if (res.ok) return res.delivery;
    // The record moved meanwhile: the driver's own push already advanced it (keep
    // that newer status), or a person switched it. Fill in the ids only if still
    // missing on a live driver record.
    const cur = res.delivery;
    if (
      !cur ||
      cur.provider !== "openpizza_driver" ||
      cur.status === "canceled" ||
      cur.status === "failed"
    ) {
      // The driver accepted a delivery POS no longer wants (canceled, failed, or
      // switched to manual meanwhile): cancel it there so no courier is sent twice.
      console.error(
        `[pos][ALERT] driver accepted delivery ${record.id} (driver id ${result.deliveryId}) after POS moved on (${cur ? `${cur.provider}/${cur.status}` : "row gone"}); canceling it at the driver`,
      );
      try {
        await provider.cancel(
          {
            tenantId: record.tenant_id,
            locationId: record.location_id,
            idempotencyKey: record.id,
          },
          result.deliveryId,
        );
      } catch (cancelErr) {
        console.error(
          `[pos][ALERT] could not cancel orphaned driver delivery ${result.deliveryId} for ${record.id}: ${cancelErr instanceof Error ? cancelErr.message : String(cancelErr)}`,
        );
      }
      return cur ?? record;
    }
    if (
      cur &&
      cur.provider === "openpizza_driver" &&
      cur.provider_delivery_id === null &&
      !["delivered", "canceled", "failed"].includes(cur.status)
    ) {
      const fill = await driver.updateDriverDispatch(cur.id, cur.tenant_id, {
        expect_status: cur.status,
        provider_delivery_id: result.deliveryId,
        tracking_ref: cur.tracking_ref ?? result.trackingRef ?? null,
        dispatch_attempts: attempts,
      });
      return fill.ok ? fill.delivery : (fill.delivery ?? cur);
    }
    return cur ?? record;
  } catch (err) {
    const e =
      err instanceof DriverDispatchError
        ? err
        : new DriverDispatchError(
            err instanceof Error ? err.message : String(err),
            true,
          );
    if (e.conflict) {
      // The driver may already hold it. Re-read: if its status push landed (it
      // carries the provider id) keep that; otherwise park it as `quoted` and wait.
      const cur = await driver.getDelivery(record.id);
      if (cur && cur.provider_delivery_id !== null) return cur;
      console.error(
        `[pos][ALERT] driver answered 409 to the dispatch of delivery ${record.id} (order ${record.order_id}); it may already hold it, waiting for its status push`,
      );
      const res = await driver.updateDriverDispatch(record.id, record.tenant_id, {
        expect_status: "quoted",
        dispatch_attempts: attempts,
        dispatch_error: DRIVER_CONFLICT_MARK,
        // Parked: the sweep looks at it again in an hour (no starvation of others).
        dispatch_next_at: new Date(Date.now() + CONFLICT_RECHECK_MS).toISOString(),
      });
      return res.ok ? res.delivery : (res.delivery ?? record);
    }
    if (!e.retryable) {
      return failDriverDispatch(
        record,
        attempts,
        `driver refused (${e.status ?? "?"}): ${e.message}`,
      );
    }
    const res = await driver.updateDriverDispatch(record.id, record.tenant_id, {
      expect_status: "quoted",
      dispatch_attempts: attempts,
      dispatch_error: e.message.slice(0, 500),
      dispatch_next_at: new Date(
        Date.now() + backoffMs(attempts),
      ).toISOString(),
    });
    return res.ok ? res.delivery : (res.delivery ?? record);
  }
}

export interface DriverSweepSummary {
  retried: number;
  dispatched: number;
  failed: number;
}

/**
 * Cron sweep: retry unconfirmed driver dispatches (30 s old or older, backoff
 * honoured) with the SAME key; after 15 minutes give up (`failed` + alert).
 * Does nothing when no driver delivery is waiting (so it is free when inert).
 */
export async function sweepDriverDispatches(
  now: Date = new Date(),
  limit = 10,
  budgetMs = DRIVER_SWEEP_BUDGET_MS,
): Promise<DriverSweepSummary> {
  const driver = getPosDriver();
  const summary: DriverSweepSummary = { retried: 0, dispatched: 0, failed: 0 };
  const startedAt = Date.now();
  const due = await driver.listDriverDispatchRetries(now.toISOString(), limit);
  for (const rec of due) {
    // Total time budget: each driver call can take its full timeout.
    if (Date.now() - startedAt >= budgetMs) break;
    if (rec.provider_delivery_id !== null) continue;
    const age = now.getTime() - new Date(rec.created_at).getTime();
    try {
      if (rec.dispatch_error === DRIVER_CONFLICT_MARK) {
        // Never auto-fail or re-send: the driver may hold it. Alert only (not for
        // an order that is already closed), then look again in an hour.
        const order = await driver.getOrder(rec.order_id);
        const closed =
          !order ||
          ["refunded", "voided", "abandoned", "completed"].includes(order.status);
        if (closed) {
          // The driver never confirmed it (no provider id): retire it locally
          // instead of pushing the row out another hour. Compare-and-set on
          // `quoted`, so a row the driver's push just moved is left alone.
          const res = await driver.updateDriverDispatch(rec.id, rec.tenant_id, {
            expect_status: "quoted",
            status: "canceled",
            dispatch_next_at: null,
          });
          if (!res.ok && res.delivery?.provider_delivery_id)
            console.error(
              `[pos][ALERT] delivery ${rec.id} on closed order ${rec.order_id} was picked up by the driver during the sweep; cancel it with the driver`,
            );
          continue;
        }
        if (!closed && age >= DRIVER_GIVE_UP_MS) {
          console.error(
            `[pos][ALERT] delivery ${rec.id} (order ${rec.order_id}) still waiting for the driver's status push after a dispatch 409`,
          );
        }
        await driver.updateDriverDispatch(rec.id, rec.tenant_id, {
          expect_status: "quoted",
          dispatch_next_at: new Date(
            now.getTime() + CONFLICT_RECHECK_MS,
          ).toISOString(),
        });
        continue;
      }
      if (age >= DRIVER_GIVE_UP_MS) {
        await failDriverDispatch(
          rec,
          rec.dispatch_attempts ?? 0,
          `gave up after ${Math.round(DRIVER_GIVE_UP_MS / 60_000)} min: ${rec.dispatch_error ?? "no answer from the driver"}`,
        );
        summary.failed += 1;
        continue;
      }
      if (age < DRIVER_RETRY_MIN_AGE_MS) continue;
      // Switched off (rollback): do not call out (and do not count it); the
      // record ages to `failed`.
      if (!isDriverTenant(rec.tenant_id)) continue;
      summary.retried += 1;
      const next = await attemptDriverDispatch(rec);
      if (next.status === "failed") summary.failed += 1;
      else if (next.status !== "quoted") summary.dispatched += 1;
    } catch (err) {
      captureError(err, { scope: "driver-dispatch-sweep", deliveryId: rec.id });
    }
  }
  return summary;
}

export type ManualFallbackResult =
  | { ok: true; delivery: DeliveryRecord }
  | {
      ok: false;
      reason: "not_found" | "not_driver" | "not_allowed" | "stale";
      message: string;
    };

/**
 * "Dispatch manually instead": the ONE explicit way a driver delivery becomes an
 * in-house one. Never automatic. Allowed only while no driver can be carrying it:
 *   * no provider id and `failed`, or `quoted` for at least 2 minutes; or
 *   * the driver CANCELED it (a cancel the driver confirmed) and the order is
 *     still live.
 * Anything with a provider id that is not canceled is refused (double-delivery).
 */
export async function dispatchManuallyInstead(
  deliveryId: string,
  now: Date = new Date(),
  opts: {
    confirmNotWithDriver?: boolean;
    actor?: { id: string; label: string | null };
  } = {},
): Promise<ManualFallbackResult> {
  const driver = getPosDriver();
  const rec = await driver.getDelivery(deliveryId);
  if (!rec)
    return { ok: false, reason: "not_found", message: "Delivery not found." };
  if (rec.provider !== "openpizza_driver") {
    return {
      ok: false,
      reason: "not_driver",
      message: "Only Open Pizza Driver deliveries can be switched.",
    };
  }
  const refuse = (message: string): ManualFallbackResult => ({
    ok: false,
    reason: "not_allowed",
    message,
  });
  const conflictRow =
    rec.dispatch_error === DRIVER_CONFLICT_MARK &&
    rec.status === "quoted" &&
    rec.provider_delivery_id === null;
  let overrideConflict = false;
  if (conflictRow) {
    const stuck =
      now.getTime() - new Date(rec.created_at).getTime() >= DRIVER_GIVE_UP_MS;
    if (!(stuck && opts.confirmNotWithDriver === true)) {
      return refuse(
        stuck
          ? "The driver answered with a conflict and may hold this delivery. Confirm with the driver that it does not, then use the explicit override."
          : "The driver answered with a conflict and may already hold this delivery; wait for its status update.",
      );
    }
    overrideConflict = true;
  }
  if (overrideConflict) {
    // Explicit, confirmed override: falls through to the order check and switch.
  } else if (rec.status === "failed") {
    // The driver reported it failed (or the dispatch failed): safe to hand over.
  } else if (rec.provider_delivery_id === null) {
    if (rec.status === "quoted") {
      const age = now.getTime() - new Date(rec.created_at).getTime();
      if (age < DRIVER_MANUAL_HOLD_MS) {
        return refuse(
          "The driver may still accept this delivery; wait 2 minutes before switching.",
        );
      }
    } else {
      return refuse(`The delivery is ${rec.status}; it cannot be switched.`);
    }
  } else if (rec.status !== "canceled") {
    return refuse(
      "The driver already has this delivery; switching could send two couriers. Cancel it with the driver first.",
    );
  }
  const order = await driver.getOrder(rec.order_id);
  if (
    !order ||
    ["voided", "completed", "refunded", "abandoned"].includes(order.status)
  ) {
    return refuse("The order is no longer open for delivery.");
  }
  const switched = await driver.switchDeliveryToManual(rec.id, rec.tenant_id, {
    status: rec.status,
    provider_delivery_id: rec.provider_delivery_id,
  });
  if (!switched) {
    return {
      ok: false,
      reason: "stale",
      message: "The delivery changed; reload and try again.",
    };
  }
  if (overrideConflict) {
    const who = opts.actor?.label ?? opts.actor?.id ?? "unknown";
    console.error(
      `[pos][ALERT] manual override of driver conflict for delivery ${rec.id} by ${who}`,
    );
    await recordAudit({
      actor: { id: opts.actor?.id ?? "unknown", label: opts.actor?.label ?? "unknown" },
      action: "delivery_manual_override",
      tenantId: rec.tenant_id,
      detail: `Manual override of driver conflict: delivery ${rec.id} (order ${rec.order_id}) switched to in-house; operator confirmed the driver does not have it`,
    });
  }
  return { ok: true, delivery: switched };
}
