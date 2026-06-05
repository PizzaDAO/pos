/**
 * In-house manual delivery provider (Phase 4).
 *
 * Computes zone/fee/ETA from the LOCATION'S store-config delivery zones (no
 * external service — always "real", needs no env). `dispatch` marks the delivery
 * for MANUAL ASSIGNMENT: it persists a `pending_assignment` record that a
 * dispatcher resolves in /admin by assigning a driver (see the delivery service
 * `assignDriver`). `track` reflects the assignment/driver state; a simulated
 * driver/ETA is surfaced for the customer tracking page.
 *
 * Because zone math lives in `@/lib/delivery/zones`, the storefront's address
 * validation and this provider's quote agree by construction.
 */
import { getPosDriver } from "@/lib/db";
import type {
  Delivery,
  DeliveryContext,
  DeliveryProvider,
  DeliveryQuote,
  DeliveryQuoteRequest,
  DispatchRequest,
} from "../DeliveryProvider";
import { checkDeliverable } from "../zones";
import { DeliveryUnavailableError } from "../errors";
import { simDeliveryId, simDriver, simTrackingRef } from "../simulate";

const KEY = "in_house_manual" as const;

/** Load a location's delivery zones via the DB abstraction. */
async function loadZones(tenantId: string, locationId: string) {
  const driver = getPosDriver();
  const settings = await driver.getStoreSettings(tenantId, locationId);
  return settings.fulfillment?.delivery_zones ?? [];
}

export const inHouseManualProvider: DeliveryProvider = {
  key: KEY,

  async quote(req: DeliveryQuoteRequest): Promise<DeliveryQuote> {
    const zones = await loadZones(
      req.context.tenantId,
      req.context.locationId,
    );
    const subtotal = req.orderTotal?.amount ?? 0;
    const check = checkDeliverable(
      zones,
      { postal_code: req.dropoff.postalCode },
      subtotal,
    );
    if (!check.ok) {
      const message =
        check.reason === "below_minimum"
          ? `Order below the ${
              (check.zone?.min_subtotal_cents ?? 0) / 100
            } minimum for delivery to this area.`
          : "Address is outside our delivery area.";
      throw new DeliveryUnavailableError(message);
    }
    return {
      provider: KEY,
      fee: {
        amount: check.zone.fee_cents,
        currency: req.orderTotal?.currency ?? "USD",
      },
      etaMinutes: check.zone.eta_minutes,
      quoteId: check.zone.id,
    };
  },

  async dispatch(_req: DispatchRequest): Promise<Delivery> {
    // In-house dispatch = queue for manual driver assignment (no auto-driver).
    return {
      provider: KEY,
      deliveryId: simDeliveryId("inhouse"),
      // pending_assignment maps to "dispatched" at the interface level; the
      // platform-side DeliveryRecord carries the finer-grained status.
      status: "dispatched",
      trackingRef: simTrackingRef(KEY),
    };
  },

  async track(
    _context: DeliveryContext,
    deliveryId: string,
  ): Promise<Delivery> {
    // The authoritative state lives in the DeliveryRecord (assignment happens in
    // /admin). The provider returns a simulated driver so the customer tracker
    // has something to show once assigned; the service layer overlays the real
    // record status. Driver is deterministic from the delivery id.
    const driver = simDriver(deliveryId);
    return {
      provider: KEY,
      deliveryId,
      status: "assigned",
      driverName: driver.name,
      driverPhone: driver.phone,
    };
  },

  async cancel(
    _context: DeliveryContext,
    deliveryId: string,
  ): Promise<Delivery> {
    return { provider: KEY, deliveryId, status: "canceled" };
  },
};
