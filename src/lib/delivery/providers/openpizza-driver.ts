/**
 * `openpizza_driver` delivery provider: deliveries run by the Open Pizza driver
 * module (or any partner that reports through `POST /api/v1/deliveries/{id}/status`).
 *
 * POS makes NO outbound call. It quotes from the location's own delivery zones
 * (exactly like the in-house provider, so a quote and the storefront agree),
 * records the delivery as `dispatched`, and then the partner drives the state by
 * pushing status updates (driver, ETA, tracking URL, picked_up, delivered ...).
 * The stored record is the only truth: `track` never overlays a simulated driver.
 */
import type {
  Delivery,
  DeliveryContext,
  DeliveryProvider,
  DeliveryQuote,
  DeliveryQuoteRequest,
  DispatchRequest,
} from "../DeliveryProvider";
import { inHouseManualProvider } from "./in-house-manual";

const KEY = "openpizza_driver" as const;

export const openPizzaDriverProvider: DeliveryProvider = {
  key: KEY,

  async quote(req: DeliveryQuoteRequest): Promise<DeliveryQuote> {
    const q = await inHouseManualProvider.quote(req);
    return { ...q, provider: KEY };
  },

  async dispatch(req: DispatchRequest): Promise<Delivery> {
    // The delivery id is ours until the partner reports its own
    // (`provider_delivery_id` on the first status update).
    return { provider: KEY, deliveryId: `opd_${req.orderId}`, status: "dispatched" };
  },

  async track(_context: DeliveryContext, deliveryId: string): Promise<Delivery> {
    return { provider: KEY, deliveryId, status: "dispatched" };
  },

  async cancel(_context: DeliveryContext, deliveryId: string): Promise<Delivery> {
    return { provider: KEY, deliveryId, status: "canceled" };
  },
};
