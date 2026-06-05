/**
 * Customer + delivery domain row types (Phase 4 — online ordering).
 *
 * Mirrors the intended Supabase `customers` and `deliveries` tables described in
 * PLAN.md. Kept DB-agnostic so the in-memory mock driver and a future Supabase
 * driver share the same shapes. All money is integer minor units (cents).
 */
import type { DeliveryAddress } from "./menu-types";

/**
 * A customer of a tenant (online ordering). Created on guest checkout and
 * optionally "claimed" via a magic-link account stub (no real email send — see
 * the auth stub in `src/lib/shop/auth.ts`). Scoped to a tenant; the same email
 * at two tenants is two rows (matching strict per-tenant isolation).
 */
export interface Customer {
  /** Client/server UUID. */
  id: string;
  tenant_id: string;
  email: string;
  name: string | null;
  phone: string | null;
  /**
   * Whether the customer verified ownership of the email via the magic-link
   * stub. Guests start `false`; clicking a (simulated) magic link flips it.
   */
  verified: boolean;
  created_at: string;
  updated_at: string;
}

/** Lifecycle of a magic-link sign-in token (stubbed — never emailed). */
export interface MagicLinkToken {
  token: string;
  tenant_id: string;
  email: string;
  customer_id: string;
  /** ISO expiry; expired tokens can't be consumed. */
  expires_at: string;
  consumed: boolean;
  created_at: string;
}

/**
 * Status of a delivery as tracked by the platform — distinct from the provider's
 * own `DeliveryStatus` enum but kept in sync. `pending_assignment` is the
 * in-house state where a dispatcher must still assign a driver.
 */
export type DeliveryRecordStatus =
  | "quoted"
  | "pending_assignment"
  | "dispatched"
  | "assigned"
  | "picked_up"
  | "delivering"
  | "delivered"
  | "canceled"
  | "failed";

/**
 * A delivery attached to an order (Phase 4). One per delivery order. Holds the
 * provider that owns it, the resolved fee/ETA, and (for in-house) the assigned
 * driver. The provider-native id + tracking ref let the tracking page poll the
 * right provider for live state.
 */
export interface DeliveryRecord {
  /** Client/server UUID (also the dispatch idempotency key). */
  id: string;
  order_id: string;
  tenant_id: string;
  location_id: string;
  /** DeliveryProviderKey ("in_house_manual" | "doordash_drive"). */
  provider: string;
  status: DeliveryRecordStatus;
  zone_id: string | null;
  fee_cents: number;
  currency: string;
  eta_minutes: number | null;
  /** Provider-native delivery id (DoorDash delivery id / in-house id). */
  provider_delivery_id: string | null;
  /** Tracking URL/ref surfaced to the customer. */
  tracking_ref: string | null;
  dropoff: DeliveryAddress;
  /** Assigned driver (in-house manual dispatch). */
  driver_name: string | null;
  driver_phone: string | null;
  /** Whether this delivery was quoted/dispatched on a simulated provider. */
  simulated: boolean;
  created_at: string;
  updated_at: string;
}
