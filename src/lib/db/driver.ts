/**
 * PosDriver — the DB-agnostic data-access contract the terminal depends on.
 *
 * Phase 1 ships a single in-memory implementation (`mock.ts`) seeded from the
 * sample pizzeria. A Supabase-backed implementation drops in later behind the
 * same interface WITHOUT touching any UI/call site. Selection happens in
 * `index.ts` via `getPosDriver()`.
 */
import type {
  CreateOrderInput,
  Menu,
  Order,
  OrderStatus,
  StoreSettings,
} from "./menu-types";
import type {
  ConnectAccount,
  Payment,
  PaymentSettings,
} from "./payment-types";
import type {
  Customer,
  DeliveryRecord,
  MagicLinkToken,
} from "./customer-types";
import type { Location } from "./types";

export interface PosDriver {
  /** Stable id of the active driver implementation (for diagnostics/UX). */
  readonly name: "mock" | "supabase";

  // --------------------------------------------------------------------------
  // Locations (Phase 4 storefront resolves a location by its public slug)
  // --------------------------------------------------------------------------

  /** All locations for a tenant. */
  listLocations(tenantId: string): Promise<Location[]>;

  /** Resolve a location by its public slug (storefront URL), or null. */
  getLocationBySlug(slug: string): Promise<Location | null>;

  /** Fully-assembled menu graph for a location (categories → items → sizes/modifiers). */
  getMenu(tenantId: string, locationId: string): Promise<Menu>;

  /** Per-location store settings (tax rate, currency, tip presets). */
  getStoreSettings(
    tenantId: string,
    locationId: string,
  ): Promise<StoreSettings>;

  /**
   * Idempotent upsert-by-UUID. Creating with an id that already exists returns
   * the existing order unchanged (so offline retries never duplicate). Assigns
   * an order number + timestamps on first write.
   */
  createOrder(input: CreateOrderInput): Promise<Order>;

  /** Fetch a single order by its client UUID, or null. */
  getOrder(id: string): Promise<Order | null>;

  /** List recent orders for a location (newest first). */
  listOrders(tenantId: string, locationId: string): Promise<Order[]>;

  /** Update an order's status (e.g. → `paid`/`refunded`/`voided`). */
  updateOrderStatus(id: string, status: OrderStatus): Promise<Order | null>;

  // --------------------------------------------------------------------------
  // Payments (Phase 2)
  // --------------------------------------------------------------------------

  /** Per-tenant/location platform-fee + tip config (mock store settings). */
  getPaymentSettings(
    tenantId: string,
    locationId: string,
  ): Promise<PaymentSettings>;

  /**
   * Idempotent upsert-by-UUID of a payment tender. Re-submitting the same
   * payment id returns the stored tender unchanged so retries never
   * double-charge. Updating an existing tender (status/refund) merges fields.
   */
  upsertPayment(payment: Payment): Promise<Payment>;

  /** Fetch a single payment tender by id, or null. */
  getPayment(id: string): Promise<Payment | null>;

  /** Fetch a tender by its rail-native charge id (for webhook reconciliation). */
  getPaymentByChargeId(chargeId: string): Promise<Payment | null>;

  /** All tenders recorded against an order (oldest first). */
  listPaymentsForOrder(orderId: string): Promise<Payment[]>;

  // --------------------------------------------------------------------------
  // Stripe Connect (Phase 2)
  // --------------------------------------------------------------------------

  /** Current Connect onboarding status for a tenant, or null if not started. */
  getConnectAccount(tenantId: string): Promise<ConnectAccount | null>;

  /** Upsert (persist) a tenant's Connect account status. */
  upsertConnectAccount(account: ConnectAccount): Promise<ConnectAccount>;

  // --------------------------------------------------------------------------
  // Customers (Phase 4 — guest checkout + magic-link account stub)
  // --------------------------------------------------------------------------

  /** Find a tenant's customer by email (per-tenant uniqueness), or null. */
  getCustomerByEmail(tenantId: string, email: string): Promise<Customer | null>;

  /** Fetch a single customer by id, or null. */
  getCustomer(id: string): Promise<Customer | null>;

  /**
   * Upsert a customer. Re-using an id merges mutable fields; a new id with an
   * email that already exists for the tenant returns the existing row (so guest
   * checkout is idempotent on email).
   */
  upsertCustomer(customer: Customer): Promise<Customer>;

  /** Persist a (stubbed, never-emailed) magic-link token. */
  createMagicLinkToken(token: MagicLinkToken): Promise<MagicLinkToken>;

  /** Consume a magic-link token: marks it used + verifies the customer. */
  consumeMagicLinkToken(token: string): Promise<Customer | null>;

  // --------------------------------------------------------------------------
  // Deliveries (Phase 4 — DeliveryProvider quote/dispatch/track persistence)
  // --------------------------------------------------------------------------

  /** Upsert-by-id of a delivery record (idempotent dispatch). */
  upsertDelivery(delivery: DeliveryRecord): Promise<DeliveryRecord>;

  /** Fetch the delivery for an order, or null. */
  getDeliveryForOrder(orderId: string): Promise<DeliveryRecord | null>;

  /** Fetch a single delivery by id, or null. */
  getDelivery(id: string): Promise<DeliveryRecord | null>;

  /** List a location's deliveries (newest first) — the /admin dispatch view. */
  listDeliveries(
    tenantId: string,
    locationId: string,
  ): Promise<DeliveryRecord[]>;
}
