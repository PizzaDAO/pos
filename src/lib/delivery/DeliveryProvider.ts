/**
 * DeliveryProvider — pluggable delivery interface contract.
 *
 * Each delivery mechanism (in-house manual dispatch, DoorDash Drive, ...)
 * implements this interface. Core order logic depends ONLY on this contract and
 * the registry — never on a specific provider's API. New providers = new
 * implementation, no core changes.
 *
 * Phase 0: interface + types + registry with declared keys only (no impls).
 * Implementations land in Phase 4. Do not add provider SDKs here yet.
 */

import type { Money } from "@/lib/payments/PaymentRail";

/** Stable identifiers for the delivery providers the platform supports. */
export type DeliveryProviderKey = "in_house_manual" | "doordash_drive";

export interface Address {
  line1: string;
  line2?: string;
  city: string;
  region: string;
  postalCode: string;
  country: string;
  lat?: number;
  lng?: number;
}

export type DeliveryStatus =
  | "quoted"
  | "dispatched"
  | "assigned"
  | "picked_up"
  | "delivering"
  | "delivered"
  | "canceled"
  | "failed";

/** Tenant/location context every provider call is scoped to. */
export interface DeliveryContext {
  tenantId: string;
  locationId: string;
  /** Client-propagated idempotency key to prevent duplicate dispatches. */
  idempotencyKey: string;
}

export interface DeliveryQuoteRequest {
  context: DeliveryContext;
  pickup: Address;
  dropoff: Address;
  /** Order subtotal, used by providers that price relative to order value. */
  orderTotal?: Money;
  /** ISO timestamp for a scheduled delivery; omit for ASAP. */
  scheduledFor?: string;
}

export interface DeliveryQuote {
  provider: DeliveryProviderKey;
  fee: Money;
  /** Estimated minutes until delivery. */
  etaMinutes?: number;
  /** Provider-specific quote handle to pass back to `dispatch`. */
  quoteId?: string;
  expiresAt?: string;
}

export interface DispatchRequest {
  context: DeliveryContext;
  orderId: string;
  pickup: Address;
  dropoff: Address;
  /** Quote handle from a prior `quote()` call, when the provider requires one. */
  quoteId?: string;
  scheduledFor?: string;
}

export interface Delivery {
  provider: DeliveryProviderKey;
  /** Provider-native delivery id. */
  deliveryId: string;
  status: DeliveryStatus;
  fee?: Money;
  etaMinutes?: number;
  /** Tracking URL/ref surfaced to the customer. */
  trackingRef?: string;
  driverName?: string;
  driverPhone?: string;
}

/**
 * The contract each delivery provider implements. Methods are async and must be
 * idempotent with respect to `context.idempotencyKey`.
 */
export interface DeliveryProvider {
  readonly key: DeliveryProviderKey;

  /** Price a delivery for the given pickup/dropoff (and optional schedule). */
  quote(req: DeliveryQuoteRequest): Promise<DeliveryQuote>;

  /** Dispatch a delivery for a placed order. */
  dispatch(req: DispatchRequest): Promise<Delivery>;

  /** Fetch current tracking state for a dispatched delivery. */
  track(context: DeliveryContext, deliveryId: string): Promise<Delivery>;

  /** Cancel a dispatched delivery where the provider allows it. */
  cancel(context: DeliveryContext, deliveryId: string): Promise<Delivery>;
}
