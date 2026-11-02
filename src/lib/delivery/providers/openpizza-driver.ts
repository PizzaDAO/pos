/**
 * `openpizza_driver` delivery provider: deliveries run by the Open Pizza driver
 * module, dispatched OUTBOUND over the hub-registered driver deployment.
 *
 *   * quote   : the location's own delivery zones (exactly like in-house), so a
 *               quote and the storefront agree. The driver is NOT consulted at
 *               checkout; it is authoritative only at dispatch.
 *   * dispatch: `POST {driver base_url}/dispatch` with the hub-minted `pos` module
 *               token and `Idempotency-Key: pos-delivery:<record id>`. Retries
 *               resend the identical body and key.
 *   * cancel  : `POST .../deliveries/{id}/cancel`, key `pos-cancel:<record id>`.
 *   * track   : `GET .../deliveries/{id}` (status is normally PUSHED to
 *               `/api/v1/deliveries/{id}/status`; track exists for admin refresh).
 *   * available: INERT unless `OPENPIZZA_DRIVER_TENANTS` lists the tenant, the hub
 *               client env is set, and the hub shows an active registration
 *               (see `../driver-hub`). Any failure means unavailable, so the
 *               location quotes with its next provider (in-house).
 *
 * Failures are classified for the dispatch service: `DriverDispatchError.retryable`
 * is true for timeouts, network errors, 429 and 5xx (the driver may or may not
 * have the delivery: retry with the SAME key), false for other 4xx (fail closed).
 */
import {
  DeliveryTrackSchema,
  createRemoteDeliveryProvider,
} from "@openpizza/core";
import type { DeliveryTrack } from "@openpizza/core";
import type {
  Delivery,
  DeliveryContext,
  DeliveryProvider,
  DeliveryQuote,
  DeliveryQuoteRequest,
  DispatchRequest,
} from "../DeliveryProvider";
import {
  getDriverHubConfig,
  hubTokenFor,
  isDriverAvailable,
  isDriverTenant,
  lookupDriverRegistration,
} from "../driver-hub";
import { inHouseManualProvider } from "./in-house-manual";

const KEY = "openpizza_driver" as const;
/** Finalize runs inline after payment: never wait long on the driver. */
export const DRIVER_TIMEOUT_MS = 5_000;

/** A driver call that did not produce a delivery. */
export class DriverDispatchError extends Error {
  constructor(
    message: string,
    /** true: try again later with the same idempotency key. false: fail closed. */
    readonly retryable: boolean,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = "DriverDispatchError";
  }
}

function classify(err: unknown): DriverDispatchError {
  if (err instanceof DriverDispatchError) return err;
  const status =
    typeof (err as { status?: unknown })?.status === "number"
      ? (err as { status: number }).status
      : null;
  const message = err instanceof Error ? err.message : String(err);
  // Timeouts / network errors surface as hub-unavailable (503) problems, or as
  // plain errors without a status: both are transient.
  const retryable = status === null || status === 429 || status >= 500;
  return new DriverDispatchError(message, retryable, status);
}

/** Resolve the tenant's driver deployment and a ready remote client. */
async function remoteFor(tenantId: string) {
  if (!isDriverTenant(tenantId)) {
    throw new DriverDispatchError(
      "driver dispatch is switched off for this tenant",
      true,
    );
  }
  const cfg = getDriverHubConfig();
  if (!cfg) throw new DriverDispatchError("hub client is not configured", true);
  let reg;
  try {
    reg = await lookupDriverRegistration(tenantId, cfg);
  } catch (err) {
    throw new DriverDispatchError(
      `hub unavailable: ${err instanceof Error ? err.message : String(err)}`,
      true,
    );
  }
  if (!reg) {
    throw new DriverDispatchError(
      "no active openpizza_driver registration",
      true,
    );
  }
  return createRemoteDeliveryProvider({
    baseUrl: reg.baseUrl,
    token: hubTokenFor(tenantId, cfg),
    timeoutMs: DRIVER_TIMEOUT_MS,
  });
}

function parseTrack(json: unknown): DeliveryTrack {
  const parsed = DeliveryTrackSchema.safeParse(json);
  if (!parsed.success) {
    // The driver may have created it: retry with the same key to learn the id.
    throw new DriverDispatchError("driver returned an invalid delivery", true);
  }
  return parsed.data;
}

/** Driver `DeliveryTrack` -> POS `Delivery`. `pending_assignment` stays `dispatched`. */
export function trackToDelivery(t: DeliveryTrack): Delivery {
  return {
    provider: KEY,
    deliveryId: t.provider_delivery_id,
    status: t.status === "pending_assignment" ? "dispatched" : t.status,
    etaMinutes: t.eta_minutes ?? undefined,
    trackingRef: t.tracking_url ?? undefined,
    driverName: t.driver?.name ?? undefined,
    driverPhone: t.driver?.phone ?? undefined,
  };
}

export const openPizzaDriverProvider: DeliveryProvider = {
  key: KEY,

  available(tenantId: string): Promise<boolean> {
    return isDriverAvailable(tenantId);
  },

  async quote(req: DeliveryQuoteRequest): Promise<DeliveryQuote> {
    const q = await inHouseManualProvider.quote(req);
    return { ...q, provider: KEY };
  },

  async dispatch(req: DispatchRequest): Promise<Delivery> {
    if (!req.deliveryId || !req.payload) {
      throw new DriverDispatchError(
        "openpizza_driver dispatch needs the delivery record id and payload",
        false,
      );
    }
    try {
      const remote = await remoteFor(req.context.tenantId);
      const raw = await remote.dispatch(
        req.payload,
        `pos-delivery:${req.deliveryId}`,
      );
      return trackToDelivery(parseTrack(raw));
    } catch (err) {
      throw classify(err);
    }
  },

  async track(context: DeliveryContext, deliveryId: string): Promise<Delivery> {
    try {
      const remote = await remoteFor(context.tenantId);
      return trackToDelivery(parseTrack(await remote.track(deliveryId)));
    } catch (err) {
      throw classify(err);
    }
  },

  async cancel(
    context: DeliveryContext,
    deliveryId: string,
  ): Promise<Delivery> {
    try {
      const remote = await remoteFor(context.tenantId);
      const raw = await remote.cancel(
        deliveryId,
        "pos_order_canceled",
        `pos-cancel:${context.idempotencyKey}`,
      );
      return trackToDelivery(parseTrack(raw));
    } catch (err) {
      throw classify(err);
    }
  },
};
