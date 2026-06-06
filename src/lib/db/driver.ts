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
import type {
  BusinessDayClose,
  CategoryInput,
  DateRange,
  DrawerReconciliation,
  InventoryItem,
  InventoryItemView,
  InventoryMovement,
  ItemInput,
  LocationMenuOverride,
  ModifierGroupInput,
  ModifierInput,
  MovementReason,
  OverrideInput,
  SalesReport,
  Shift,
  ShiftCashEvent,
  Staff,
  SizeInput,
} from "./backoffice-types";
import type {
  MenuCategory,
  MenuItem,
  ItemSize,
  Modifier,
  ModifierGroup,
} from "./menu-types";
import type {
  Location,
  Membership,
  PlatformAdmin,
  Tenant,
  User,
} from "./types";
import type {
  AuditLogEntry,
  CreateLocationInput,
  CreateTenantInput,
  OnboardingStep,
  PlanTier,
  Subscription,
  TenantHealth,
  TenantOnboarding,
} from "./saas-types";

export interface PosDriver {
  /** Stable id of the active driver implementation (for diagnostics/UX). */
  readonly name: "mock" | "supabase";

  // --------------------------------------------------------------------------
  // Tenancy + self-serve SaaS (Phase 6)
  //
  // Signup creates a brand-new, isolated tenant (its own owner user, locations,
  // store/payment settings, and menu) through these methods. A future Supabase
  // driver implements them as RLS-scoped table writes; call sites are unchanged.
  // --------------------------------------------------------------------------

  /** All tenants (platform/super-admin scope — outside tenant RLS). */
  listTenants(): Promise<Tenant[]>;

  /** Fetch a single tenant by id, or null. */
  getTenant(tenantId: string): Promise<Tenant | null>;

  /**
   * Create a brand-new tenant + its owner user (modelled as a User + an owner
   * Membership). The tenant starts in `suspended` (pre-go-live) status with a
   * unique slug derived from the business name. Onboarding state is initialised.
   */
  createTenant(
    input: CreateTenantInput,
  ): Promise<{ tenant: Tenant; owner: User }>;

  /** Update a tenant's lifecycle status (active/suspended/cancelled). */
  setTenantStatus(
    tenantId: string,
    status: Tenant["status"],
  ): Promise<Tenant | null>;

  /** Add a location to a tenant during/after onboarding (own slug + settings). */
  createLocation(input: CreateLocationInput): Promise<Location>;

  /** Replace a new tenant's menu with the starter template (onboarding import). */
  importStarterMenu(tenantId: string): Promise<void>;

  // -- Onboarding state ------------------------------------------------------

  /** Current onboarding state for a tenant, or null. */
  getOnboarding(tenantId: string): Promise<TenantOnboarding | null>;

  /** Mark a wizard step complete + advance current_step. */
  completeOnboardingStep(
    tenantId: string,
    step: OnboardingStep,
  ): Promise<TenantOnboarding>;

  /** Finalize onboarding: flip the tenant to active + mark live. */
  goLive(tenantId: string): Promise<TenantOnboarding>;

  // -- Subscriptions (Stripe Billing — our revenue) --------------------------

  /** A tenant's subscription, or null if never subscribed. */
  getSubscription(tenantId: string): Promise<Subscription | null>;

  /** Upsert (persist) a tenant's subscription row. */
  upsertSubscription(sub: Subscription): Promise<Subscription>;

  /**
   * Advance a SIMULATED subscription's lifecycle for the demo: trialing→active,
   * active→past_due, past_due→active|canceled. No-op on real subscriptions.
   */
  advanceSubscriptionStatus(
    tenantId: string,
    status: Subscription["status"],
  ): Promise<Subscription | null>;

  /** Switch a tenant's plan tier (keeps the same subscription row). */
  changeSubscriptionTier(
    tenantId: string,
    tier: PlanTier,
  ): Promise<Subscription | null>;

  // -- Platform admin + health ------------------------------------------------

  /** Whether a user id is a platform (super) admin. */
  isPlatformAdmin(userId: string): Promise<boolean>;

  /** The platform-admin roster. */
  listPlatformAdmins(): Promise<PlatformAdmin[]>;

  /** Resolve a user id → email label (for audit display); null if unknown. */
  getUser(userId: string): Promise<User | null>;

  /** Resolve a user by email (real-auth bridges auth.users → this row). */
  getUserByEmail(email: string): Promise<User | null>;

  /**
   * All tenant memberships for a user (user ↔ tenant ↔ role). Drives route/role
   * gating for the session — never a hardcoded role. Empty for a user with no
   * tenant access.
   */
  listMembershipsForUser(userId: string): Promise<Membership[]>;

  /** Aggregated per-tenant health for the super-admin tenant list. */
  listTenantHealth(): Promise<TenantHealth[]>;

  // -- Audit log (impersonation + sensitive actions) -------------------------

  /** Append an audit entry (impersonation start/end, suspend, etc.). */
  appendAuditLog(entry: Omit<AuditLogEntry, "id" | "created_at">): Promise<AuditLogEntry>;

  /** Read the audit log (newest first), optionally scoped to a tenant. */
  listAuditLog(tenantId?: string): Promise<AuditLogEntry[]>;

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

  // --------------------------------------------------------------------------
  // Menu management (Phase 5) — CRUD on the tenant menu definition.
  //
  // `getMenu(...)` already folds per-location overrides into its reads, so the
  // terminal/shop reflect edits with NO call-site changes. Mutations here change
  // the tenant-level menu (categories/items/sizes/modifier groups/modifiers);
  // per-location price/availability + 86 live in the override methods below.
  // --------------------------------------------------------------------------

  listCategories(tenantId: string): Promise<MenuCategory[]>;
  upsertCategory(input: CategoryInput): Promise<MenuCategory>;
  deleteCategory(id: string): Promise<void>;

  upsertItem(input: ItemInput): Promise<MenuItem>;
  deleteItem(id: string): Promise<void>;

  upsertSize(input: SizeInput): Promise<ItemSize>;
  deleteSize(id: string): Promise<void>;

  listModifierGroups(tenantId: string): Promise<ModifierGroup[]>;
  upsertModifierGroup(input: ModifierGroupInput): Promise<ModifierGroup>;
  deleteModifierGroup(id: string): Promise<void>;

  upsertModifier(input: ModifierInput): Promise<Modifier>;
  deleteModifier(id: string): Promise<void>;

  // --------------------------------------------------------------------------
  // Per-location menu overrides (price / availability — incl. "86 an item").
  // --------------------------------------------------------------------------

  /** All overrides for a location (admin editor). */
  listOverrides(
    tenantId: string,
    locationId: string,
  ): Promise<LocationMenuOverride[]>;

  /** Upsert (by tenant+location+target) a price/availability override. */
  upsertOverride(input: OverrideInput): Promise<LocationMenuOverride>;

  /** Clear an override entirely (revert to the tenant definition). */
  clearOverride(
    tenantId: string,
    locationId: string,
    targetType: LocationMenuOverride["target_type"],
    targetId: string,
  ): Promise<void>;

  // --------------------------------------------------------------------------
  // Inventory (per location) — items, movements, depletion, low-stock.
  // --------------------------------------------------------------------------

  /** Location inventory with a derived `low` flag. */
  listInventory(
    tenantId: string,
    locationId: string,
  ): Promise<InventoryItemView[]>;

  upsertInventoryItem(item: InventoryItem): Promise<InventoryItem>;

  /**
   * Apply a signed movement to an inventory item (restock/adjustment/waste/
   * depletion), persist the ledger entry, and return the new level.
   */
  applyInventoryMovement(input: {
    inventoryItemId: string;
    reason: MovementReason;
    delta: number;
    orderId?: string | null;
    note?: string | null;
  }): Promise<{ item: InventoryItem; movement: InventoryMovement }>;

  /** Movement ledger for a location (newest first). */
  listInventoryMovements(
    tenantId: string,
    locationId: string,
  ): Promise<InventoryMovement[]>;

  // --------------------------------------------------------------------------
  // Reports + end-of-day (derive from orders/payments via the abstraction).
  // --------------------------------------------------------------------------

  /**
   * Compute a sales report. `locationId === null` produces a TENANT ROLLUP
   * across all the tenant's locations; a concrete id scopes to one location.
   */
  getSalesReport(
    tenantId: string,
    locationId: string | null,
    range: DateRange,
  ): Promise<SalesReport>;

  /** Existing close for a (location, business day), or null. */
  getBusinessDayClose(
    tenantId: string,
    locationId: string,
    businessDate: string,
  ): Promise<BusinessDayClose | null>;

  /**
   * Idempotently close a business day for a location (the Z-report). Re-closing
   * the same day returns the already-frozen snapshot.
   */
  closeBusinessDay(
    tenantId: string,
    locationId: string,
    businessDate: string,
  ): Promise<BusinessDayClose>;

  // --------------------------------------------------------------------------
  // Staff & shifts (clock in/out + drawer reconciliation).
  // --------------------------------------------------------------------------

  listStaff(tenantId: string): Promise<Staff[]>;
  upsertStaff(staff: Staff): Promise<Staff>;

  /**
   * Resolve a single active staff member for a tenant (incl. `pin_hash`) for
   * server-side PIN quick-switch verification. Used ONLY by the trusted server
   * PIN route — the hash never leaves the server. Returns null if unknown.
   */
  getStaffById(tenantId: string, staffId: string): Promise<Staff | null>;

  /** List shifts for a location (newest first). */
  listShifts(tenantId: string, locationId: string): Promise<Shift[]>;

  /** The open shift for a staff member at a location, or null. */
  getOpenShift(
    tenantId: string,
    locationId: string,
    staffId: string,
  ): Promise<Shift | null>;

  /** Clock in: open a shift with an opening float. */
  openShift(input: {
    tenantId: string;
    locationId: string;
    staffId: string;
    openingFloatCents: number;
  }): Promise<Shift>;

  /** Record a cash event (sale/payout/paid_in/drop) against an open shift. */
  addShiftCashEvent(event: ShiftCashEvent): Promise<ShiftCashEvent>;

  /** Cash events for a shift (oldest first). */
  listShiftCashEvents(shiftId: string): Promise<ShiftCashEvent[]>;

  /** Reconciliation summary (expected vs counted) for a shift. */
  getDrawerReconciliation(shiftId: string): Promise<DrawerReconciliation>;

  /**
   * Clock out + reconcile: closes the shift, records the counted drawer, and
   * computes over/short. Returns the closed shift.
   */
  closeShift(input: {
    shiftId: string;
    countedCents: number;
    note?: string | null;
  }): Promise<Shift | null>;
}
