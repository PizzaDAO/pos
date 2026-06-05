/**
 * DoorDash Drive delivery provider (Phase 4).
 *
 * REAL path (quote → `/drive/v2/quotes`, dispatch → accept the quote, track →
 * `/drive/v2/deliveries/{id}`) is guarded by the DoorDash credentials
 * (`DOORDASH_DEVELOPER_ID` / `DOORDASH_KEY_ID` / `DOORDASH_SIGNING_SECRET`). The
 * Drive API authenticates with a short-lived JWT signed (HS256) with the signing
 * secret — `doordashJwt()` mints it. With NO keys (the default, incl. the Vercel
 * preview) every method falls back to a deterministic SIMULATED quote/dispatch/
 * track so the delivery flow works end-to-end without secrets.
 *
 * Real-mode fee/ETA come from DoorDash; simulated-mode fee/ETA come from the
 * location's zones (so the customer still sees consistent, in-area pricing).
 */
import { getPosDriver } from "@/lib/db";
import type {
  Delivery,
  DeliveryContext,
  DeliveryProvider,
  DeliveryQuote,
  DeliveryQuoteRequest,
  DeliveryStatus,
  DispatchRequest,
} from "../DeliveryProvider";
import { checkDeliverable } from "../zones";
import { DeliveryUnavailableError } from "../errors";
import { getDoorDashConfig, isDoorDashConfigured } from "../env";
import { simDeliveryId, simDriver, simTrackingRef } from "../simulate";

const KEY = "doordash_drive" as const;

async function loadZones(tenantId: string, locationId: string) {
  const driver = getPosDriver();
  const settings = await driver.getStoreSettings(tenantId, locationId);
  return settings.fulfillment?.delivery_zones ?? [];
}

/** Map a DoorDash delivery status string onto our DeliveryStatus enum. */
function mapDoorDashStatus(s: string): DeliveryStatus {
  switch (s) {
    case "quote":
      return "quoted";
    case "created":
    case "confirmed":
      return "dispatched";
    case "enroute_to_pickup":
    case "arrived_at_pickup":
      return "assigned";
    case "picked_up":
    case "enroute_to_dropoff":
      return "picked_up";
    case "arrived_at_dropoff":
      return "delivering";
    case "delivered":
      return "delivered";
    case "cancelled":
      return "canceled";
    default:
      return "dispatched";
  }
}

/**
 * Mint a short-lived DoorDash Drive JWT (HS256). Only called on the REAL path
 * (config present). Uses Node's crypto for the HMAC; no external dependency.
 */
async function doordashJwt(config: {
  developerId: string;
  keyId: string;
  signingSecret: string;
}): Promise<string> {
  const { createHmac } = await import("node:crypto");
  const header = { alg: "HS256", typ: "JWT", "dd-ver": "DD-JWT-V1" };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    aud: "doordash",
    iss: config.developerId,
    kid: config.keyId,
    exp: now + 300,
    iat: now,
  };
  const b64 = (obj: unknown) =>
    Buffer.from(JSON.stringify(obj))
      .toString("base64url");
  const signingInput = `${b64(header)}.${b64(payload)}`;
  const secret = Buffer.from(config.signingSecret, "base64");
  const sig = createHmac("sha256", secret)
    .update(signingInput)
    .digest("base64url");
  return `${signingInput}.${sig}`;
}

async function doordashRequest<T>(
  path: string,
  method: "GET" | "POST",
  body?: Record<string, unknown>,
): Promise<T> {
  const config = getDoorDashConfig();
  if (!config) throw new Error("DoorDash not configured.");
  const jwt = await doordashJwt(config);
  const res = await fetch(`${config.baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${jwt}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`DoorDash ${method} ${path} failed: ${res.status} ${text}`);
  }
  return (await res.json()) as T;
}

export const doorDashDriveProvider: DeliveryProvider = {
  key: KEY,

  async quote(req: DeliveryQuoteRequest): Promise<DeliveryQuote> {
    const currency = req.orderTotal?.currency ?? "USD";

    // Gate by the location's serviceable zones even in real mode (the tenant
    // decides where it delivers; DoorDash availability is a second filter).
    const zones = await loadZones(
      req.context.tenantId,
      req.context.locationId,
    );
    const check = checkDeliverable(
      zones,
      { postal_code: req.dropoff.postalCode },
      req.orderTotal?.amount ?? 0,
    );
    if (!check.ok) {
      const message =
        check.reason === "below_minimum"
          ? "Order below the minimum for delivery to this area."
          : "Address is outside our delivery area.";
      throw new DeliveryUnavailableError(message);
    }

    if (!isDoorDashConfigured()) {
      // Simulated quote: a DoorDash-style surcharge on top of the zone fee.
      return {
        provider: KEY,
        fee: { amount: check.zone.fee_cents + 100, currency },
        etaMinutes: check.zone.eta_minutes + 5,
        quoteId: simDeliveryId("ddquote"),
        expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      };
    }

    const external = simDeliveryId("ext"); // external_delivery_id (idempotent)
    const quote = await doordashRequest<{
      external_delivery_id: string;
      fee: number;
      currency: string;
      dropoff_time_estimated?: string;
    }>("/drive/v2/quotes", "POST", {
      external_delivery_id: external,
      pickup_address: formatAddress(req.pickup),
      dropoff_address: formatAddress(req.dropoff),
      order_value: req.orderTotal?.amount ?? 0,
    });
    const etaMinutes = quote.dropoff_time_estimated
      ? Math.max(
          1,
          Math.round(
            (new Date(quote.dropoff_time_estimated).getTime() - Date.now()) /
              60_000,
          ),
        )
      : check.zone.eta_minutes;
    return {
      provider: KEY,
      fee: { amount: quote.fee, currency: quote.currency || currency },
      etaMinutes,
      quoteId: quote.external_delivery_id,
    };
  },

  async dispatch(req: DispatchRequest): Promise<Delivery> {
    if (!isDoorDashConfigured()) {
      return {
        provider: KEY,
        deliveryId: req.quoteId ?? simDeliveryId("dddelivery"),
        status: "dispatched",
        trackingRef: simTrackingRef(KEY),
      };
    }
    // Accepting a Drive quote dispatches it (external id = the quote id).
    const delivery = await doordashRequest<{
      external_delivery_id: string;
      delivery_status: string;
      tracking_url?: string;
      fee?: number;
      currency?: string;
    }>(`/drive/v2/quotes/${req.quoteId}/accept`, "POST", {});
    return {
      provider: KEY,
      deliveryId: delivery.external_delivery_id,
      status: mapDoorDashStatus(delivery.delivery_status),
      trackingRef: delivery.tracking_url,
      fee:
        delivery.fee !== undefined
          ? { amount: delivery.fee, currency: delivery.currency ?? "USD" }
          : undefined,
    };
  },

  async track(
    _context: DeliveryContext,
    deliveryId: string,
  ): Promise<Delivery> {
    if (!isDoorDashConfigured()) {
      const driver = simDriver(deliveryId);
      return {
        provider: KEY,
        deliveryId,
        status: "picked_up",
        driverName: driver.name,
        driverPhone: driver.phone,
        trackingRef: simTrackingRef(KEY),
      };
    }
    const delivery = await doordashRequest<{
      external_delivery_id: string;
      delivery_status: string;
      tracking_url?: string;
      dasher_name?: string;
      dasher_phone_number?: string;
    }>(`/drive/v2/deliveries/${deliveryId}`, "GET");
    return {
      provider: KEY,
      deliveryId: delivery.external_delivery_id,
      status: mapDoorDashStatus(delivery.delivery_status),
      trackingRef: delivery.tracking_url,
      driverName: delivery.dasher_name,
      driverPhone: delivery.dasher_phone_number,
    };
  },

  async cancel(
    _context: DeliveryContext,
    deliveryId: string,
  ): Promise<Delivery> {
    if (!isDoorDashConfigured()) {
      return { provider: KEY, deliveryId, status: "canceled" };
    }
    await doordashRequest(
      `/drive/v2/deliveries/${deliveryId}/cancel`,
      "PUT" as "POST",
    );
    return { provider: KEY, deliveryId, status: "canceled" };
  },
};

function formatAddress(a: {
  line1: string;
  line2?: string;
  city: string;
  region: string;
  postalCode: string;
  country: string;
}): string {
  return [a.line1, a.line2, a.city, a.region, a.postalCode, a.country]
    .filter(Boolean)
    .join(", ");
}
