/**
 * In-memory PosDriver — Phase 1 default (Supabase deferred), extended through
 * Phase 5 (back office).
 *
 * Assembles the menu graph from `seed-data.ts` and keeps placed orders in a
 * module-level Map for the lifetime of the server process. `createOrder` is an
 * idempotent upsert-by-UUID: re-submitting an order with an id that already
 * exists is a no-op that returns the stored order, so offline-queue retries
 * never produce duplicates.
 *
 * Phase 5 adds MUTABLE menu state (categories/items/sizes/modifier groups +
 * per-location overrides), inventory (with sale-driven depletion + low-stock),
 * staff/shifts (drawer reconciliation), reports, and idempotent end-of-day.
 *
 * Everything here is pure data + maps; it never reads env vars and works with no
 * configuration, so the app builds and runs offline in the Vercel preview.
 */
import { MarketplaceStoreTakenError } from "@/lib/marketplace/guard";
import {
  assertNoSimulatedOverwrite,
  isConnectedForHealth,
} from "@/lib/payments/connect-status";
import type {
  Printer,
  PrintJob,
  PrintLocationSettings,
} from "@/lib/printing/types";
import type { PosDriver } from "./driver";
import type {
  CreateOrderInput,
  ItemSize,
  Menu,
  MenuCategory,
  MenuCategoryWithItems,
  MenuItem,
  MenuItemDetail,
  MenuModifierGroup,
  Modifier,
  ModifierGroup,
  LatePaymentMarker,
  Order,
  OrderFulfillment,
  OrderItem,
  OrderStatus,
  StoreSettings,
} from "./menu-types";
import type {
  ConnectAccount,
  ExternalTenderResult,
  ExternalTenderWrite,
  Payment,
  PaymentSessionRow,
  AllergenPublicationRecord,
  AllergenRow,
  PaymentSettings,
  RefundReservation,
  StoredQuote,
  TerminalLocation,
  TerminalReader,
} from "./payment-types";
import {
  FINGERPRINT_STATUSES,
  LiveTenderConflictError,
  PaymentSessionConflictError,
  ONE_LIVE_TENDER_RAILS,
  tenderFingerprint,
  tenderHoldsOpenSlot,
} from "./payment-types";
import { applyCustomerIdentity } from "./customer-identity";
import { isLiveOrderStatus, isUnpaidOnlineStatus } from "./menu-types";
import type {
  Customer,
  CustomerIdentityWrite,
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
  ItemInventoryLink,
  LocationMenuOverride,
  ModifierGroupInput,
  ModifierInput,
  MovementReason,
  OverrideInput,
  OverrideTargetType,
  SalesReport,
  Shift,
  ShiftCashEvent,
  SizeInput,
  Staff,
  PinAttempt,
  StaffSession,
  StaffPinRecord,
  StaffProfilePatch,
} from "./backoffice-types";
import type {
  Location,
  Membership,
  PlatformAdmin,
  Tenant,
  TenantSettings,
  User,
} from "./types";
import type {
  AuditLogEntry,
  CreateLocationInput,
  CreateTenantInput,
  OnboardingStep,
  PendingBillingCheckout,
  PlanTier,
  Subscription,
  TenantHealth,
  TenantOnboarding,
} from "./saas-types";
import { ONBOARDING_STEPS } from "./saas-types";
import {
  inventoryItems as seedInventoryItems,
  itemInventoryLinks as seedItemInventoryLinks,
  itemModifierGroups as seedItemModifierGroups,
  itemSizes as seedItemSizes,
  locations as seedLocations,
  menuCategories as seedMenuCategories,
  menuItems as seedMenuItems,
  modifierGroups as seedModifierGroups,
  modifiers as seedModifiers,
  paymentSettings as seedPaymentSettings,
  platformAdmins as seedPlatformAdmins,
  memberships as seedMemberships,
  staff as seedStaff,
  storeSettings as seedStoreSettings,
  tenants as seedTenants,
  users as seedUsers,
} from "./seed-data";
import { buildStarterMenu } from "@/lib/saas/menu-template";
import type { ImportChanges } from "@/lib/menu-import/apply";
import type { MenuSnapshot } from "@/lib/menu-import/types";
import { seedKitchenOrders } from "./kds-seed";
import { buildSalesReport, locationBusinessDate } from "@/lib/reports";
import { buildOwnerBundle, type OwnerReportBundle } from "@/lib/owner-reports";
import { refundableParts, tipRefundedCents } from "@/lib/payments/refund-state";
import { coveredBaseCents, foodDueCents } from "@/lib/adjustments/math";
import type {
  AdjustmentRecord,
  BeginRefundResult,
  OrderEditResult,
  OrderEditWrite,
} from "./adjustment-types";

/**
 * An abandoned tender attempt: unsettled (pending / requires_action), never
 * reached the rail (no charge id) and older than 15 minutes. Mirrors
 * public.core_cancel_order(); such a tender never holds an order open.
 */
const STALE_TENDER_TTL_MS = 15 * 60_000;
function isStaleUnsettled(p: Payment, nowMs: number): boolean {
  return (
    (p.status === "pending" || p.status === "requires_action") &&
    !p.charge_id &&
    Date.parse(p.created_at) < nowMs - STALE_TENDER_TTL_MS
  );
}

// ---------------------------------------------------------------------------
// MUTABLE menu state (Phase 5). Cloned from the seed so admin CRUD can mutate
// it without touching the immutable seed module. A future Supabase driver
// replaces these with table reads/writes; call sites are unchanged.
// ---------------------------------------------------------------------------
const menuCategories: MenuCategory[] = seedMenuCategories.map((c) => ({
  ...c,
}));
const menuItems: MenuItem[] = seedMenuItems.map((i) => ({ ...i }));
const itemSizes: ItemSize[] = seedItemSizes.map((s) => ({ ...s }));
const modifierGroups: ModifierGroup[] = seedModifierGroups.map((g) => ({
  ...g,
}));
const modifiers: Modifier[] = seedModifiers.map((m) => ({ ...m }));
const itemModifierGroups = seedItemModifierGroups.map((l) => ({ ...l }));

// ---------------------------------------------------------------------------
// MUTABLE tenancy + SaaS state (Phase 6). Cloned from the seed so self-serve
// signup can append brand-new, isolated tenants (own locations, settings, menu)
// without touching the immutable seed module. Store/payment settings move to
// arrays so a new tenant/location gets its own row.
// ---------------------------------------------------------------------------
const tenants: Tenant[] = seedTenants.map((t) => ({ ...t }));
const locations: Location[] = seedLocations.map((l) => ({ ...l }));
const storeSettings = seedStoreSettings.map((s) => ({ ...s }));
/** `${provider}:${storeId}` -> owning location (platform-admin assigned). */
const marketplaceStores = new Map<
  string,
  { provider: string; tenantId: string; locationId: string }
>();
const paymentSettings = seedPaymentSettings.map((s) => ({ ...s }));
const usersById = new Map<string, User>(seedUsers.map((u) => [u.id, { ...u }]));
const platformAdmins: PlatformAdmin[] = seedPlatformAdmins.map((a) => ({
  ...a,
}));
/** Tenant memberships (user ↔ tenant ↔ role) — drives session role gating. */
const memberships: Membership[] = seedMemberships.map((m) => ({ ...m }));
/** Subscriptions keyed by tenant id (one per tenant). */
const subscriptions = new Map<string, Subscription>();
/** Open billing Checkout Session per tenant (billing_checkout_sessions). */
const pendingBillingCheckouts = new Map<string, PendingBillingCheckout>();
/** Onboarding state keyed by tenant id. */
const onboardingState = new Map<string, TenantOnboarding>();
/** Append-only audit log (impersonation + sensitive platform actions). */
const auditLog: AuditLogEntry[] = [];

// Seed the demo tenant as already onboarded + on the Pro plan, so /platform
// shows a healthy live tenant alongside any newly self-served tenant. The demo
// tenant runs 2 locations + online ordering, which requires Pro.
(() => {
  const demoTenant = seedTenants[0];
  if (!demoTenant) return;
  const now = "2025-01-01T00:00:00.000Z";
  onboardingState.set(demoTenant.id, {
    tenant_id: demoTenant.id,
    current_step: "go_live",
    completed_steps: [
      "business",
      "location",
      "connect",
      "menu",
      "plan",
      "go_live",
    ],
    live: true,
    created_at: now,
    updated_at: now,
  });
  subscriptions.set(demoTenant.id, {
    id: `sub_sim_${demoTenant.id.replace(/-/g, "").slice(0, 16)}`,
    tenant_id: demoTenant.id,
    tier: "pro",
    status: "active",
    current_period_end: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    trial_end: null,
    cancel_at_period_end: false,
    simulated: true,
    stripe_customer_id: `cus_sim_${demoTenant.id.replace(/-/g, "").slice(0, 16)}`,
    stripe_subscription_id: `sub_stripe_sim_${demoTenant.id.replace(/-/g, "").slice(0, 16)}`,
    created_at: now,
    updated_at: now,
  });
})();

/** Per-location overrides keyed `${location}:${type}:${target}`. */
const overrides = new Map<string, LocationMenuOverride>();

/** Per-location inventory rows keyed by id. */
const inventoryItems = new Map<string, InventoryItem>(
  seedInventoryItems.map((i) => [i.id, { ...i }]),
);
/** Recipe links (tenant-level). */
const itemInventoryLinks: ItemInventoryLink[] = seedItemInventoryLinks.map(
  (l) => ({ ...l }),
);
const inventoryMovements: InventoryMovement[] = [];

/** Staff keyed by id. */
const staffById = new Map<string, Staff>(
  seedStaff.map((s) => [s.id, { ...s }]),
);
const shifts = new Map<string, Shift>();
const shiftCashEvents: ShiftCashEvent[] = [];
const businessDayCloses = new Map<string, BusinessDayClose>();

/** Process-lifetime order store, keyed by client UUID for idempotent upsert. */
const orders = new Map<string, Order>();

/** Per-tenant POS settings (core v1). Absent = defaults. */
const tenantSettings = new Map<string, TenantSettings>();
/** Payment tenders keyed by client UUID (idempotency key). */
const payments = new Map<string, Payment>();
/** Per-tender refund locks (payments.refund_lock_until / _owner). */
const refundLocks = new Map<string, { owner: string; until: string }>();
/** The order_adjustments ledger (refunds, voids, comps), append-only. */
const adjustmentRecords: AdjustmentRecord[] = [];
/** Statuses an order can be voided / comped / discounted in (same as apply_order_edit). */
const EDITABLE_ORDER_STATUSES: OrderStatus[] = [
  "draft",
  "placed",
  "paid",
  "in_kitchen",
  "ready",
  "recall",
  "out_for_delivery",
  "completed",
];
const paymentSessions = new Map<string, PaymentSessionRow>();
const storedQuotes = new Map<string, StoredQuote>();
/** Terminal PIN switch-in sessions keyed by id (server-side revocation). */
const staffSessions = new Map<string, StaffSession>();
/** Per-staff PIN failure counters / locks (mirrors staff.pin_* columns). */
const pinLocks = new Map<string, { attempts: number; lockedUntil: number | null }>();
const PIN_MAX_FAILURES = 5;
const PIN_LOCK_MS = 15 * 60_000;
/** Per-device / per-location PIN attempt budgets (mirrors pin_attempt_limits). */
const pinLimits = new Map<
  string,
  { attempts: number; windowStart: number; lockedUntil: number | null }
>();
/** Connect onboarding status keyed by tenant id. */
const connectAccounts = new Map<string, ConnectAccount>();
/** Stripe Terminal locations keyed by POS location id; readers keyed by tmr_ id. */
const terminalLocations = new Map<string, TerminalLocation>();
const terminalReaders = new Map<string, TerminalReader>();
/**
 * Network printing: printers, their job queue, per-location auto-print. Held on
 * globalThis so the admin, kitchen and device routes (separate bundles in
 * `next dev`) share one queue in the zero-env demo.
 */
const printStore = ((globalThis as { __posMockPrint?: unknown }).__posMockPrint ??= {
  printers: new Map<string, Printer>(),
  printJobs: new Map<string, PrintJob>(),
  printSettings: new Map<string, PrintLocationSettings>(),
}) as {
  printers: Map<string, Printer>;
  printJobs: Map<string, PrintJob>;
  printSettings: Map<string, PrintLocationSettings>;
};
const { printers, printJobs, printSettings } = printStore;
/** Online-ordering customers keyed by id. */
const customers = new Map<string, Customer>();
/** Magic-link tokens (stubbed, never emailed) keyed by token. */
const magicLinks = new Map<string, MagicLinkToken>();
/** Deliveries keyed by id. */
const deliveries = new Map<string, DeliveryRecord>();
const allergenPublications = new Map<string, AllergenPublicationRecord>();
/** The latest published matrix per tenant. */
const allergenRows = new Map<string, AllergenRow[]>();
let orderSeq = 0;

/**
 * Server-side line stamps (the Postgres triggers' twin, migration
 * 20261104000000): a line is fired when its order is live; a line voided when
 * the order is written carries `voided_at` + the order's status and is never
 * fired (it never reached the kitchen).
 */
function stampNewLines(items: OrderItem[], status: OrderStatus, at: string): OrderItem[] {
  const live = isLiveOrderStatus(status);
  return items.map((i) => ({
    ...i,
    fired_at: i.voided ? null : live ? at : null,
    voided_at: i.voided ? at : null,
    status_at_void: i.voided ? status : null,
  }));
}

/** An order that just became live fires its unfired, unvoided lines. */
function fireLines(order: Order, prev: OrderStatus, at: string): OrderItem[] {
  if (isLiveOrderStatus(prev) || !isLiveOrderStatus(order.status)) return order.items;
  return order.items.map((i) =>
    i.voided || i.fired_at ? i : { ...i, fired_at: at },
  );
}


/** A job the printer may take now: queued, or sent but unconfirmed too long (retry). */
function claimable(
  j: PrintJob,
  printerId: string,
  nowIsoStr: string,
  reclaimBeforeIso: string,
): boolean {
  return (
    j.printer_id === printerId &&
    j.expires_at > nowIsoStr &&
    ((j.status === "queued" && (!j.retry_after || j.retry_after <= nowIsoStr)) ||
      (j.status === "sent" && !!j.claimed_at && j.claimed_at <= reclaimBeforeIso))
  );
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Unique id for mock-created rows. A real UUID (like the Supabase driver's
 * `genUuid`) so mock data also satisfies the core contract's id format; the
 * prefix is kept only as a readability hint in the signature.
 */
function genId(_prefix: string): string {
  return globalThis.crypto.randomUUID();
}

/** Slugify a name into a URL-safe slug, made unique against `existing`. */
function uniqueSlug(name: string, existing: Set<string>): string {
  const base =
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "tenant";
  if (!existing.has(base)) return base;
  let n = 2;
  while (existing.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

/** In-place remove of every element matching `pred` (mutates `arr`). */
function removeWhere<T>(arr: T[], pred: (item: T) => boolean): void {
  for (let i = arr.length - 1; i >= 0; i -= 1) {
    const el = arr[i];
    if (el !== undefined && pred(el)) arr.splice(i, 1);
  }
}

let kitchenSeeded = false;
function ensureKitchenSeed(): void {
  if (kitchenSeeded) return;
  kitchenSeeded = true;
  for (const order of seedKitchenOrders()) {
    if (!orders.has(order.id)) orders.set(order.id, order);
  }
}

// ---------------------------------------------------------------------------
// Override helpers
// ---------------------------------------------------------------------------
function overrideKey(
  locationId: string,
  type: OverrideTargetType,
  targetId: string,
): string {
  return `${locationId}:${type}:${targetId}`;
}

function getOverride(
  locationId: string,
  type: OverrideTargetType,
  targetId: string,
): LocationMenuOverride | undefined {
  return overrides.get(overrideKey(locationId, type, targetId));
}

function buildMenuItemDetail(
  itemId: string,
  locationId: string,
  includeUnavailable = false,
): MenuItemDetail | null {
  const item = menuItems.find((i) => i.id === itemId);
  if (!item) return null;

  // Apply per-location price overrides to sizes.
  const sizes = itemSizes
    .filter((s) => s.item_id === itemId)
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((s) => {
      const ov = getOverride(locationId, "size", s.id);
      return ov?.price_cents != null
        ? { ...s, price_cents: ov.price_cents }
        : s;
    });

  const groupLinks = itemModifierGroups
    .filter((l) => l.item_id === itemId)
    .sort((a, b) => a.sort_order - b.sort_order);

  const modifierGroupsForItem: MenuModifierGroup[] = groupLinks
    .map((link) => {
      const group = modifierGroups.find((g) => g.id === link.group_id);
      if (!group) return null;
      const mods = modifiers
        .filter((m) => m.group_id === group.id)
        // 86'd modifiers drop out of the customer menu graph for this location;
        // the back office keeps them (flagged) so they can be un-86'd.
        .filter(
          (m) =>
            includeUnavailable ||
            getOverride(locationId, "modifier", m.id)?.available !== false,
        )
        .sort((a, b) => a.sort_order - b.sort_order)
        .map((m) => {
          const ov = getOverride(locationId, "modifier", m.id);
          return ov?.price_cents != null
            ? { ...m, price_cents: ov.price_cents }
            : m;
        });
      return { ...group, modifiers: mods } satisfies MenuModifierGroup;
    })
    .filter((g): g is MenuModifierGroup => g !== null);

  return { ...item, sizes, modifierGroups: modifierGroupsForItem };
}

function assembleMenu(
  tenantId: string,
  locationId: string,
  includeUnavailable = false,
): Menu {
  const categories: MenuCategoryWithItems[] = menuCategories
    .filter((c) => c.tenant_id === tenantId)
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((category) => {
      const items = menuItems
        .filter(
          (i) => i.tenant_id === tenantId && i.category_id === category.id,
        )
        // An item 86'd at this location drops out of the CUSTOMER menu entirely;
        // the back office (includeUnavailable) keeps it so it can be un-86'd.
        .filter(
          (i) =>
            includeUnavailable ||
            getOverride(locationId, "item", i.id)?.available !== false,
        )
        .map((i) => buildMenuItemDetail(i.id, locationId, includeUnavailable))
        .filter((d): d is MenuItemDetail => d !== null);
      return { ...category, items } satisfies MenuCategoryWithItems;
    });

  return { tenantId, locationId, categories };
}

function nextOrderNumber(): string {
  orderSeq += 1;
  return `A-${String(orderSeq).padStart(4, "0")}`;
}

function categoryOfItem(itemId: string): { id: string; name: string } | null {
  const item = menuItems.find((i) => i.id === itemId);
  if (!item) return null;
  const cat = menuCategories.find((c) => c.id === item.category_id);
  return cat ? { id: cat.id, name: cat.name } : null;
}

function locationName(locationId: string): string {
  return locations.find((l) => l.id === locationId)?.name ?? locationId;
}

// ---------------------------------------------------------------------------
// Inventory depletion. Walks an order's lines + their modifiers, resolves the
// per-location inventory row for each linked recipe component (matched by name
// so the tenant-level link works at any location), and decrements it. Records a
// `depletion` movement per affected row. Best-effort: a missing row is skipped.
// ---------------------------------------------------------------------------
function resolveLocationInventory(
  templateInventoryId: string,
  tenantId: string,
  locationId: string,
): InventoryItem | undefined {
  const template = inventoryItems.get(templateInventoryId);
  // Exact row already at this location? Use it directly.
  if (template && template.location_id === locationId) return template;
  if (!template) return undefined;
  // Match by name within the same tenant + location.
  for (const inv of inventoryItems.values()) {
    if (
      inv.tenant_id === tenantId &&
      inv.location_id === locationId &&
      inv.name === template.name
    ) {
      return inv;
    }
  }
  return undefined;
}

function depleteForOrder(order: Order): void {
  // Back-of-house owns inventory for this tenant: POS must not deplete.
  if (tenantSettings.get(order.tenant_id)?.inventory_owner === "backofhouse") {
    return;
  }
  // Aggregate consumption per resolved inventory row id.
  const consumption = new Map<string, number>();

  const addLink = (
    sourceType: "item" | "modifier",
    sourceId: string,
    units: number,
  ) => {
    for (const link of itemInventoryLinks) {
      if (link.source_type !== sourceType || link.source_id !== sourceId) {
        continue;
      }
      const inv = resolveLocationInventory(
        link.inventory_item_id,
        order.tenant_id,
        order.location_id,
      );
      if (!inv) continue;
      consumption.set(
        inv.id,
        (consumption.get(inv.id) ?? 0) + link.qty_per_unit * units,
      );
    }
  };

  for (const line of order.items) {
    if (line.voided) continue;
    addLink("item", line.item_id, line.quantity);
    for (const mod of line.modifiers) {
      addLink("modifier", mod.modifier_id, line.quantity);
    }
  }

  for (const [invId, qty] of consumption) {
    if (qty <= 0) continue;
    // Per-item idempotent: an inventory row this order already depleted is
    // skipped, so re-running after a crash never double-counts any item.
    if (
      inventoryMovements.some(
        (m) =>
          m.order_id === order.id &&
          m.inventory_item_id === invId &&
          m.reason === "depletion",
      )
    ) {
      continue;
    }
    applyMovementInternal({
      inventoryItemId: invId,
      reason: "depletion",
      delta: -qty,
      orderId: order.id,
      note: `Sold on order ${order.order_number}`,
    });
  }
}

function applyMovementInternal(input: {
  inventoryItemId: string;
  reason: MovementReason;
  delta: number;
  orderId?: string | null;
  note?: string | null;
}): { item: InventoryItem; movement: InventoryMovement } | null {
  const item = inventoryItems.get(input.inventoryItemId);
  if (!item) return null;
  const newOnHand = Math.max(0, item.on_hand + input.delta);
  const updated: InventoryItem = {
    ...item,
    on_hand: newOnHand,
    updated_at: nowIso(),
  };
  inventoryItems.set(updated.id, updated);
  const movement: InventoryMovement = {
    id: genId("mov"),
    tenant_id: item.tenant_id,
    location_id: item.location_id,
    inventory_item_id: item.id,
    reason: input.reason,
    delta: input.delta,
    resulting_on_hand: newOnHand,
    order_id: input.orderId ?? null,
    note: input.note ?? null,
    created_at: nowIso(),
  };
  inventoryMovements.push(movement);
  return { item: updated, movement };
}

// ---------------------------------------------------------------------------
// Shift / drawer helpers
// ---------------------------------------------------------------------------
function computeReconciliation(shift: Shift): DrawerReconciliation {
  const events = shiftCashEvents.filter((e) => e.shift_id === shift.id);
  let cashSales = 0;
  let paidIn = 0;
  let payouts = 0;
  for (const e of events) {
    if (e.type === "sale") cashSales += e.amount_cents;
    else if (e.type === "paid_in") paidIn += e.amount_cents;
    else payouts += Math.abs(e.amount_cents); // payout/drop
  }
  const expected = shift.opening_float_cents + cashSales + paidIn - payouts;
  const counted = shift.counted_cents;
  return {
    opening_float_cents: shift.opening_float_cents,
    cash_sales_cents: cashSales,
    paid_in_cents: paidIn,
    payouts_cents: payouts,
    expected_cents: expected,
    counted_cents: counted,
    over_short_cents: counted == null ? null : counted - expected,
  };
}

export const mockDriver: PosDriver = {
  name: "mock",

  // -- Tenancy + self-serve SaaS (Phase 6) -----------------------------------

  async listTenants(): Promise<Tenant[]> {
    return tenants
      .slice()
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .map((t) => ({ ...t }));
  },

  async getTenant(tenantId: string): Promise<Tenant | null> {
    return tenants.find((t) => t.id === tenantId) ?? null;
  },

  async createTenant(
    input: CreateTenantInput,
  ): Promise<{ tenant: Tenant; owner: User }> {
    const now = nowIso();
    const slug = uniqueSlug(
      input.businessName,
      new Set(tenants.map((t) => t.slug)),
    );
    const tenant: Tenant = {
      id: genId("tenant"),
      name: input.businessName.trim(),
      slug,
      // New tenants start suspended (pre-go-live); goLive() flips to active.
      status: "suspended",
      created_at: now,
    };
    tenants.push(tenant);

    // Model the owner as a User + an owner Membership (so Phase 7/Supabase can
    // make auth real). Reuse an existing user row if the email already exists.
    const email = input.ownerEmail.trim().toLowerCase();
    let owner = [...usersById.values()].find((u) => u.email === email);
    if (!owner) {
      owner = { id: genId("user"), email, created_at: now };
      usersById.set(owner.id, owner);
    }

    // Initialise onboarding at the first step.
    onboardingState.set(tenant.id, {
      tenant_id: tenant.id,
      current_step: "location",
      completed_steps: ["business"],
      live: false,
      created_at: now,
      updated_at: now,
    });

    return { tenant: { ...tenant }, owner: { ...owner } };
  },

  async setTenantStatus(
    tenantId: string,
    status: Tenant["status"],
    opts?: { byPlatform?: boolean },
  ): Promise<Tenant | null> {
    const t = tenants.find((x) => x.id === tenantId);
    if (!t) return null;
    t.status = status;
    if (opts?.byPlatform) t.suspended_by_platform = status === "suspended";
    return { ...t };
  },

  async setLocationCountry(tenantId, locationId, country) {
    const i = locations.findIndex((l) => l.id === locationId && l.tenant_id === tenantId);
    if (i < 0) return null;
    locations[i] = { ...locations[i]!, country };
    return { ...locations[i]! };
  },

  async createLocation(input: CreateLocationInput): Promise<Location> {
    const now = nowIso();
    // Slugs are unique WITHIN a tenant (DB: unique (tenant_id, slug)) — two
    // tenants may both have e.g. "downtown"; storefront URLs carry the tenant
    // slug to disambiguate. "track" is reserved by the legacy tracking route.
    const slug = uniqueSlug(
      input.name,
      new Set([
        "track",
        ...locations
          .filter((l) => l.tenant_id === input.tenant_id)
          .map((l) => l.slug),
      ]),
    );
    const location: Location = {
      id: genId("loc"),
      tenant_id: input.tenant_id,
      name: input.name.trim(),
      slug,
      timezone: input.timezone ?? "America/New_York",
      address: input.address ?? null,
      ...(input.country ? { country: input.country } : {}),
      created_at: now,
    };
    locations.push(location);

    // Give the new location its own store + payment settings (sensible defaults
    // mirroring the demo) so terminal/shop/checkout work immediately.
    storeSettings.push({
      tenant_id: input.tenant_id,
      location_id: location.id,
      currency: "USD",
      tax_rate_bps: 825,
      tip_presets_bps: [1500, 1800, 2000],
      kds_thresholds: { warn_seconds: 300, urgent_seconds: 600 },
      fulfillment: {
        pickup_enabled: true,
        delivery_enabled: false,
        prep_minutes: 20,
        scheduling_lead_minutes: 15,
        scheduling_horizon_days: 5,
        hours: Array.from({ length: 7 }, (_, weekday) => ({
          weekday,
          open: "11:00",
          close: "22:00",
          closed: false,
        })),
        delivery_providers: ["in_house_manual"],
        pickup_address: input.address ?? undefined,
        delivery_zones: [],
      },
    });
    paymentSettings.push({
      tenant_id: input.tenant_id,
      location_id: location.id,
      currency: "USD",
      platform_fee_bps: 250,
      platform_fee_flat_cents: 10,
      tip_presets_bps: [1500, 1800, 2000],
    });

    return { ...location };
  },

  async importStarterMenu(tenantId: string): Promise<void> {
    // Idempotent-ish: skip if this tenant already has categories.
    if (menuCategories.some((c) => c.tenant_id === tenantId)) return;
    const tpl = buildStarterMenu(tenantId);
    menuCategories.push(...tpl.categories);
    menuItems.push(...tpl.items);
    itemSizes.push(...tpl.sizes);
    modifierGroups.push(...tpl.modifierGroups);
    modifiers.push(...tpl.modifiers);
    itemModifierGroups.push(...tpl.itemModifierGroups);
  },

  // -- Onboarding state ------------------------------------------------------

  async getOnboarding(tenantId: string): Promise<TenantOnboarding | null> {
    return onboardingState.get(tenantId) ?? null;
  },

  async completeOnboardingStep(
    tenantId: string,
    step: OnboardingStep,
  ): Promise<TenantOnboarding> {
    const now = nowIso();
    const existing =
      onboardingState.get(tenantId) ??
      ({
        tenant_id: tenantId,
        current_step: "business",
        completed_steps: [],
        live: false,
        created_at: now,
        updated_at: now,
      } satisfies TenantOnboarding);
    const completed = existing.completed_steps.includes(step)
      ? existing.completed_steps
      : [...existing.completed_steps, step];
    // current_step = the next not-yet-complete step in canonical order.
    const next =
      ONBOARDING_STEPS.find((s) => !completed.includes(s)) ?? "go_live";
    const updated: TenantOnboarding = {
      ...existing,
      completed_steps: completed,
      current_step: next,
      updated_at: now,
    };
    onboardingState.set(tenantId, updated);
    return { ...updated };
  },

  async goLive(tenantId: string): Promise<TenantOnboarding> {
    const now = nowIso();
    const ob = await this.completeOnboardingStep(tenantId, "go_live");
    const updated: TenantOnboarding = { ...ob, live: true, updated_at: now };
    onboardingState.set(tenantId, updated);
    // Activate the tenant on go-live.
    const t = tenants.find((x) => x.id === tenantId);
    if (t) t.status = "active";
    return { ...updated };
  },

  // -- Subscriptions ---------------------------------------------------------

  async getSubscription(tenantId: string): Promise<Subscription | null> {
    return subscriptions.get(tenantId) ?? null;
  },

  async upsertSubscription(sub: Subscription): Promise<Subscription> {
    const existing = subscriptions.get(sub.tenant_id);
    const merged: Subscription = {
      ...sub,
      created_at: existing?.created_at ?? sub.created_at ?? nowIso(),
      updated_at: nowIso(),
    };
    subscriptions.set(sub.tenant_id, merged);
    return { ...merged };
  },

  async advanceSubscriptionStatus(
    tenantId: string,
    status: Subscription["status"],
  ): Promise<Subscription | null> {
    const sub = subscriptions.get(tenantId);
    if (!sub) return null;
    const updated: Subscription = {
      ...sub,
      status,
      // Leaving dunning / converting from trial extends the period.
      current_period_end:
        status === "active"
          ? new Date(Date.now() + 30 * 86_400_000).toISOString()
          : sub.current_period_end,
      trial_end: status === "active" ? null : sub.trial_end,
      updated_at: nowIso(),
    };
    subscriptions.set(tenantId, updated);
    return { ...updated };
  },

  async changeSubscriptionTier(
    tenantId: string,
    tier: PlanTier,
  ): Promise<Subscription | null> {
    const sub = subscriptions.get(tenantId);
    if (!sub) return null;
    const updated: Subscription = { ...sub, tier, updated_at: nowIso() };
    subscriptions.set(tenantId, updated);
    return { ...updated };
  },

  async getPendingBillingCheckout(tenantId) {
    const p = pendingBillingCheckouts.get(tenantId);
    return p ? { ...p } : null;
  },

  // Single-threaded JS: check + set is atomic (mirrors the DB's conditional
  // insert on the tenant_id primary key).
  async claimPendingBillingCheckout(rec) {
    const cur = pendingBillingCheckouts.get(rec.tenant_id);
    if (cur && new Date(cur.expires_at).getTime() > Date.now()) {
      return { claimed: false, current: { ...cur } };
    }
    pendingBillingCheckouts.set(rec.tenant_id, { ...rec });
    return { claimed: true, current: { ...rec } };
  },

  async clearPendingBillingCheckout(tenantId, sessionId) {
    if (pendingBillingCheckouts.get(tenantId)?.session_id === sessionId) {
      pendingBillingCheckouts.delete(tenantId);
    }
  },

  // -- Platform admin + health -----------------------------------------------

  async isPlatformAdmin(userId: string): Promise<boolean> {
    return platformAdmins.some((a) => a.user_id === userId);
  },

  async listPlatformAdmins(): Promise<PlatformAdmin[]> {
    return platformAdmins.map((a) => ({ ...a }));
  },

  async getUser(userId: string): Promise<User | null> {
    return usersById.get(userId) ?? null;
  },

  async getUserEmails(userIds: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const id of userIds) {
      const u = usersById.get(id);
      if (u) out.set(id, u.email);
    }
    return out;
  },

  async getUserByEmail(email: string): Promise<User | null> {
    const target = email.trim().toLowerCase();
    for (const u of usersById.values()) {
      if (u.email.toLowerCase() === target) return { ...u };
    }
    return null;
  },

  async listMembershipsForUser(userId: string): Promise<Membership[]> {
    return memberships
      .filter((m) => m.user_id === userId)
      .map((m) => ({ ...m }));
  },

  async listTenantHealth(): Promise<TenantHealth[]> {
    ensureKitchenSeed();
    const since = Date.now() - 30 * 86_400_000; // trailing 30 days
    const out: TenantHealth[] = [];
    for (const t of tenants) {
      const locs = locations.filter((l) => l.tenant_id === t.id);
      const recent = [...orders.values()].filter(
        (o) =>
          o.tenant_id === t.id &&
          o.status !== "voided" &&
          !isUnpaidOnlineStatus(o.status) &&
          new Date(o.created_at).getTime() >= since,
      );
      const connect = connectAccounts.get(t.id);
      out.push({
        tenant_id: t.id,
        name: t.name,
        slug: t.slug,
        status: t.status,
        location_count: locs.length,
        recent_order_count: recent.length,
        recent_gross_cents: recent.reduce(
          (sum, o) => sum + o.totals.total_cents,
          0,
        ),
        subscription: subscriptions.get(t.id) ?? null,
        onboarding: onboardingState.get(t.id) ?? null,
        connected: isConnectedForHealth(connect ?? null),
      });
    }
    return out;
  },

  // -- Audit log -------------------------------------------------------------

  async appendAuditLog(
    entry: Omit<AuditLogEntry, "id" | "created_at">,
  ): Promise<AuditLogEntry> {
    const created: AuditLogEntry = {
      ...entry,
      id: genId("audit"),
      created_at: nowIso(),
    };
    auditLog.push(created);
    return { ...created };
  },

  async listAuditLog(tenantId?: string): Promise<AuditLogEntry[]> {
    return auditLog
      .filter((e) => !tenantId || e.tenant_id === tenantId)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .map((e) => ({ ...e }));
  },

  async listLocations(tenantId: string): Promise<Location[]> {
    // Same order as the Supabase driver: (created_at, id).
    return locations
      .filter((l) => l.tenant_id === tenantId)
      .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  },

  async getTenantBySlug(slug: string): Promise<Tenant | null> {
    const t = tenants.find((x) => x.slug === slug);
    return t ? { ...t } : null;
  },

  async getLocationBySlugs(
    tenantSlug: string,
    locationSlug: string,
  ): Promise<Location | null> {
    const tenant = tenants.find((t) => t.slug === tenantSlug);
    if (!tenant) return null;
    const loc = locations.find(
      (l) => l.tenant_id === tenant.id && l.slug === locationSlug,
    );
    return loc ? { ...loc } : null;
  },

  async listLocationsBySlug(slug: string): Promise<Location[]> {
    return locations.filter((l) => l.slug === slug).map((l) => ({ ...l }));
  },

  async getMenu(tenantId, locationId, opts): Promise<Menu> {
    return assembleMenu(tenantId, locationId, opts?.includeUnavailable);
  },

  async getStoreSettings(tenantId, locationId): Promise<StoreSettings> {
    const found = storeSettings.find(
      (s) => s.tenant_id === tenantId && s.location_id === locationId,
    );
    if (found) return found;
    return {
      tenant_id: tenantId,
      location_id: locationId,
      currency: "USD",
      tax_rate_bps: 0,
      tip_presets_bps: [1500, 1800, 2000],
      kds_thresholds: { warn_seconds: 300, urgent_seconds: 600 },
    };
  },

  async setAdjustmentPolicy(tenantId, locationId, policy): Promise<StoreSettings> {
    const current = await this.getStoreSettings(tenantId, locationId);
    const next: StoreSettings = { ...current, adjustment_policy: { ...policy } };
    const idx = storeSettings.findIndex(
      (s) => s.tenant_id === tenantId && s.location_id === locationId,
    );
    if (idx >= 0) storeSettings[idx] = next;
    else storeSettings.push(next);
    return { ...next };
  },

  async listOrderAdjustments(orderId: string): Promise<AdjustmentRecord[]> {
    return adjustmentRecords
      .filter((r) => r.order_id === orderId)
      .map((r) => structuredClone(r));
  },

  async listOrderAdjustmentsForOrders(orderIds: string[]): Promise<AdjustmentRecord[]> {
    const wanted = new Set(orderIds);
    return adjustmentRecords.filter((r) => wanted.has(r.order_id)).map((r) => structuredClone(r));
  },

  // Mirrors begin_order_refund(): one synchronous block (no awaits), so it is
  // atomic in the single-threaded mock exactly as the SQL is under its lock.
  async beginOrderRefund(record: AdjustmentRecord): Promise<BeginRefundResult> {
    const order = orders.get(record.order_id);
    if (!order || order.tenant_id !== record.tenant_id) return { outcome: "not_found" };
    const prior = adjustmentRecords.find(
      (r) => r.order_id === record.order_id && r.id === record.id,
    );
    if (prior) return { outcome: "duplicate", record: structuredClone(prior) };
    for (const sel of record.lines) {
      const line = order.items.find((i) => i.id === sel.line_id);
      const used = adjustmentRecords
        .filter((r) => r.order_id === order.id && r.kind === "refund" && r.status !== "failed")
        .flatMap((r) => r.lines)
        .filter((l) => l.line_id === sel.line_id)
        .reduce((n, l) => n + l.quantity, 0);
      const available = line && !line.voided ? Math.max(0, line.quantity - used) : 0;
      if (sel.quantity <= 0 || sel.quantity > available) {
        return { outcome: "exceeds", line_id: sel.line_id, available };
      }
    }
    const now = nowIso();
    const stored: AdjustmentRecord = {
      ...structuredClone(record),
      status: "pending",
      created_at: now,
      updated_at: now,
    };
    adjustmentRecords.push(stored);
    return { outcome: "ok", record: structuredClone(stored) };
  },

  // Mirrors reopen_order_refund(): synchronous, atomic in the mock.
  async reopenOrderRefund(orderId: string, id: string): Promise<BeginRefundResult> {
    const order = orders.get(orderId);
    const idx = adjustmentRecords.findIndex((r) => r.order_id === orderId && r.id === id);
    if (!order || idx < 0) return { outcome: "not_found" };
    const rec = adjustmentRecords[idx]!;
    if (rec.status !== "failed") return { outcome: "duplicate", record: structuredClone(rec) };
    for (const sel of rec.lines) {
      const line = order.items.find((i) => i.id === sel.line_id);
      const used = adjustmentRecords
        .filter((r) => r.order_id === orderId && r.kind === "refund" && r.status !== "failed")
        .flatMap((r) => r.lines)
        .filter((l) => l.line_id === sel.line_id)
        .reduce((n, l) => n + l.quantity, 0);
      const available = line && !line.voided ? Math.max(0, line.quantity - used) : 0;
      if (sel.quantity > available) return { outcome: "exceeds", line_id: sel.line_id, available };
    }
    const next: AdjustmentRecord = { ...rec, status: "pending", updated_at: nowIso() };
    adjustmentRecords[idx] = next;
    return { outcome: "ok", record: structuredClone(next) };
  },

  // Mirrors claim_order_adjustment(): synchronous, atomic in the mock.
  async claimOrderAdjustment(orderId: string, id: string, untilIso: string): Promise<boolean> {
    const idx = adjustmentRecords.findIndex((r) => r.order_id === orderId && r.id === id);
    if (idx < 0) return false;
    const cur = adjustmentRecords[idx]!;
    if (cur.claimed_until && cur.claimed_until > nowIso()) return false;
    adjustmentRecords[idx] = { ...cur, claimed_until: untilIso };
    return true;
  },

  async listStalePendingRefunds(beforeIso: string, limit: number): Promise<AdjustmentRecord[]> {
    return adjustmentRecords
      .filter((r) => r.kind === "refund" && r.status === "pending" && r.updated_at < beforeIso)
      .sort((a, b) => a.updated_at.localeCompare(b.updated_at))
      .slice(0, limit)
      .map((r) => structuredClone(r));
  },

  async finishOrderAdjustment(orderId, id, patch): Promise<AdjustmentRecord | null> {
    const idx = adjustmentRecords.findIndex((r) => r.order_id === orderId && r.id === id);
    if (idx < 0) return null;
    const next: AdjustmentRecord = {
      ...adjustmentRecords[idx]!,
      status: patch.status,
      allocations: structuredClone(patch.allocations),
      claimed_until: patch.keepClaim ? (adjustmentRecords[idx]!.claimed_until ?? null) : null,
      ...(patch.meta !== undefined
        ? { meta: { ...(adjustmentRecords[idx]!.meta ?? {}), ...(patch.meta ?? {}) } }
        : {}),
      updated_at: nowIso(),
    };
    adjustmentRecords[idx] = next;
    return structuredClone(next);
  },

  // Mirrors apply_order_edit(): compare-and-set on the version + the money
  // checks + the ledger insert, in one synchronous block (atomic in the mock).
  async applyOrderEdit(write: OrderEditWrite): Promise<OrderEditResult> {
    const order = orders.get(write.orderId);
    if (!order || order.tenant_id !== write.tenantId) return { outcome: "not_found" };
    const prior = adjustmentRecords.find(
      (r) => r.order_id === write.orderId && r.id === write.record.id,
    );
    if (prior) return { outcome: "duplicate", record: structuredClone(prior) };
    if ((order.version ?? 1) !== write.expectVersion) return { outcome: "stale" };
    if (!EDITABLE_ORDER_STATUSES.includes(order.status)) {
      return { outcome: "invalid_state", reason: `order is ${order.status}` };
    }
    const mine = [...payments.values()].filter((p) => p.order_id === order.id);
    const ext = order.core_ext as Record<string, unknown> | null | undefined;
    if (
      (order.channel as string) === "marketplace" ||
      order.source?.channel === "marketplace" ||
      (ext && Object.prototype.hasOwnProperty.call(ext, "stored_value"))
    ) {
      return { outcome: "invalid_state", reason: "not_adjustable" };
    }
    if (!write.voidOrder && mine.some((p) => p.refunded_cents > 0)) {
      return { outcome: "invalid_state", reason: "refund_exists" };
    }
    if (write.voidOrder) {
      const inFlight = mine.some(
        (p) =>
          ["pending", "authorized", "requires_action"].includes(p.status) &&
          !(p.rail === "external" && p.status === "pending"),
      );
      if (inFlight) return { outcome: "invalid_state", reason: "in_flight" };
      const held = mine.some(
        (p) => p.status === "captured" && p.amount_cents + p.tip_cents > p.refunded_cents,
      );
      if (held) return { outcome: "invalid_state", reason: "captured" };
    } else {
      const due = foodDueCents({ totals: write.totals });
      if (coveredBaseCents(mine, order.currency) > due) {
        return { outcome: "invalid_state", reason: "paid_exceeds" };
      }
    }
    const at = nowIso();
    const voidIds = new Set(write.voidLineIds);
    const items: OrderItem[] = [];
    for (const line of order.items) {
      if (voidIds.has(line.id)) {
        items.push({
          ...line,
          voided: true,
          line_total_cents: 0,
          voided_at: at,
          status_at_void: order.status,
        });
        continue;
      }
      const split = write.splits.find((x) => x.line_id === line.id);
      if (!split) {
        items.push(line);
        continue;
      }
      items.push({
        ...line,
        quantity: split.keep_quantity,
        line_total_cents: line.unit_price_cents * split.keep_quantity,
      });
      items.push({
        ...line,
        id: split.new_line_id,
        quantity: split.void_quantity,
        voided: true,
        line_total_cents: 0,
        voided_at: at,
        status_at_void: order.status,
      });
    }
    const updated: Order = {
      ...order,
      items,
      totals: write.totals,
      discount_cents: write.discountCents,
      adjustments: structuredClone(write.adjustments),
      status: write.voidOrder ? "voided" : order.status,
      version: (order.version ?? 1) + 1,
      updated_at: at,
    };
    orders.set(order.id, updated);
    const record: AdjustmentRecord = {
      ...structuredClone(write.record),
      created_at: at,
      updated_at: at,
    };
    adjustmentRecords.push(record);
    return { outcome: "ok", order: updated, record: structuredClone(record) };
  },

  async setMarketplaceSettings(
    tenantId,
    locationId,
    marketplace,
  ): Promise<StoreSettings> {
    const base = await this.getStoreSettings(tenantId, locationId);
    const next: StoreSettings = { ...base, marketplace };
    const i = storeSettings.findIndex(
      (s) => s.tenant_id === tenantId && s.location_id === locationId,
    );
    if (i >= 0) storeSettings[i] = next;
    else storeSettings.push(next);
    return next;
  },

  async findMarketplaceLocations(provider, storeId) {
    const row = marketplaceStores.get(`${provider}:${storeId}`);
    return row ? [{ tenant_id: row.tenantId, location_id: row.locationId }] : [];
  },

  async assignMarketplaceStore(input) {
    const mine = () =>
      [...marketplaceStores].filter(
        ([, v]) => v.provider === input.provider && v.locationId === input.locationId,
      );
    if (input.storeId === null) {
      for (const [k] of mine()) marketplaceStores.delete(k);
      return;
    }
    const key = `${input.provider}:${input.storeId}`;
    const holder = marketplaceStores.get(key);
    // A clash with another location leaves the existing assignment intact.
    if (holder && holder.locationId !== input.locationId) throw new MarketplaceStoreTakenError();
    for (const [k] of mine()) marketplaceStores.delete(k);
    marketplaceStores.set(key, {
      provider: input.provider,
      tenantId: input.tenantId,
      locationId: input.locationId,
    });
  },

  async findMarketplaceOrdersByRef(provider, externalId) {
    ensureKitchenSeed();
    return [...orders.values()].filter(
      (o) =>
        o.source?.type === "marketplace" &&
        o.source.module === provider &&
        o.source.external_ref === externalId,
    );
  },

  async createOrder(input: CreateOrderInput): Promise<Order> {
    const existing = orders.get(input.id);
    if (existing) return existing;

    const now = nowIso();
    const order: Order = {
      id: input.id,
      tenant_id: input.tenant_id,
      location_id: input.location_id,
      status: input.status ?? "placed",
      channel: input.channel,
      currency: input.currency,
      items: stampNewLines(input.items, input.status ?? "placed", now),
      discount_cents: input.discount_cents,
      totals: input.totals,
      notes: input.notes,
      order_number: input.order_number ?? nextOrderNumber(),
      customer_id: input.customer_id ?? null,
      staff_id: input.staff_id ?? null,
      fulfillment: input.fulfillment,
      source: input.source,
      hold: input.hold ?? null,
      core_ext: input.core_ext ?? null,
      adjustments: input.adjustments?.length ? structuredClone(input.adjustments) : null,
      version: 1,
      created_at: now,
      updated_at: now,
    };
    orders.set(order.id, order);
    // Phase 5: deplete linked inventory on the single order funnel (terminal +
    // shop both land here), unless the order was created already voided.
    // An online order awaiting payment (or abandoned) consumes nothing: it is
    // depleted by `depleteInventoryForOrder` once payment finalizes. Held
    // (draft) orders deplete when they are released.
    if (
      order.status !== "voided" &&
      order.status !== "draft" &&
      !isUnpaidOnlineStatus(order.status)
    ) {
      depleteForOrder(order);
    }
    return order;
  },

  async getOrder(id: string): Promise<Order | null> {
    ensureKitchenSeed();
    return orders.get(id) ?? null;
  },

  async listOrders(tenantId, locationId, opts): Promise<Order[]> {
    ensureKitchenSeed();
    const limit = Math.min(Math.max(opts?.limit ?? 1000, 1), 1000);
    return [...orders.values()]
      .filter(
        (o) =>
          o.tenant_id === tenantId &&
          o.location_id === locationId &&
          (!opts?.from || o.created_at >= opts.from) &&
          (!opts?.to || o.created_at <= opts.to),
      )
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(opts?.offset ?? 0, (opts?.offset ?? 0) + limit);
  },

  async listKitchenOrders(tenantId, locationId, opts): Promise<Order[]> {
    ensureKitchenSeed();
    const limit = Math.min(Math.max(opts.limit ?? 500, 1), 500);
    const statuses = new Set<string>(opts.statuses);
    const mine = [...orders.values()]
      .filter((o) => o.tenant_id === tenantId && o.location_id === locationId)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    const active = mine
      .filter((o) => statuses.has(o.status) && o.created_at >= opts.createdSince)
      .slice(0, limit);
    const recent = mine.filter((o) => o.updated_at >= opts.updatedSince).slice(0, limit);
    const seen = new Set(active.map((o) => o.id));
    return [...active, ...recent.filter((o) => !seen.has(o.id))].sort((a, b) =>
      b.created_at.localeCompare(a.created_at),
    );
  },

  async listOrdersPage(tenantId, locationId, opts): Promise<Order[]> {
    ensureKitchenSeed();
    const after = opts.after;
    return [...orders.values()]
      .filter(
        (o) =>
          o.tenant_id === tenantId &&
          o.location_id === locationId &&
          (!opts.createdFrom || o.created_at >= opts.createdFrom) &&
          (!opts.createdTo || o.created_at <= opts.createdTo) &&
          (!opts.updatedSince || o.updated_at >= opts.updatedSince) &&
          (!after ||
            o.created_at > after.created_at ||
            (o.created_at === after.created_at && o.id > after.id)),
      )
      .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
      .slice(0, Math.min(Math.max(opts.limit, 1), 500));
  },

  async listOrderHeads(tenantId, opts) {
    ensureKitchenSeed();
    const after = opts.after;
    const rows = [...orders.values()]
      .filter(
        (o) =>
          o.tenant_id === tenantId &&
          (!opts.locationIds || opts.locationIds.includes(o.location_id)) &&
          (!opts.createdFrom || o.created_at >= opts.createdFrom) &&
          (!opts.createdTo || o.created_at <= opts.createdTo) &&
          (!opts.statuses || opts.statuses.includes(o.status)) &&
          (!after ||
            o.created_at > after.created_at ||
            (o.created_at === after.created_at && o.id > after.id)),
      )
      .sort(
        (a, b) =>
          (a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)) *
          (opts.newestFirst ? -1 : 1),
      )
      .slice(0, Math.min(Math.max(opts.limit, 1), 500));
    return rows.map((o) => ({
      id: o.id,
      tenant_id: o.tenant_id,
      location_id: o.location_id,
      created_at: o.created_at,
      status: o.status,
      hold: o.hold ?? null,
      currency: o.currency,
      staff_id: o.staff_id ?? null,
      totals: { ...o.totals },
    }));
  },

  async getOrdersByIds(tenantId, ids) {
    ensureKitchenSeed();
    return ids.flatMap((id) => {
      const o = orders.get(id);
      return o && o.tenant_id === tenantId ? [o] : [];
    });
  },

  async listRefundedPayments(tenantId, opts) {
    return [...payments.values()]
      .filter(
        (p) =>
          p.tenant_id === tenantId &&
          p.refunded_cents > 0 &&
          p.updated_at >= opts.since &&
          (!opts.locationIds || opts.locationIds.includes(p.location_id)),
      )
      .sort((a, b) => a.updated_at.localeCompare(b.updated_at) || a.id.localeCompare(b.id))
      .slice(0, opts.limit)
      .map((p) => ({ ...p }));
  },

  async casOrderStatus(id, from, to) {
    ensureKitchenSeed();
    const current = orders.get(id);
    if (!current) return { ok: false, reason: "not_found" } as const;
    if (!from.includes(current.status)) {
      return { ok: false, reason: "conflict", order: current } as const;
    }
    const order = (await this.updateOrderStatus(id, to)) as Order;
    return { ok: true, order } as const;
  },

  // Single synchronous block (no awaits): an atomic compare-and-set in the mock.
  async extendOrderHold(id, tenantId, expect, next) {
    ensureKitchenSeed();
    const current = orders.get(id);
    if (!current || current.tenant_id !== tenantId) {
      return { ok: false, reason: "not_found" } as const;
    }
    if (
      current.status !== "draft" ||
      !current.hold ||
      (current.hold.expires_at ?? null) !== expect.expires_at
    ) {
      return { ok: false, reason: "conflict", order: current } as const;
    }
    const order: Order = {
      ...current,
      hold: next,
      version: (current.version ?? 1) + 1,
      updated_at: nowIso(),
    };
    orders.set(id, order);
    return { ok: true, order } as const;
  },

  async cancelOrder(id, tenantId, opts) {
    ensureKitchenSeed();
    const current = orders.get(id);
    if (!current || current.tenant_id !== tenantId) return { ok: false, reason: "not_found" } as const;
    if (current.status === "voided") return { ok: true, order: current } as const;
    if (!["draft", "placed", "paid"].includes(current.status)) {
      return { ok: false, reason: "not_cancelable", order: current } as const;
    }
    const nowMs = opts?.nowMs ?? Date.now();
    const mine = [...payments.values()].filter((p) => p.order_id === id);
    // Same rules as public.core_cancel_order(): stale unsettled tenders (no rail
    // charge) are voided; any other in-flight tender blocks the cancel.
    // A PENDING external tender is a promise (invoice issued, cash still to
    // collect), not money in flight: it never blocks and is voided with the order.
    const inFlight = mine.filter(
      (p) =>
        ["pending", "authorized", "requires_action"].includes(p.status) &&
        !(p.rail === "external" && p.status === "pending"),
    );
    for (const p of inFlight) {
      if (!isStaleUnsettled(p, nowMs)) {
        return { ok: false, reason: "in_flight", order: current } as const;
      }
    }
    if (
      mine.some(
        (p) => p.status === "captured" && p.amount_cents + p.tip_cents > p.refunded_cents,
      )
    ) {
      return { ok: false, reason: "captured", order: current } as const;
    }
    // Void the abandoned attempts (all stale, or we returned above) and any
    // pending external promise.
    for (const p of mine) {
      if (inFlight.includes(p) || (p.rail === "external" && p.status === "pending")) {
        payments.set(p.id, { ...p, status: "canceled", updated_at: nowIso() });
      }
    }
    const order = (await this.updateOrderStatus(id, "voided")) as Order;
    return { ok: true, order } as const;
  },

  async listPaymentsForOrders(orderIds: string[]) {
    const out = new Map<string, Payment[]>();
    const wanted = new Set(orderIds);
    for (const p of [...payments.values()].sort((a, b) =>
      a.created_at.localeCompare(b.created_at),
    )) {
      if (!wanted.has(p.order_id)) continue;
      const list = out.get(p.order_id) ?? [];
      list.push({ ...p });
      out.set(p.order_id, list);
    }
    return out;
  },

  async getCustomers(ids: string[]): Promise<Customer[]> {
    return ids.flatMap((id) => {
      const c = customers.get(id);
      return c ? [{ ...c }] : [];
    });
  },

  async customerOrderStats(tenantId: string, customerIds: string[]) {
    ensureKitchenSeed();
    const wanted = new Set(customerIds);
    const out = new Map<
      string,
      { order_count: number; last_order_at: string | null; lifetime_spend_cents: number }
    >();
    for (const o of orders.values()) {
      if (
        o.tenant_id !== tenantId ||
        !o.customer_id ||
        !wanted.has(o.customer_id) ||
        o.status === "voided" ||
        o.status === "draft"
      ) {
        continue;
      }
      const s = out.get(o.customer_id) ?? {
        order_count: 0,
        last_order_at: null,
        lifetime_spend_cents: 0,
      };
      s.order_count += 1;
      s.lifetime_spend_cents += o.totals.total_cents;
      if (!s.last_order_at || o.created_at > s.last_order_at) s.last_order_at = o.created_at;
      out.set(o.customer_id, s);
    }
    return out;
  },

  async listStaffWithPin(tenantId: string): Promise<Set<string>> {
    return new Set(
      [...staffById.values()]
        .filter((s) => s.tenant_id === tenantId && s.pin_hash)
        .map((s) => s.id),
    );
  },

  async updateOrderStatus(
    id: string,
    status: OrderStatus,
  ): Promise<Order | null> {
    ensureKitchenSeed();
    const order = orders.get(id);
    if (!order) return null;
    const leavingHold = order.status === "draft" && status !== "draft";
    const at = nowIso();
    const updated: Order = {
      ...order,
      status,
      hold: leavingHold ? null : (order.hold ?? null),
      version: (order.version ?? 1) + 1,
      updated_at: at,
    };
    updated.items = fireLines(updated, order.status, at);
    orders.set(id, updated);
    if (leavingHold && isLiveOrderStatus(status)) depleteForOrder(updated);
    return updated;
  },

  // Single synchronous block (no awaits): an atomic compare-and-set in the mock.
  async transitionOrderStatus(
    id: string,
    from: OrderStatus[],
    to: OrderStatus,
    patch?: { fulfillment?: OrderFulfillment },
  ): Promise<Order | null> {
    ensureKitchenSeed();
    const order = orders.get(id);
    if (!order || !from.includes(order.status)) return null;
    // Leaving a hold (e.g. main's settlement `["draft","placed"] -> "paid"`):
    // the hold is over, and a held order consumed no stock yet, so a move to a
    // live status depletes it (per-item idempotent) -- same as casOrderStatus.
    const leavingHold = order.status === "draft" && to !== "draft";
    const at = nowIso();
    const updated: Order = {
      ...order,
      status: to,
      ...(patch?.fulfillment ? { fulfillment: patch.fulfillment } : {}),
      ...(leavingHold ? { hold: null } : {}),
      version: (order.version ?? 1) + 1,
      updated_at: at,
    };
    updated.items = fireLines(updated, order.status, at);
    orders.set(id, updated);
    if (leavingHold && isLiveOrderStatus(to)) depleteForOrder(updated);
    return updated;
  },

  async depleteInventoryForOrder(orderId: string): Promise<void> {
    const order = orders.get(orderId);
    if (!order) return;
    depleteForOrder(order); // per-item idempotent (see depleteForOrder)
  },

  async listAwaitingPaymentOrders(
    createdBefore: string,
    opts?: {
      limit?: number;
      after?: { created_at: string; id: string };
      checkoutMode?: "live" | "test" | "sim";
      foreignOf?: "live" | "test" | "sim";
    },
  ): Promise<Order[]> {
    ensureKitchenSeed();
    const after = opts?.after;
    return [...orders.values()]
      .filter(
        (o) =>
          o.status === "awaiting_payment" &&
          o.created_at < createdBefore &&
          (after === undefined ||
            o.created_at > after.created_at ||
            (o.created_at === after.created_at && o.id > after.id)) &&
          (opts?.checkoutMode === undefined ||
            o.fulfillment?.checkout_mode === undefined ||
            o.fulfillment.checkout_mode === opts.checkoutMode) &&
          (opts?.foreignOf === undefined ||
            (o.fulfillment?.checkout_mode !== undefined &&
              o.fulfillment.checkout_mode !== opts.foreignOf &&
              o.fulfillment.foreign_alerted_at === undefined)),
      )
      .sort(
        (a, b) =>
          a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id),
      )
      .slice(0, opts?.limit ?? Number.MAX_SAFE_INTEGER);
  },

  async listUnfinalizedPaidOrders(
    paidBefore: string,
    limit = 100,
    asOf: string = nowIso(),
  ): Promise<Order[]> {
    ensureKitchenSeed();
    const live = new Set<OrderStatus>([
      "paid",
      "in_kitchen",
      "ready",
      "recall",
      "out_for_delivery",
    ]);
    return [...orders.values()]
      .filter(
        (o) =>
          live.has(o.status) &&
          o.fulfillment?.paid_at !== undefined &&
          o.fulfillment.paid_at < paidBefore &&
          o.fulfillment.finalized_at === undefined &&
          (o.fulfillment.recovery_next_at === undefined ||
            o.fulfillment.recovery_next_at <= asOf),
      )
      .sort((a, b) =>
        (a.fulfillment!.paid_at ?? "").localeCompare(b.fulfillment!.paid_at ?? ""),
      )
      .slice(0, limit);
  },

  // Single synchronous block (no awaits): an atomic claim in the mock.
  async claimLatePayment(
    orderId: string,
    claim: "accepting" | "refunding" | "marking_refunded",
    staleBeforeIso: string,
  ): Promise<Order | null> {
    const order = orders.get(orderId);
    const m = order?.fulfillment?.late_payment;
    if (!order || !m) return null;
    if (m.resolved !== undefined && m.resolved !== "refund_owed_manual") return null;
    if (m.claim !== undefined && (m.claim_at ?? "") >= staleBeforeIso) return null;
    const updated: Order = {
      ...order,
      fulfillment: {
        ...order.fulfillment!,
        late_payment: { ...m, claim, claim_at: nowIso() },
      },
      updated_at: nowIso(),
    };
    orders.set(orderId, updated);
    return updated;
  },

  async updateLatePayment(
    orderId: string,
    patch: Partial<Record<keyof LatePaymentMarker, unknown>>,
  ): Promise<Order | null> {
    const order = orders.get(orderId);
    const m = order?.fulfillment?.late_payment;
    if (!order || !m) return null;
    const next = { ...m, ...patch } as Record<string, unknown>;
    for (const k of Object.keys(next)) if (next[k] === null) delete next[k];
    const updated: Order = {
      ...order,
      fulfillment: { ...order.fulfillment!, late_payment: next as unknown as LatePaymentMarker },
      updated_at: nowIso(),
    };
    orders.set(orderId, updated);
    return updated;
  },

  async listOpenLatePayments(
    tenantId: string,
    locationId: string,
    limit = 100,
  ): Promise<Order[]> {
    return [...orders.values()]
      .filter((o) => {
        const m = o.fulfillment?.late_payment;
        return (
          o.tenant_id === tenantId &&
          o.location_id === locationId &&
          !!m &&
          (m.resolved === undefined || m.resolved === "refund_owed_manual")
        );
      })
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .slice(0, limit);
  },

  async mergeOrderFulfillment(
    id: string,
    patch: Partial<OrderFulfillment>,
  ): Promise<Order | null> {
    ensureKitchenSeed();
    const order = orders.get(id);
    if (!order) return null;
    // An in-store order has no fulfillment: a lifecycle marker (e.g. a duplicate
    // payment flag) creates the blob.
    const updated: Order = {
      ...order,
      fulfillment: { ...(order.fulfillment ?? {}), ...patch } as OrderFulfillment,
      updated_at: nowIso(),
    };
    orders.set(id, updated);
    return updated;
  },

  // -- Payments --------------------------------------------------------------

  async getPaymentSettings(tenantId, locationId): Promise<PaymentSettings> {
    const found = paymentSettings.find(
      (s) => s.tenant_id === tenantId && s.location_id === locationId,
    );
    if (found) return found;
    return {
      tenant_id: tenantId,
      location_id: locationId,
      currency: "USD",
      platform_fee_bps: 250,
      platform_fee_flat_cents: 10,
      tip_presets_bps: [1500, 1800, 2000],
    };
  },

  async upsertPayment(payment: Payment): Promise<Payment> {
    const existing = payments.get(payment.id);
    // Mirror payments_one_live_card_or_cb: one live card/Coinbase tender per
    // order (a canceled/failed one frees the slot).
    if (
      ONE_LIVE_TENDER_RAILS.includes(payment.rail) &&
      tenderHoldsOpenSlot(payment.status) &&
      [...payments.values()].some(
        (p) =>
          p.id !== payment.id &&
          p.order_id === payment.order_id &&
          p.rail === payment.rail &&
          tenderHoldsOpenSlot(p.status),
      )
    ) {
      throw new LiveTenderConflictError();
    }
    if (existing) {
      const merged: Payment = {
        ...existing,
        ...payment,
        // Refund bookkeeping is owned by reservePaymentRefund; a stale snapshot
        // passed to upsert must never roll it back.
        refunded_cents: existing.refunded_cents,
        tip_refunded_cents: existing.tip_refunded_cents,
        refund_reserved_cents: existing.refund_reserved_cents,
        refund_ids: existing.refund_ids,
        refunds: existing.refunds,
        status:
          existing.status === "refunded" ? "refunded" : payment.status,
        created_at: existing.created_at,
        updated_at: nowIso(),
      };
      payments.set(payment.id, merged);
      return merged;
    }
    const now = nowIso();
    const created: Payment = {
      ...payment,
      created_at: payment.created_at || now,
      updated_at: now,
    };
    payments.set(created.id, created);
    return created;
  },

  // Mirrors public.core_record_external_tender(): ONE synchronous block (no
  // awaits between the checks and the write), so it is atomic in the
  // single-threaded mock exactly as the SQL function is under its row lock.
  async linkTenderSession(tenantId, paymentId, sessionId) {
    // Synchronous check-and-write (no await between them): atomic in the
    // single-threaded mock, as the SQL function is under its row lock.
    const p = payments.get(paymentId);
    if (!p || p.tenant_id !== tenantId) return { ok: false, reason: "not_found" };
    if (p.status !== "requires_action") {
      return { ok: false, reason: "not_open", status: p.status };
    }
    const next: Payment = {
      ...p,
      raw: { ...(p.raw ?? {}), checkout_session_id: sessionId },
      updated_at: nowIso(),
    };
    payments.set(next.id, next);
    return { ok: true, payment: next };
  },

  async recordExternalTender(input: ExternalTenderWrite): Promise<ExternalTenderResult> {
    const order = orders.get(input.orderId);
    if (!order || order.tenant_id !== input.tenantId) return { outcome: "not_found" };
    if (["voided", "abandoned", "refunded"].includes(order.status)) {
      return { outcome: "invalid_state", status: order.status };
    }
    const existing = payments.get(input.paymentId);
    if (existing) return { outcome: "exists", payment: { ...existing } };
    const live = [...payments.values()].filter(
      (p) => p.order_id === input.orderId && FINGERPRINT_STATUSES.includes(p.status),
    );
    const fp = tenderFingerprint(live);
    const e = input.expect;
    if (fp.n !== e.n || fp.amount !== e.amount || fp.tip !== e.tip || fp.refunded !== e.refunded) {
      return { outcome: "stale" };
    }
    const dupRef = (): Payment | undefined =>
      input.status === "captured" && input.processorRef
        ? [...payments.values()].find(
            (p) =>
              p.tenant_id === input.tenantId &&
              p.rail === "external" &&
              p.status === "captured" &&
              p.processor === input.processor &&
              p.processor_ref === input.processorRef,
          )
        : undefined;
    const dup = dupRef();
    if (dup) return { outcome: "duplicate_ref", payment: { ...dup } };
    const now = nowIso();
    const created: Payment = {
      id: input.paymentId,
      order_id: input.orderId,
      tenant_id: input.tenantId,
      location_id: order.location_id,
      rail: "external",
      status: input.status,
      amount_cents: input.amountCents,
      tip_cents: input.tipCents,
      application_fee_cents: 0,
      currency: order.currency,
      charge_id: null,
      connect_account_id: null,
      crypto_tx_hash: null,
      crypto_chain: null,
      cash_tendered_cents: null,
      cash_change_cents: null,
      refunded_cents: 0,
      refund_ids: [],
      refunds: [],
      simulated: false,
      raw: { requested_status: input.requestedStatus, recorded_by: input.recordedBy },
      method: input.method,
      processor: input.processor,
      processor_ref: input.processorRef,
      collection: input.collection,
      staff_id: input.staffId,
      created_at: now,
      updated_at: now,
    };
    payments.set(created.id, created);
    const superseded: string[] = [];
    if (input.status === "captured" && input.processorRef) {
      for (const p of payments.values()) {
        if (
          p.order_id === input.orderId &&
          p.id !== created.id &&
          p.rail === "external" &&
          p.status === "pending" &&
          p.processor === input.processor &&
          p.processor_ref === input.processorRef
        ) {
          payments.set(p.id, { ...p, status: "canceled", updated_at: now });
          superseded.push(p.id);
        }
      }
    }
    return { outcome: "ok", payment: { ...created }, superseded };
  },

  // Single synchronous block (no awaits): atomic in the single-threaded mock.
  async reservePaymentRefund(
    paymentId: string,
    amountCents: number,
    refundId: string | null,
    meta?: {
      processorRef?: string | null;
      reason?: string | null;
      tipCents?: number | null;
      pending?: boolean;
      covering?: boolean | null;
    },
  ): Promise<RefundReservation> {
    // One synchronous block (no awaits): atomic in the single-threaded mock,
    // exactly as reserve_payment_refund() is under its row lock.
    const p = payments.get(paymentId);
    if (!p) return { ok: false, reason: "not_found", payment: null };
    const ids = p.refund_ids ?? [];
    if (refundId && ids.includes(refundId)) {
      return { ok: false, reason: "duplicate", payment: p };
    }
    // Room left: confirmed refunds AND pending reservations count against it.
    const left = refundableParts(p);
    // Explicit tip part, else the legacy rule (base first, the rest off the tip).
    const tipPart =
      meta?.tipCents === undefined || meta?.tipCents === null
        ? Math.max(0, amountCents - left.baseCents)
        : meta.tipCents;
    const basePart = amountCents - tipPart;
    const reserved = p.refund_reserved_cents ?? 0;
    const total = p.amount_cents + p.tip_cents;
    if (
      amountCents <= 0 ||
      tipPart < 0 ||
      basePart < 0 ||
      (p.status !== "captured" && p.status !== "authorized") ||
      tipPart > left.tipCents ||
      basePart > left.baseCents ||
      p.refunded_cents + reserved + amountCents > total
    ) {
      return { ok: false, reason: "exceeds", payment: p };
    }
    const now = nowIso();
    const pending = meta?.pending === true;
    const entry = {
      id: globalThis.crypto.randomUUID(),
      amount_cents: amountCents,
      at: now,
      processor_ref: meta?.processorRef ?? null,
      reason: meta?.reason ?? null,
      request_id: refundId,
      tip_cents: tipPart,
      state: pending ? ("pending" as const) : ("succeeded" as const),
      status_before: p.status,
      covering: meta?.covering ?? null,
    };
    const refunded = pending ? p.refunded_cents : p.refunded_cents + amountCents;
    const updated: Payment = {
      ...p,
      refunded_cents: refunded,
      tip_refunded_cents: tipRefundedCents(p) + (pending ? 0 : tipPart),
      refund_reserved_cents: reserved + (pending ? amountCents : 0),
      refund_ids: refundId ? [...ids, refundId] : ids,
      refunds: [...(p.refunds ?? []), entry],
      // A pending refund holds its room only: the status moves at confirm.
      status: refunded >= total ? "refunded" : p.status,
      updated_at: now,
    };
    payments.set(paymentId, updated);
    return { ok: true, payment: updated, refundEntryId: entry.id };
  },

  async setRefundProcessorRef(paymentId: string, requestId: string, processorRef: string) {
    const p = payments.get(paymentId);
    if (!p) return false;
    let hit = false;
    const refunds = (p.refunds ?? []).map((r) => {
      if (r.request_id !== requestId || r.processor_ref) return r;
      hit = true;
      return { ...r, processor_ref: processorRef };
    });
    if (hit) payments.set(paymentId, { ...p, refunds, updated_at: nowIso() });
    return hit;
  },

  // Mirrors confirm_payment_refund(): synchronous, idempotent.
  async confirmPaymentRefund(paymentId, refundId, processorRef) {
    const p = payments.get(paymentId);
    if (!p) return null;
    const idx = (p.refunds ?? []).findIndex((r) => r.request_id === refundId);
    if (idx < 0) return null;
    const refunds = [...(p.refunds ?? [])];
    const e = refunds[idx]!;
    refunds[idx] = {
      ...e,
      state: "succeeded",
      processor_ref: processorRef ?? e.processor_ref,
    };
    if (e.state !== "pending") {
      const same: Payment = { ...p, refunds, updated_at: nowIso() };
      payments.set(paymentId, same);
      return same;
    }
    const tip = typeof e.tip_cents === "number" ? e.tip_cents : 0;
    const refunded = p.refunded_cents + e.amount_cents;
    const updated: Payment = {
      ...p,
      refunds,
      refunded_cents: refunded,
      tip_refunded_cents: tipRefundedCents(p) + tip,
      refund_reserved_cents: Math.max(0, (p.refund_reserved_cents ?? 0) - e.amount_cents),
      status: refunded >= p.amount_cents + p.tip_cents ? "refunded" : p.status,
      updated_at: nowIso(),
    };
    payments.set(paymentId, updated);
    return updated;
  },

  // Mirrors release_pending_payment_refund(): synchronous check + release.
  async releasePendingPaymentRefund(paymentId, refundId, opts) {
    const p = payments.get(paymentId);
    const e = (p?.refunds ?? []).find((r) => r.request_id === refundId);
    if (!p || !e || e.state !== "pending") return false;
    await this.releasePaymentRefund(paymentId, e.amount_cents, refundId, opts);
    return true;
  },

  async listCardTendersWithOpenRefunds(tenantId, locationId, limit) {
    return [...payments.values()]
      .filter(
        (p) =>
          p.tenant_id === tenantId &&
          (!locationId || p.location_id === locationId) &&
          (p.rail === "stripe_terminal" || p.rail === "stripe_online") &&
          !p.simulated &&
          ((p.refund_reserved_cents ?? 0) > 0 || (p.refunds ?? []).some((r) => !r.processor_ref)),
      )
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .slice(0, limit)
      .map((p) => structuredClone(p));
  },

  // Mirrors take_payment_refund_lock() / release_payment_refund_lock().
  async takePaymentRefundLock(paymentId, owner, untilIso) {
    if (!payments.has(paymentId)) return false;
    const cur = refundLocks.get(paymentId);
    if (cur && cur.owner !== owner && cur.until > nowIso()) return false;
    refundLocks.set(paymentId, { owner, until: untilIso });
    return true;
  },

  async releasePaymentRefundLock(paymentId, owner) {
    if (refundLocks.get(paymentId)?.owner === owner) refundLocks.delete(paymentId);
  },

  // Mirrors release_payment_refund(): the entry reserved under refundId only.
  async releasePaymentRefund(
    paymentId: string,
    _amountCents: number,
    refundId: string,
    opts?: { tombstone?: boolean },
  ): Promise<void> {
    const p = payments.get(paymentId);
    if (!p || !refundId) return;
    const refunds = p.refunds ?? [];
    const dropped = refunds.find((r) => r.request_id === refundId);
    if (!dropped) return;
    const refund_ids = opts?.tombstone
      ? p.refund_ids
      : (p.refund_ids ?? []).filter((x) => x !== refundId);
    if (dropped.state === "pending") {
      // Only held room: give it back, nothing was refunded.
      payments.set(paymentId, {
        ...p,
        refund_reserved_cents: Math.max(0, (p.refund_reserved_cents ?? 0) - dropped.amount_cents),
        refund_ids,
        refunds: refunds.filter((r) => r !== dropped),
        updated_at: nowIso(),
      });
      return;
    }
    const tipDone = tipRefundedCents(p);
    const tipBack =
      typeof dropped.tip_cents === "number"
        ? dropped.tip_cents
        : Math.min(dropped.amount_cents, tipDone);
    const before =
      dropped.status_before === "authorized" || dropped.status_before === "captured"
        ? dropped.status_before
        : "captured";
    payments.set(paymentId, {
      ...p,
      refunded_cents: Math.max(0, p.refunded_cents - dropped.amount_cents),
      tip_refunded_cents: Math.max(0, tipDone - tipBack),
      refund_ids,
      refunds: refunds.filter((r) => r !== dropped),
      status: p.status === "refunded" ? before : p.status,
      updated_at: nowIso(),
    });
  },

  async getPayment(id: string): Promise<Payment | null> {
    return payments.get(id) ?? null;
  },

  async getPaymentByChargeId(chargeId: string): Promise<Payment | null> {
    for (const p of payments.values()) {
      if (p.charge_id === chargeId) return p;
    }
    return null;
  },

  async listPaymentsForOrder(orderId: string): Promise<Payment[]> {
    return [...payments.values()]
      .filter((p) => p.order_id === orderId)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  },

  // -- /v1 payment sessions + stored quotes ------------------------------------

  // Single synchronous block (no awaits): atomic in the mock, like the unique
  // indexes it mirrors.
  async insertPaymentSession(row) {
    for (const s of paymentSessions.values()) {
      if (s.tenant_id === row.tenant_id && s.idempotency_key === row.idempotency_key) {
        throw new PaymentSessionConflictError("key");
      }
      if (row.status === "open" && s.order_id === row.order_id && s.status === "open") {
        throw new PaymentSessionConflictError("open");
      }
      if (
        row.stripe_session_id !== null &&
        s.stripe_session_id === row.stripe_session_id
      ) {
        throw new PaymentSessionConflictError("key");
      }
    }
    paymentSessions.set(row.id, { ...row });
    return { ...row };
  },

  async getPaymentSession(id) {
    const s = paymentSessions.get(id);
    return s ? { ...s } : null;
  },

  async getPaymentSessionByKey(tenantId, idempotencyKey) {
    for (const s of paymentSessions.values()) {
      if (s.tenant_id === tenantId && s.idempotency_key === idempotencyKey) {
        return { ...s };
      }
    }
    return null;
  },

  async getPaymentSessionByStripeId(stripeSessionId) {
    for (const s of paymentSessions.values()) {
      if (s.stripe_session_id === stripeSessionId) return { ...s };
    }
    return null;
  },

  async getOpenPaymentSessionForOrder(orderId) {
    for (const s of paymentSessions.values()) {
      if (s.order_id === orderId && s.status === "open") return { ...s };
    }
    return null;
  },

  async updatePaymentSession(id, patch) {
    const s = paymentSessions.get(id);
    if (!s) return null;
    const next = { ...s, ...patch, updated_at: nowIso() };
    // Terminal statuses stick: only an open session changes status.
    if (s.status !== "open") next.status = s.status;
    paymentSessions.set(id, next);
    return { ...next };
  },

  async publishAllergens(tenantId, input) {
    // Mirrors public.core_publish_allergens: one synchronous block.
    const existing = [...allergenPublications.values()].find(
      (p) => p.tenant_id === tenantId && p.version === input.version,
    );
    if (existing) {
      return existing.payload_hash === input.payload_hash
        ? { outcome: "replay", publication: { ...existing } }
        : { outcome: "conflict" };
    }
    const badLocations = (input.location_ids ?? []).filter(
      (l) => !locations.some((x) => x.id === l && x.tenant_id === tenantId),
    );
    if (badLocations.length) return { outcome: "unknown_location", ids: badLocations };
    const owner = (r: AllergenRow): string | null => {
      switch (r.target_type) {
        case "item":
          return menuItems.find((i) => i.id === r.target_id)?.tenant_id ?? null;
        case "size": {
          const size = itemSizes.find((x) => x.id === r.target_id);
          return size ? (menuItems.find((i) => i.id === size.item_id)?.tenant_id ?? null) : null;
        }
        case "modifier": {
          const m = modifiers.find((x) => x.id === r.target_id);
          return m ? (modifierGroups.find((g) => g.id === m.group_id)?.tenant_id ?? null) : null;
        }
        default:
          return null;
      }
    };
    const bad = input.rows.filter((r) => owner(r) !== tenantId).map((r) => r.target_id);
    if (bad.length) return { outcome: "unknown_target", ids: bad.slice(0, 20) };
    const seen = new Set<string>();
    const dups: string[] = [];
    for (const r of input.rows) {
      const k = `${r.target_type}:${r.target_id}`;
      if (seen.has(k)) dups.push(r.target_id);
      seen.add(k);
    }
    if (dups.length) return { outcome: "duplicate", ids: dups.slice(0, 20) };
    const pub: AllergenPublicationRecord = {
      id: globalThis.crypto.randomUUID(),
      tenant_id: tenantId,
      version: input.version,
      payload_hash: input.payload_hash,
      location_ids: input.location_ids,
      row_count: input.rows.length,
      published_by: input.published_by,
      published_at: nowIso(),
    };
    allergenPublications.set(pub.id, pub);
    allergenRows.set(tenantId, input.rows.map((r) => ({ ...r })));
    return { outcome: "ok", publication: { ...pub } };
  },

  async getAllergenPublication(tenantId, id) {
    const p = allergenPublications.get(id);
    return p && p.tenant_id === tenantId ? { ...p } : null;
  },

  async saveQuote(quote) {
    storedQuotes.set(quote.id, { ...quote });
  },

  async getQuote(tenantId, id) {
    const q = storedQuotes.get(id);
    return q && q.tenant_id === tenantId ? { ...q } : null;
  },

  async pruneExpiredQuotes(before) {
    let n = 0;
    for (const [id, q] of storedQuotes) {
      if (q.expires_at < before) {
        storedQuotes.delete(id);
        n += 1;
      }
    }
    return n;
  },

  async listExpiredHolds(now, opts) {
    ensureKitchenSeed();
    const after = opts?.after;
    return [...orders.values()]
      .filter(
        (o) =>
          o.status === "draft" &&
          (o.hold?.reason === "awaiting_payment" || o.hold?.reason === "scheduled") &&
          !!o.hold.expires_at &&
          o.hold.expires_at < now &&
          (after === undefined ||
            o.created_at > after.created_at ||
            (o.created_at === after.created_at && o.id > after.id)) &&
          (opts?.checkoutMode === undefined ||
            o.fulfillment?.checkout_mode === undefined ||
            o.fulfillment.checkout_mode === opts.checkoutMode) &&
          (opts?.foreignOf === undefined ||
            (o.fulfillment?.checkout_mode !== undefined &&
              o.fulfillment.checkout_mode !== opts.foreignOf &&
              o.fulfillment.foreign_alerted_at === undefined)),
      )
      .sort(
        (a, b) =>
          a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id),
      )
      .slice(0, opts?.limit ?? Number.MAX_SAFE_INTEGER);
  },

  // -- Stripe Connect --------------------------------------------------------

  async getConnectAccount(tenantId: string): Promise<ConnectAccount | null> {
    return connectAccounts.get(tenantId) ?? null;
  },

  async getConnectAccountByAccountId(
    accountId: string,
  ): Promise<ConnectAccount | null> {
    return (
      [...connectAccounts.values()].find((a) => a.account_id === accountId) ??
      null
    );
  },

  async upsertConnectAccount(account: ConnectAccount): Promise<ConnectAccount> {
    const existing = connectAccounts.get(account.tenant_id);
    assertNoSimulatedOverwrite(existing, account);
    const merged: ConnectAccount = {
      ...account,
      created_at: existing?.created_at ?? account.created_at,
      updated_at: nowIso(),
    };
    connectAccounts.set(account.tenant_id, merged);
    return merged;
  },

  // -- Stripe Terminal -------------------------------------------------------

  async getTerminalLocation(locationId: string) {
    return terminalLocations.get(locationId) ?? null;
  },

  async upsertTerminalLocation(row: TerminalLocation) {
    const existing = terminalLocations.get(row.location_id);
    const merged: TerminalLocation = {
      ...row,
      created_at: existing?.created_at ?? row.created_at,
      updated_at: nowIso(),
    };
    terminalLocations.set(row.location_id, merged);
    return merged;
  },

  async listTerminalReaders(tenantId: string, locationId: string) {
    return [...terminalReaders.values()]
      .filter((r) => r.tenant_id === tenantId && r.location_id === locationId)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  },

  async getTerminalReader(id: string) {
    return terminalReaders.get(id) ?? null;
  },

  async upsertTerminalReader(row: TerminalReader) {
    const existing = terminalReaders.get(row.id);
    const merged: TerminalReader = {
      ...row,
      created_at: existing?.created_at ?? row.created_at,
      updated_at: nowIso(),
    };
    terminalReaders.set(row.id, merged);
    return merged;
  },

  async deleteTerminalReader(id: string) {
    terminalReaders.delete(id);
  },

  async listStaleTerminalTenders(olderThan: string, limit: number) {
    return [...payments.values()]
      .filter(
        (p) =>
          p.rail === "stripe_terminal" &&
          tenderHoldsOpenSlot(p.status) &&
          !p.raw?.needs_manual_review &&
          p.updated_at < olderThan,
      )
      .sort((a, b) => a.updated_at.localeCompare(b.updated_at))
      .slice(0, limit);
  },

  // -- Network printing ------------------------------------------------------

  async listPrinters(tenantId: string, locationId: string) {
    return [...printers.values()]
      .filter((p) => p.tenant_id === tenantId && p.location_id === locationId)
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .map((p) => ({ ...p }));
  },

  async getPrinter(id: string) {
    const p = printers.get(id);
    return p ? { ...p } : null;
  },

  async createPrinter(row: Omit<Printer, "id" | "created_at" | "last_seen_at">) {
    const printer: Printer = {
      ...row,
      id: genId("prn"),
      last_seen_at: null,
      created_at: nowIso(),
    };
    printers.set(printer.id, printer);
    return { ...printer };
  },

  async deletePrinter(tenantId: string, id: string) {
    const p = printers.get(id);
    if (!p || p.tenant_id !== tenantId) return false;
    printers.delete(id);
    for (const [jid, j] of printJobs) if (j.printer_id === id) printJobs.delete(jid);
    return true;
  },

  async setPrinterTokenHash(tenantId: string, id: string, tokenHash: string) {
    const p = printers.get(id);
    if (!p || p.tenant_id !== tenantId) return null;
    p.token_hash = tokenHash;
    return { ...p };
  },

  async touchPrinter(id: string, at: string) {
    const p = printers.get(id);
    if (p) p.last_seen_at = at;
  },

  async getPrintSettings(locationId: string) {
    const s = printSettings.get(locationId);
    return s ? { ...s } : null;
  },

  async setPrintAutoPrint(tenantId: string, locationId: string, autoPrint: boolean) {
    const row: PrintLocationSettings = {
      location_id: locationId,
      tenant_id: tenantId,
      auto_print: autoPrint,
      updated_at: nowIso(),
    };
    printSettings.set(locationId, row);
    return { ...row };
  },

  async enqueuePrintJob(
    job: Omit<
      PrintJob,
      "id" | "status" | "attempts" | "error" | "created_at" | "claimed_at" | "done_at" | "retry_after"
    >,
  ) {
    if (job.dedupe_key) {
      const dup = [...printJobs.values()].find(
        (j) => j.printer_id === job.printer_id && j.dedupe_key === job.dedupe_key,
      );
      if (dup) return { ...dup };
    }
    const row: PrintJob = {
      ...job,
      id: genId("job"),
      status: "queued",
      attempts: 0,
      error: null,
      created_at: nowIso(),
      claimed_at: null,
      done_at: null,
      retry_after: null,
    };
    printJobs.set(row.id, row);
    return { ...row };
  },

  async expirePrintJobs(printerId: string, nowIsoStr: string) {
    let n = 0;
    for (const j of printJobs.values()) {
      if (
        j.printer_id === printerId &&
        (j.status === "queued" || j.status === "sent") &&
        j.expires_at <= nowIsoStr
      ) {
        j.status = "expired";
        n++;
      }
    }
    return n;
  },

  async claimPrintJob(printerId: string, nowIsoStr: string, reclaimBeforeIso: string) {
    const next = [...printJobs.values()]
      .filter((j) => claimable(j, printerId, nowIsoStr, reclaimBeforeIso))
      .sort((a, b) => a.created_at.localeCompare(b.created_at))[0];
    if (!next) return null;
    next.status = "sent";
    next.attempts += 1;
    next.claimed_at = nowIsoStr;
    return { ...next };
  },

  async hasPrintJobForOrder(printerId: string, orderId: string) {
    return [...printJobs.values()].some((j) => j.printer_id === printerId && j.order_id === orderId);
  },

  async retryFailedPrintJobs(tenantId: string, locationId: string, nowIsoStr: string) {
    let n = 0;
    for (const j of printJobs.values()) {
      if (
        j.tenant_id === tenantId &&
        j.location_id === locationId &&
        j.status === "failed" &&
        j.expires_at > nowIsoStr
      ) {
        j.status = "queued";
        j.attempts = 0;
        j.retry_after = null;
        j.done_at = null;
        n++;
      }
    }
    return n;
  },

  async pruneFinishedPrintJobs(beforeIso: string) {
    let n = 0;
    for (const [id, j] of printJobs) {
      if (j.status !== "queued" && j.status !== "sent" && j.created_at < beforeIso) {
        printJobs.delete(id);
        n++;
      }
    }
    return n;
  },

  async getPrintJobForPrinter(printerId: string, jobId: string) {
    const j = printJobs.get(jobId);
    return j && j.printer_id === printerId ? { ...j } : null;
  },

  async completePrintJob(
    printerId: string,
    jobId: string,
    outcome: { ok: true } | { ok: false; error: string; retryAt?: string | null },
    nowIsoStr: string,
  ) {
    const j = printJobs.get(jobId);
    if (!j || j.printer_id !== printerId) return null;
    if (j.status === "queued" || j.status === "sent") {
      if (!outcome.ok && outcome.retryAt) {
        j.status = "queued";
        j.error = outcome.error;
        j.retry_after = outcome.retryAt;
      } else {
        j.status = outcome.ok ? "done" : "failed";
        j.error = outcome.ok ? null : outcome.error;
        j.done_at = nowIsoStr;
      }
    }
    return { ...j };
  },

  async listPrintJobs(tenantId: string, locationId: string, limit: number) {
    return [...printJobs.values()]
      .filter((j) => j.tenant_id === tenantId && j.location_id === locationId)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, limit)
      .map((j) => ({ ...j }));
  },

  // -- Customers (Phase 4) ---------------------------------------------------

  async getCustomerByEmail(
    tenantId: string,
    email: string,
  ): Promise<Customer | null> {
    const norm = email.trim().toLowerCase();
    for (const c of customers.values()) {
      if (c.tenant_id === tenantId && c.email === norm) return c;
    }
    return null;
  },

  async getCustomer(id: string): Promise<Customer | null> {
    return customers.get(id) ?? null;
  },

  async listCustomers(tenantId, opts): Promise<Customer[]> {
    const after = opts?.after;
    const rows = [...customers.values()]
      .filter(
        (c) =>
          c.tenant_id === tenantId &&
          (!after ||
            c.created_at > after.created_at ||
            (c.created_at === after.created_at && c.id > after.id)),
      )
      .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
      .map((c) => ({ ...c }));
    return opts?.limit ? rows.slice(0, opts.limit) : rows;
  },

  async getTenantSettings(tenantId: string): Promise<TenantSettings> {
    return (
      tenantSettings.get(tenantId) ?? {
        tenant_id: tenantId,
        inventory_owner: "pos_basic",
        updated_at: new Date(0).toISOString(),
      }
    );
  },

  async setTenantSettings(tenantId, patch): Promise<TenantSettings> {
    const current = await this.getTenantSettings(tenantId);
    const next: TenantSettings = {
      ...current,
      ...(patch.inventory_owner
        ? { inventory_owner: patch.inventory_owner }
        : {}),
      updated_at: nowIso(),
    };
    tenantSettings.set(tenantId, next);
    return next;
  },

  async upsertCustomerIdentity(
    tenantId: string,
    input: CustomerIdentityWrite,
  ): Promise<{ customer: Customer; created: boolean; changed: boolean }> {
    // One synchronous block: atomic in the single-threaded mock, as the SQL
    // function is under its advisory locks.
    const r = applyCustomerIdentity(tenantId, [...customers.values()], input, nowIso());
    if (r.created || r.changed) customers.set(r.customer.id, r.customer);
    return { customer: { ...r.customer }, created: r.created, changed: r.changed };
  },

  async upsertCustomer(customer: Customer): Promise<Customer> {
    if (!customer.email) {
      throw new Error("upsertCustomer requires an email; use upsertCustomerIdentity.");
    }
    const email = customer.email.trim().toLowerCase();
    const existingById = customers.get(customer.id);
    const existingByEmail = existingById
      ? null
      : [...customers.values()].find(
          (c) => c.tenant_id === customer.tenant_id && c.email === email,
        );
    // Matched only by EMAIL (anonymous checkout with a new id): never write an
    // existing row from here (see the Supabase driver); the order carries its own
    // contact.
    if (!existingById && existingByEmail) return existingByEmail;
    const base = existingById;
    const now = nowIso();
    const merged: Customer = {
      ...customer,
      id: base?.id ?? customer.id,
      // A row with a PROVEN contact is frozen for contacts (see the Supabase driver).
      email: base?.email_verified_at || base?.phone_verified_at ? (base.email ?? email) : email,
      email_verified_at: base?.email_verified_at ?? null,
      phone_verified_at: base?.phone_verified_at ?? null,
      // Consent / tags / external ids belong to upsertCustomerIdentity: a stale
      // snapshot passed here never overwrites them (as in the Supabase driver).
      marketing: base?.marketing ?? {},
      tags: base?.tags ?? [],
      external_ids: base?.external_ids ?? {},
      verified: customer.verified || base?.verified || false,
      name: customer.name ?? base?.name ?? null,
      phone:
        base?.email_verified_at || base?.phone_verified_at
          ? (base.phone ?? null)
          : (customer.phone ?? base?.phone ?? null),
      created_at: base?.created_at ?? now,
      updated_at: now,
    };
    customers.set(merged.id, merged);
    return merged;
  },

  async createMagicLinkToken(token: MagicLinkToken): Promise<MagicLinkToken> {
    magicLinks.set(token.token, token);
    return token;
  },

  async consumeMagicLinkToken(token: string): Promise<Customer | null> {
    const rec = magicLinks.get(token);
    if (!rec || rec.consumed) return null;
    if (new Date(rec.expires_at).getTime() < Date.now()) return null;
    magicLinks.set(token, { ...rec, consumed: true });
    const customer = customers.get(rec.customer_id);
    if (!customer) return null;
    const verified: Customer = {
      ...customer,
      verified: true,
      updated_at: nowIso(),
    };
    customers.set(verified.id, verified);
    return verified;
  },

  // -- Deliveries (Phase 4) --------------------------------------------------

  async upsertDelivery(delivery: DeliveryRecord): Promise<DeliveryRecord> {
    const existing = deliveries.get(delivery.id);
    // Mirror deliveries_order_id_uidx: one delivery per order.
    if (
      !existing &&
      [...deliveries.values()].some((d) => d.order_id === delivery.order_id)
    ) {
      throw new Error("duplicate key value violates unique constraint \"deliveries_order_id_uidx\"");
    }
    const now = nowIso();
    const merged: DeliveryRecord = {
      ...existing,
      ...delivery,
      created_at: existing?.created_at ?? delivery.created_at ?? now,
      updated_at: now,
    };
    deliveries.set(merged.id, merged);
    return merged;
  },

  async transitionDelivery(id, tenantId, patch) {
    const cur = deliveries.get(id);
    if (!cur || cur.tenant_id !== tenantId) return { ok: false, reason: "not_found" };
    if (["delivered", "canceled", "failed"].includes(cur.status)) {
      return { ok: false, reason: "terminal", delivery: cur };
    }
    const next: DeliveryRecord = { ...cur, updated_at: nowIso() };
    next.status = patch.status;
    if (patch.driver_name !== undefined) next.driver_name = patch.driver_name;
    if (patch.driver_phone !== undefined) next.driver_phone = patch.driver_phone;
    if (patch.eta_minutes !== undefined) next.eta_minutes = patch.eta_minutes;
    if (patch.tracking_ref !== undefined) next.tracking_ref = patch.tracking_ref;
    if (patch.provider_delivery_id !== undefined) {
      next.provider_delivery_id = patch.provider_delivery_id;
    }
    deliveries.set(id, next);
    return { ok: true, delivery: next };
  },

  async updateDriverDispatch(id, tenantId, u) {
    const cur = deliveries.get(id);
    if (!cur || cur.tenant_id !== tenantId) return { ok: false, delivery: null };
    if (cur.provider !== "openpizza_driver" || cur.status !== u.expect_status) {
      return { ok: false, delivery: cur };
    }
    const { expect_status: _expect, ...changes } = u;
    void _expect;
    const next: DeliveryRecord = { ...cur, updated_at: nowIso() };
    for (const [k, v] of Object.entries(changes)) {
      if (v !== undefined) (next as unknown as Record<string, unknown>)[k] = v;
    }
    deliveries.set(id, next);
    return { ok: true, delivery: next };
  },

  async switchDeliveryToManual(id, tenantId, expect) {
    const cur = deliveries.get(id);
    if (
      !cur ||
      cur.tenant_id !== tenantId ||
      cur.provider !== "openpizza_driver" ||
      cur.status !== expect.status ||
      cur.provider_delivery_id !== expect.provider_delivery_id
    ) {
      return null;
    }
    const next: DeliveryRecord = {
      ...cur,
      provider: "in_house_manual",
      status: "pending_assignment",
      provider_delivery_id: null,
      tracking_ref: null,
      driver_name: null,
      driver_phone: null,
      eta_minutes: cur.eta_minutes,
      dispatch_error: null,
      dispatch_next_at: null,
      updated_at: nowIso(),
    };
    deliveries.set(id, next);
    return next;
  },

  async listDriverDispatchRetries(nowIso: string, limit: number) {
    return [...deliveries.values()]
      .filter(
        (d) =>
          d.provider === "openpizza_driver" &&
          d.status === "quoted" &&
          (!d.dispatch_next_at || d.dispatch_next_at <= nowIso),
      )
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .slice(0, limit);
  },

  async getDeliveryForOrder(orderId: string): Promise<DeliveryRecord | null> {
    for (const d of deliveries.values()) {
      if (d.order_id === orderId) return d;
    }
    return null;
  },

  async getDelivery(id: string): Promise<DeliveryRecord | null> {
    return deliveries.get(id) ?? null;
  },

  async listDeliveries(
    tenantId: string,
    locationId: string,
  ): Promise<DeliveryRecord[]> {
    return [...deliveries.values()]
      .filter((d) => d.tenant_id === tenantId && d.location_id === locationId)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  },

  // -- Menu management (Phase 5) ---------------------------------------------

  async getMenuEntityTenant(entity, id): Promise<string | null> {
    switch (entity) {
      case "category":
        return menuCategories.find((c) => c.id === id)?.tenant_id ?? null;
      case "item":
        return menuItems.find((i) => i.id === id)?.tenant_id ?? null;
      case "size": {
        const size = itemSizes.find((s) => s.id === id);
        if (!size) return null;
        return menuItems.find((i) => i.id === size.item_id)?.tenant_id ?? null;
      }
      case "modifierGroup":
        return modifierGroups.find((g) => g.id === id)?.tenant_id ?? null;
      case "modifier": {
        const mod = modifiers.find((m) => m.id === id);
        if (!mod) return null;
        return (
          modifierGroups.find((g) => g.id === mod.group_id)?.tenant_id ?? null
        );
      }
      default:
        return null;
    }
  },

  async getMenuSnapshot(tenantId: string): Promise<MenuSnapshot> {
    const items = menuItems.filter((i) => i.tenant_id === tenantId);
    const itemIds = new Set(items.map((i) => i.id));
    const groups = modifierGroups.filter((g) => g.tenant_id === tenantId);
    const groupIds = new Set(groups.map((g) => g.id));
    return {
      categories: menuCategories
        .filter((c) => c.tenant_id === tenantId)
        .map((c) => ({ id: c.id, name: c.name, sort_order: c.sort_order })),
      items: items.map((i) => ({
        id: i.id,
        category_id: i.category_id,
        name: i.name,
        description: i.description,
        is_half_and_half_capable: i.is_half_and_half_capable,
        station: i.station,
      })),
      sizes: itemSizes.filter((s) => itemIds.has(s.item_id)).map((s) => ({ ...s })),
      modifierGroups: groups.map((g) => ({
        id: g.id,
        name: g.name,
        min_select: g.min_select,
        max_select: g.max_select,
        supports_half: g.supports_half,
      })),
      modifiers: modifiers.filter((m) => groupIds.has(m.group_id)).map((m) => ({ ...m })),
      links: itemModifierGroups
        .filter((l) => itemIds.has(l.item_id))
        .map((l) => ({ item_id: l.item_id, group_id: l.group_id, sort_order: l.sort_order })),
      inventoryLinkSourceIds: itemInventoryLinks
        .filter((l) => l.tenant_id === tenantId)
        .map((l) => l.source_id),
      allergenTargetIds: (allergenRows.get(tenantId) ?? []).map((r) => r.target_id),
    };
  },

  // Mirrors public.import_menu(): all-or-nothing. State is snapshotted up front
  // and restored if any step throws (the SQL function gets this from its
  // transaction). One synchronous block, so no await can interleave.
  async applyMenuImport(tenantId: string, ch: ImportChanges): Promise<void> {
    const saved = {
      categories: [...menuCategories],
      items: [...menuItems],
      sizes: [...itemSizes],
      groups: [...modifierGroups],
      mods: [...modifiers],
      links: [...itemModifierGroups],
      overrides: new Map(overrides),
      recipes: [...itemInventoryLinks],
      allergens: allergenRows.get(tenantId)?.map((r) => ({ ...r })),
    };
    const lc = (s: string) => s.trim().toLowerCase();
    try {
      const mineCat = (id: string) => menuCategories.find((c) => c.id === id && c.tenant_id === tenantId);
      const mineItem = (id: string) => menuItems.find((i) => i.id === id && i.tenant_id === tenantId);
      const mineGroup = (id: string) => modifierGroups.find((g) => g.id === id && g.tenant_id === tenantId);
      const ownSize = (id: string) => {
        const s = itemSizes.find((x) => x.id === id);
        return s && mineItem(s.item_id) ? s : undefined;
      };
      const ownMod = (id: string) => {
        const m = modifiers.find((x) => x.id === id);
        return m && mineGroup(m.group_id) ? m : undefined;
      };

      // -- deletes (+ the recipe / allergen / override rows of removed targets)
      const dItems = new Set(ch.delete.items);
      const dMods = new Set(ch.delete.modifiers);
      const dSizes = new Set(ch.delete.sizes);
      for (const id of ch.delete.categories) {
        if (!mineCat(id)) throw new Error("Row not found.");
        for (const i of menuItems) if (i.category_id === id) dItems.add(i.id);
      }
      for (const id of ch.delete.modifierGroups) {
        if (!mineGroup(id)) throw new Error("Row not found.");
        for (const m of modifiers) if (m.group_id === id) dMods.add(m.id);
      }
      for (const id of dItems) {
        if (!mineItem(id)) throw new Error("Row not found.");
        for (const s of itemSizes) if (s.item_id === id) dSizes.add(s.id);
      }
      for (const id of ch.delete.sizes) if (!ownSize(id)) throw new Error("Row not found.");
      for (const id of ch.delete.modifiers) if (!ownMod(id)) throw new Error("Row not found.");
      removeWhere(itemInventoryLinks, (l) =>
        l.tenant_id === tenantId &&
        ((l.source_type === "item" && dItems.has(l.source_id)) ||
          (l.source_type === "modifier" && dMods.has(l.source_id))),
      );
      const rows = allergenRows.get(tenantId);
      if (rows) {
        allergenRows.set(
          tenantId,
          rows.filter(
            (r) =>
              !(
                (r.target_type === "item" && dItems.has(r.target_id)) ||
                (r.target_type === "size" && dSizes.has(r.target_id)) ||
                (r.target_type === "modifier" && dMods.has(r.target_id))
              ),
          ),
        );
      }
      for (const [k, ov] of overrides) {
        if (
          ov.tenant_id === tenantId &&
          (dItems.has(ov.target_id) || dSizes.has(ov.target_id) || dMods.has(ov.target_id))
        ) {
          overrides.delete(k);
        }
      }
      removeWhere(itemSizes, (s) => dSizes.has(s.id));
      removeWhere(modifiers, (m) => dMods.has(m.id));
      removeWhere(itemModifierGroups, (l) => dItems.has(l.item_id) || ch.delete.modifierGroups.includes(l.group_id));
      for (const l of ch.delete.itemModifierGroups) {
        if (!mineItem(l.item_id)) throw new Error("Row not found.");
        removeWhere(itemModifierGroups, (x) => x.item_id === l.item_id && x.group_id === l.group_id);
      }
      removeWhere(menuItems, (i) => dItems.has(i.id));
      removeWhere(menuCategories, (c) => ch.delete.categories.includes(c.id));
      removeWhere(modifierGroups, (g) => ch.delete.modifierGroups.includes(g.id));

      // -- updates in place (ids kept)
      for (const u of ch.update.categories) {
        const c = mineCat(u.id);
        if (!c) throw new Error("Row not found.");
        c.name = u.name;
        c.sort_order = u.sort_order;
      }
      for (const u of ch.update.items) {
        const i = mineItem(u.id);
        if (!i || !mineCat(u.category_id)) throw new Error("Row not found.");
        Object.assign(i, u);
      }
      for (const u of ch.update.sizes) {
        const s = ownSize(u.id);
        if (!s) throw new Error("Row not found.");
        Object.assign(s, u);
      }
      for (const u of ch.update.modifierGroups) {
        const g = mineGroup(u.id);
        if (!g) throw new Error("Row not found.");
        Object.assign(g, u);
      }
      for (const u of ch.update.modifiers) {
        const m = ownMod(u.id);
        if (!m) throw new Error("Row not found.");
        Object.assign(m, u);
      }
      for (const u of ch.update.itemModifierGroups) {
        const l = itemModifierGroups.find((x) => x.item_id === u.item_id && x.group_id === u.group_id);
        if (!l || !mineItem(u.item_id)) throw new Error("Row not found.");
        l.sort_order = u.sort_order;
      }

      // -- inserts (refuse name collisions: the menu changed under us)
      const changed = () => new Error("The menu changed while importing. Preview again.");
      const ins = ch.insert;
      for (const c of ins.categories) {
        if (c.tenant_id !== tenantId) throw new Error("Row belongs to another tenant.");
        if (menuCategories.some((x) => x.tenant_id === tenantId && lc(x.name) === lc(c.name))) throw changed();
        menuCategories.push({ ...c });
      }
      for (const g of ins.modifierGroups) {
        if (g.tenant_id !== tenantId) throw new Error("Row belongs to another tenant.");
        if (modifierGroups.some((x) => x.tenant_id === tenantId && lc(x.name) === lc(g.name))) throw changed();
        modifierGroups.push({ ...g });
      }
      for (const i of ins.items) {
        if (i.tenant_id !== tenantId) throw new Error("Row belongs to another tenant.");
        if (!mineCat(i.category_id)) throw new Error("Unknown category_id.");
        if (menuItems.some((x) => x.category_id === i.category_id && lc(x.name) === lc(i.name))) throw changed();
        menuItems.push({ ...i });
      }
      for (const s of ins.sizes) {
        if (!mineItem(s.item_id)) throw new Error("Unknown item_id.");
        if (itemSizes.some((x) => x.item_id === s.item_id && lc(x.name) === lc(s.name))) throw changed();
        itemSizes.push({ ...s });
      }
      for (const m of ins.modifiers) {
        if (!mineGroup(m.group_id)) throw new Error("Unknown group_id.");
        if (modifiers.some((x) => x.group_id === m.group_id && lc(x.name) === lc(m.name))) throw changed();
        modifiers.push({ ...m });
      }
      for (const l of ins.itemModifierGroups) {
        if (!mineItem(l.item_id) || !mineGroup(l.group_id)) throw new Error("Unknown item or group in link.");
        if (itemModifierGroups.some((x) => x.item_id === l.item_id && x.group_id === l.group_id)) throw changed();
        itemModifierGroups.push({ ...l });
      }
    } catch (err) {
      menuCategories.splice(0, menuCategories.length, ...saved.categories);
      menuItems.splice(0, menuItems.length, ...saved.items);
      itemSizes.splice(0, itemSizes.length, ...saved.sizes);
      modifierGroups.splice(0, modifierGroups.length, ...saved.groups);
      modifiers.splice(0, modifiers.length, ...saved.mods);
      itemModifierGroups.splice(0, itemModifierGroups.length, ...saved.links);
      itemInventoryLinks.splice(0, itemInventoryLinks.length, ...saved.recipes);
      if (saved.allergens) allergenRows.set(tenantId, saved.allergens);
      overrides.clear();
      for (const [k, v] of saved.overrides) overrides.set(k, v);
      throw err;
    }
  },

  async listCategories(tenantId: string): Promise<MenuCategory[]> {
    return menuCategories
      .filter((c) => c.tenant_id === tenantId)
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((c) => ({ ...c }));
  },

  async upsertCategory(input: CategoryInput): Promise<MenuCategory> {
    if (input.id) {
      const idx = menuCategories.findIndex((c) => c.id === input.id);
      const current = idx >= 0 ? menuCategories[idx] : undefined;
      if (current) {
        const updated: MenuCategory = {
          ...current,
          name: input.name,
          sort_order: input.sort_order ?? current.sort_order,
        };
        menuCategories[idx] = updated;
        return { ...updated };
      }
    }
    const created: MenuCategory = {
      id: input.id ?? genId("cat"),
      tenant_id: input.tenant_id,
      name: input.name,
      sort_order: input.sort_order ?? menuCategories.length + 1,
    };
    menuCategories.push(created);
    return { ...created };
  },

  async deleteCategory(id: string): Promise<void> {
    const itemsInCat = menuItems.filter((i) => i.category_id === id);
    for (const item of itemsInCat) await this.deleteItem(item.id);
    const idx = menuCategories.findIndex((c) => c.id === id);
    if (idx >= 0) menuCategories.splice(idx, 1);
  },

  async upsertItem(input: ItemInput): Promise<MenuItem> {
    if (input.id) {
      const idx = menuItems.findIndex((i) => i.id === input.id);
      const current = idx >= 0 ? menuItems[idx] : undefined;
      if (current) {
        const updated: MenuItem = {
          ...current,
          category_id: input.category_id,
          name: input.name,
          description: input.description ?? current.description,
          is_half_and_half_capable:
            input.is_half_and_half_capable ?? current.is_half_and_half_capable,
          station: input.station ?? current.station,
        };
        menuItems[idx] = updated;
        return { ...updated };
      }
    }
    const created: MenuItem = {
      id: input.id ?? genId("item"),
      tenant_id: input.tenant_id,
      category_id: input.category_id,
      name: input.name,
      description: input.description ?? null,
      is_half_and_half_capable: input.is_half_and_half_capable ?? false,
      station: input.station ?? "oven",
    };
    menuItems.push(created);
    return { ...created };
  },

  async deleteItem(id: string): Promise<void> {
    // Drop sizes + modifier-group links + per-location overrides for the item.
    removeWhere(itemSizes, (s) => s.item_id === id);
    removeWhere(itemModifierGroups, (l) => l.item_id === id);
    for (const [key, ov] of overrides) {
      if (ov.target_type === "item" && ov.target_id === id) {
        overrides.delete(key);
      }
    }
    const idx = menuItems.findIndex((i) => i.id === id);
    if (idx >= 0) menuItems.splice(idx, 1);
  },

  async upsertSize(input: SizeInput): Promise<ItemSize> {
    if (input.id) {
      const idx = itemSizes.findIndex((s) => s.id === input.id);
      const current = idx >= 0 ? itemSizes[idx] : undefined;
      if (current) {
        const updated: ItemSize = {
          ...current,
          name: input.name,
          price_cents: input.price_cents,
          sort_order: input.sort_order ?? current.sort_order,
        };
        itemSizes[idx] = updated;
        return { ...updated };
      }
    }
    const created: ItemSize = {
      id: input.id ?? genId("size"),
      item_id: input.item_id,
      name: input.name,
      price_cents: input.price_cents,
      sort_order:
        input.sort_order ??
        itemSizes.filter((s) => s.item_id === input.item_id).length + 1,
    };
    itemSizes.push(created);
    return { ...created };
  },

  async deleteSize(id: string): Promise<void> {
    const idx = itemSizes.findIndex((s) => s.id === id);
    if (idx >= 0) itemSizes.splice(idx, 1);
  },

  async listModifierGroups(tenantId: string): Promise<ModifierGroup[]> {
    return modifierGroups
      .filter((g) => g.tenant_id === tenantId)
      .map((g) => ({ ...g }));
  },

  async upsertModifierGroup(input: ModifierGroupInput): Promise<ModifierGroup> {
    if (input.id) {
      const idx = modifierGroups.findIndex((g) => g.id === input.id);
      const current = idx >= 0 ? modifierGroups[idx] : undefined;
      if (current) {
        const updated: ModifierGroup = {
          ...current,
          name: input.name,
          min_select: input.min_select ?? current.min_select,
          max_select: input.max_select ?? current.max_select,
          supports_half: input.supports_half ?? current.supports_half,
        };
        modifierGroups[idx] = updated;
        return { ...updated };
      }
    }
    const created: ModifierGroup = {
      id: input.id ?? genId("mg"),
      tenant_id: input.tenant_id,
      name: input.name,
      min_select: input.min_select ?? 0,
      max_select: input.max_select ?? 1,
      supports_half: input.supports_half ?? false,
    };
    modifierGroups.push(created);
    return { ...created };
  },

  async deleteModifierGroup(id: string): Promise<void> {
    removeWhere(modifiers, (m) => m.group_id === id);
    removeWhere(itemModifierGroups, (l) => l.group_id === id);
    const idx = modifierGroups.findIndex((g) => g.id === id);
    if (idx >= 0) modifierGroups.splice(idx, 1);
  },

  async upsertModifier(input: ModifierInput): Promise<Modifier> {
    if (input.id) {
      const idx = modifiers.findIndex((m) => m.id === input.id);
      const current = idx >= 0 ? modifiers[idx] : undefined;
      if (current) {
        const updated: Modifier = {
          ...current,
          name: input.name,
          price_cents: input.price_cents,
          sort_order: input.sort_order ?? current.sort_order,
        };
        modifiers[idx] = updated;
        return { ...updated };
      }
    }
    const created: Modifier = {
      id: input.id ?? genId("mod"),
      group_id: input.group_id,
      name: input.name,
      price_cents: input.price_cents,
      sort_order:
        input.sort_order ??
        modifiers.filter((m) => m.group_id === input.group_id).length + 1,
    };
    modifiers.push(created);
    return { ...created };
  },

  async deleteModifier(id: string): Promise<void> {
    for (const [key, ov] of overrides) {
      if (ov.target_type === "modifier" && ov.target_id === id) {
        overrides.delete(key);
      }
    }
    const idx = modifiers.findIndex((m) => m.id === id);
    if (idx >= 0) modifiers.splice(idx, 1);
  },

  // -- Per-location overrides ------------------------------------------------

  async listOverrides(
    tenantId: string,
    locationId: string,
  ): Promise<LocationMenuOverride[]> {
    return [...overrides.values()]
      .filter((o) => o.tenant_id === tenantId && o.location_id === locationId)
      .map((o) => ({ ...o }));
  },

  async upsertOverride(input: OverrideInput): Promise<LocationMenuOverride> {
    const key = overrideKey(
      input.location_id,
      input.target_type,
      input.target_id,
    );
    const existing = overrides.get(key);
    const merged: LocationMenuOverride = {
      id: existing?.id ?? genId("ov"),
      tenant_id: input.tenant_id,
      location_id: input.location_id,
      target_type: input.target_type,
      target_id: input.target_id,
      price_cents:
        input.price_cents !== undefined
          ? input.price_cents
          : (existing?.price_cents ?? null),
      available:
        input.available !== undefined
          ? input.available
          : (existing?.available ?? null),
      updated_at: nowIso(),
    };
    // If both fields are cleared (null), drop the override row entirely.
    if (merged.price_cents == null && merged.available == null) {
      overrides.delete(key);
      return merged;
    }
    overrides.set(key, merged);
    return { ...merged };
  },

  async clearOverride(
    tenantId: string,
    locationId: string,
    targetType: OverrideTargetType,
    targetId: string,
  ): Promise<void> {
    overrides.delete(overrideKey(locationId, targetType, targetId));
  },

  // -- Inventory -------------------------------------------------------------

  async listInventory(
    tenantId: string,
    locationId: string,
  ): Promise<InventoryItemView[]> {
    return [...inventoryItems.values()]
      .filter((i) => i.tenant_id === tenantId && i.location_id === locationId)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((i) => ({ ...i, low: i.on_hand <= i.low_threshold }));
  },

  async getInventoryItem(id: string): Promise<InventoryItem | null> {
    const item = inventoryItems.get(id);
    return item ? { ...item } : null;
  },

  async upsertInventoryItem(item: InventoryItem): Promise<InventoryItem> {
    const existing = inventoryItems.get(item.id);
    const now = nowIso();
    const merged: InventoryItem = {
      ...item,
      id: item.id || genId("inv"),
      created_at: existing?.created_at ?? item.created_at ?? now,
      updated_at: now,
    };
    inventoryItems.set(merged.id, merged);
    return { ...merged };
  },

  async applyInventoryMovement(input: {
    inventoryItemId: string;
    reason: MovementReason;
    delta: number;
    orderId?: string | null;
    note?: string | null;
  }): Promise<{ item: InventoryItem; movement: InventoryMovement }> {
    const result = applyMovementInternal(input);
    if (!result) {
      throw new Error(`Inventory item ${input.inventoryItemId} not found.`);
    }
    return result;
  },

  async listInventoryMovements(
    tenantId: string,
    locationId: string,
  ): Promise<InventoryMovement[]> {
    return inventoryMovements
      .filter((m) => m.tenant_id === tenantId && m.location_id === locationId)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .map((m) => ({ ...m }));
  },

  // -- Reports + end-of-day --------------------------------------------------

  async getSalesReport(
    tenantId: string,
    locationId: string | null,
    range: DateRange,
  ): Promise<SalesReport> {
    ensureKitchenSeed();
    const scoped = [...orders.values()].filter(
      (o) =>
        o.tenant_id === tenantId &&
        (locationId === null || o.location_id === locationId),
    );
    const orderIds = new Set(scoped.map((o) => o.id));
    const scopedPayments = [...payments.values()].filter((p) =>
      orderIds.has(p.order_id),
    );
    return buildSalesReport({
      tenantId,
      locationId,
      range,
      orders: scoped,
      payments: scopedPayments,
      categoryOf: categoryOfItem,
      locationName,
      locationClock: (id) => locations.find((l) => l.id === id),
    });
  },

  async getOwnerReportBundle(
    tenantId: string,
    locationId: string | null,
    from: string,
    to: string,
    topN?: number,
  ): Promise<OwnerReportBundle> {
    ensureKitchenSeed();
    // Stored-value liability lives in the stored-value store (src/lib/giftcards).
    const { mockStoredValueStore } = await import("@/lib/giftcards/store-mock");
    const sv = await mockStoredValueStore.summary(tenantId, null, from, from);
    return buildOwnerBundle({
      tenantId,
      locationId,
      from,
      to,
      topN,
      storedValueOutstandingCents: sv.outstanding_cents,
      orders: [...orders.values()].filter((o) => o.tenant_id === tenantId),
      payments: [...payments.values()].filter((p) => p.tenant_id === tenantId),
      locations: locations.filter((l) => l.tenant_id === tenantId),
      staff: [...staffById.values()].filter((s) => s.tenant_id === tenantId),
      categoryOf: categoryOfItem,
    });
  },

  async getBusinessDayClose(
    tenantId: string,
    locationId: string,
    businessDate: string,
  ): Promise<BusinessDayClose | null> {
    return businessDayCloses.get(`${locationId}:${businessDate}`) ?? null;
  },

  async closeBusinessDay(
    tenantId: string,
    locationId: string,
    businessDate: string,
    opts?: { drawer?: BusinessDayClose["drawer"] },
  ): Promise<BusinessDayClose> {
    const key = `${locationId}:${businessDate}`;
    const existing = businessDayCloses.get(key);
    if (existing) return existing; // idempotent

    const report = await this.getSalesReport(tenantId, locationId, {
      from: businessDate,
      to: businessDate,
    });

    // Drawer summary across shifts that closed on this business day.
    const dayShifts = [...shifts.values()].filter(
      (s) =>
        s.location_id === locationId &&
        s.status === "closed" &&
        s.closed_at != null &&
        locationBusinessDate(
          s.closed_at,
          locations.find((l) => l.id === locationId),
        ) === businessDate,
    );
    let openingFloat = 0;
    let cashSales = 0;
    let expected = 0;
    let counted = 0;
    for (const s of dayShifts) {
      const rec = computeReconciliation(s);
      openingFloat += rec.opening_float_cents;
      cashSales += rec.cash_sales_cents;
      expected += rec.expected_cents;
      counted += rec.counted_cents ?? rec.expected_cents;
    }

    const close: BusinessDayClose = {
      id: genId("eod"),
      tenant_id: tenantId,
      location_id: locationId,
      business_date: businessDate,
      closed_at: nowIso(),
      report,
      drawer: opts?.drawer ?? {
        opening_float_cents: openingFloat,
        cash_sales_cents: cashSales,
        expected_cents: expected,
        counted_cents: counted,
        over_short_cents: counted - expected,
        shift_count: dayShifts.length,
      },
    };
    businessDayCloses.set(key, close);
    return close;
  },

  // -- Staff & shifts --------------------------------------------------------

  async listStaff(tenantId: string): Promise<Staff[]> {
    // Never expose pin_hash to list consumers (feeds the client). Server-side
    // PIN verification uses getStaffById, which keeps the hash.
    return [...staffById.values()]
      .filter((s) => s.tenant_id === tenantId)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((s) => ({
        ...s,
        pin_hash: undefined,
        pin_previous_hash: undefined,
        pin_previous_until: undefined,
      }));
  },

  async getStaffById(tenantId: string, staffId: string): Promise<Staff | null> {
    const s = staffById.get(staffId);
    if (!s || s.tenant_id !== tenantId) return null;
    return { ...s };
  },

  // Mirrors begin_pin_attempt(): single-threaded JS makes this atomic.
  async beginPinAttempt(tenantId, staffId): Promise<PinAttempt> {
    const s = staffById.get(staffId);
    if (!s || s.tenant_id !== tenantId) {
      return { allowed: false, justLocked: false, attempts: 0, lockedUntil: null };
    }
    const now = Date.now();
    let l = pinLocks.get(staffId) ?? { attempts: 0, lockedUntil: null };
    if (l.lockedUntil !== null && l.lockedUntil > now) {
      return {
        allowed: false,
        justLocked: false,
        attempts: l.attempts,
        lockedUntil: new Date(l.lockedUntil).toISOString(),
      };
    }
    if (l.lockedUntil !== null) l = { attempts: 0, lockedUntil: null };
    if (l.attempts >= PIN_MAX_FAILURES) {
      const lockedUntil = now + PIN_LOCK_MS;
      pinLocks.set(staffId, { attempts: 0, lockedUntil });
      return {
        allowed: false,
        justLocked: true,
        attempts: 0,
        lockedUntil: new Date(lockedUntil).toISOString(),
      };
    }
    const attempts = l.attempts + 1;
    pinLocks.set(staffId, { attempts, lockedUntil: null });
    return { allowed: true, justLocked: false, attempts, lockedUntil: null };
  },

  async clearPinAttempts(tenantId, staffId): Promise<void> {
    const s = staffById.get(staffId);
    if (!s || s.tenant_id !== tenantId) return;
    const l = pinLocks.get(staffId);
    // Only if no lock was set meanwhile.
    if (l && l.lockedUntil === null) pinLocks.delete(staffId);
  },

  async setStaffPinHash(tenantId, staffId, pinHash): Promise<boolean> {
    const s = staffById.get(staffId);
    if (!s || s.tenant_id !== tenantId) return false;
    staffById.set(staffId, {
      ...s,
      pin_hash: pinHash,
      pin_previous_hash: null,
      pin_previous_until: null,
    });
    pinLocks.delete(staffId); // a reset PIN starts with a fresh lockout budget
    return true;
  },

  async rotateStaffPin(tenantId, staffId, pinHash, graceUntil): Promise<boolean> {
    const s = staffById.get(staffId);
    if (!s || s.tenant_id !== tenantId) return false;
    const keep =
      !!s.pin_previous_hash &&
      !!s.pin_previous_until &&
      new Date(s.pin_previous_until).getTime() > Date.now();
    staffById.set(staffId, {
      ...s,
      pin_hash: pinHash,
      pin_previous_hash: keep ? s.pin_previous_hash : (s.pin_hash ?? null),
      pin_previous_until: keep ? s.pin_previous_until : graceUntil,
    });
    pinLocks.delete(staffId);
    return true;
  },

  async clearPreviousPin(tenantId, staffId): Promise<void> {
    const s = staffById.get(staffId);
    if (!s || s.tenant_id !== tenantId) return;
    staffById.set(staffId, { ...s, pin_previous_hash: null, pin_previous_until: null });
  },

  async tenantHasStaffPins(tenantId): Promise<boolean> {
    return [...staffById.values()].some(
      (s) => s.tenant_id === tenantId && s.active && Boolean(s.pin_hash),
    );
  },

  async listStaffPinRecords(tenantId): Promise<StaffPinRecord[]> {
    return [...staffById.values()]
      .filter((s) => s.tenant_id === tenantId)
      .map((s) => ({
        id: s.id,
        active: s.active,
        location_ids: [...(s.location_ids ?? [])],
        pin_hash: s.pin_hash ?? null,
        pin_previous_hash: s.pin_previous_hash ?? null,
        pin_previous_until: s.pin_previous_until ?? null,
      }));
  },

  async updateStaffProfile(
    tenantId: string,
    staffId: string,
    patch: StaffProfilePatch,
  ): Promise<Staff | null> {
    const cur = staffById.get(staffId);
    if (!cur || cur.tenant_id !== tenantId) return null;
    const next: Staff = { ...cur };
    if (patch.name !== undefined) next.name = patch.name;
    if (patch.role !== undefined) next.role = patch.role;
    if (patch.active !== undefined) next.active = patch.active;
    if (patch.contact_email !== undefined) next.contact_email = patch.contact_email;
    if (patch.contact_phone !== undefined) next.contact_phone = patch.contact_phone;
    if (patch.location_ids !== undefined) next.location_ids = [...patch.location_ids];
    if (patch.module_roles !== undefined) next.module_roles = [...patch.module_roles];
    staffById.set(staffId, next);
    return { ...next, pin_hash: undefined, pin_previous_hash: undefined, pin_previous_until: undefined };
  },

  async lastStaffSignIns(tenantId): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const s of staffSessions.values()) {
      if (s.tenant_id !== tenantId) continue;
      const cur = out.get(s.staff_id);
      if (!cur || s.created_at > cur) out.set(s.staff_id, s.created_at);
    }
    return out;
  },

  // Mirrors begin_pin_limit_attempt(): single-threaded JS makes this atomic.
  async beginPinLimitAttempt(scope, key, limits): Promise<PinAttempt> {
    const id = `${scope}:${key}`;
    const now = Date.now();
    let l = pinLimits.get(id) ?? { attempts: 0, windowStart: now, lockedUntil: null };
    if (l.lockedUntil !== null && l.lockedUntil > now) {
      return {
        allowed: false,
        justLocked: false,
        attempts: l.attempts,
        lockedUntil: new Date(l.lockedUntil).toISOString(),
      };
    }
    if (l.lockedUntil !== null || l.windowStart + limits.windowMinutes * 60_000 <= now) {
      l = { attempts: 0, windowStart: now, lockedUntil: null };
    }
    if (l.attempts >= limits.max) {
      const lockedUntil = now + limits.lockMinutes * 60_000;
      pinLimits.set(id, { attempts: 0, windowStart: now, lockedUntil });
      return {
        allowed: false,
        justLocked: true,
        attempts: 0,
        lockedUntil: new Date(lockedUntil).toISOString(),
      };
    }
    const attempts = l.attempts + 1;
    pinLimits.set(id, { ...l, attempts });
    return { allowed: true, justLocked: false, attempts, lockedUntil: null };
  },

  async releasePinLimitAttempt(scope, key): Promise<void> {
    const id = `${scope}:${key}`;
    const l = pinLimits.get(id);
    if (l && l.lockedUntil === null) {
      pinLimits.set(id, { ...l, attempts: Math.max(l.attempts - 1, 0) });
    }
  },

  async createStaffSession(session: StaffSession): Promise<StaffSession> {
    staffSessions.set(session.id, { kind: "till", ...session });
    return { kind: "till", ...session };
  },

  async getStaffSession(id: string): Promise<StaffSession | null> {
    const s = staffSessions.get(id);
    return s ? { ...s } : null;
  },

  async revokeStaffSession(id: string): Promise<void> {
    const s = staffSessions.get(id);
    if (s && !s.revoked_at) staffSessions.set(id, { ...s, revoked_at: nowIso() });
  },

  async revokeStaffSessionsForUser(userId: string): Promise<void> {
    const now = nowIso();
    for (const [id, s] of staffSessions) {
      if (s.user_id === userId && !s.revoked_at) {
        staffSessions.set(id, { ...s, revoked_at: now });
      }
    }
  },

  async revokeStaffSessionsForStaff(tenantId, staffId): Promise<void> {
    const now = nowIso();
    for (const [id, s] of staffSessions) {
      if (s.tenant_id === tenantId && s.staff_id === staffId && !s.revoked_at) {
        staffSessions.set(id, { ...s, revoked_at: now });
      }
    }
  },

  async upsertStaff(staff: Staff): Promise<Staff> {
    const existing = staffById.get(staff.id);
    const merged: Staff = {
      ...staff,
      id: staff.id || genId("staff"),
      // Preserve an existing PIN hash if the caller didn't supply a new one.
      pin_hash:
        staff.pin_hash === undefined
          ? (existing?.pin_hash ?? null)
          : staff.pin_hash,
      created_at: existing?.created_at ?? staff.created_at ?? nowIso(),
    };
    staffById.set(merged.id, merged);
    return { ...merged, pin_hash: undefined, pin_previous_hash: undefined, pin_previous_until: undefined };
  },

  async setStaffModuleRoles(tenantId, staffId, roles) {
    const cur = staffById.get(staffId);
    if (!cur || cur.tenant_id !== tenantId) return null;
    const next: Staff = { ...cur, module_roles: [...roles] };
    staffById.set(staffId, next);
    return { ...next, pin_hash: undefined, pin_previous_hash: undefined, pin_previous_until: undefined };
  },

  async getShift(id: string): Promise<Shift | null> {
    const shift = shifts.get(id);
    return shift ? { ...shift } : null;
  },

  async listShifts(tenantId: string, locationId: string): Promise<Shift[]> {
    return [...shifts.values()]
      .filter((s) => s.tenant_id === tenantId && s.location_id === locationId)
      .sort((a, b) => b.opened_at.localeCompare(a.opened_at))
      .map((s) => ({ ...s }));
  },

  async getOpenShift(
    tenantId: string,
    locationId: string,
    staffId: string,
  ): Promise<Shift | null> {
    for (const s of shifts.values()) {
      if (
        s.tenant_id === tenantId &&
        s.location_id === locationId &&
        s.staff_id === staffId &&
        s.status === "open"
      ) {
        return { ...s };
      }
    }
    return null;
  },

  async openShift(input: {
    tenantId: string;
    locationId: string;
    staffId: string;
    openingFloatCents: number;
  }): Promise<Shift> {
    const open = await this.getOpenShift(
      input.tenantId,
      input.locationId,
      input.staffId,
    );
    if (open) return open; // already clocked in

    const now = nowIso();
    const shift: Shift = {
      id: genId("shift"),
      tenant_id: input.tenantId,
      location_id: input.locationId,
      staff_id: input.staffId,
      status: "open",
      opened_at: now,
      closed_at: null,
      opening_float_cents: input.openingFloatCents,
      counted_cents: null,
      close_note: null,
      created_at: now,
    };
    shifts.set(shift.id, shift);
    return { ...shift };
  },

  async addShiftCashEvent(event: ShiftCashEvent): Promise<ShiftCashEvent> {
    // An explicit id is an idempotency key (refund cash-outs): never twice.
    const prior = event.id ? shiftCashEvents.find((e) => e.id === event.id) : undefined;
    if (prior) return { ...prior };
    const created: ShiftCashEvent = {
      ...event,
      id: event.id || genId("cash"),
      created_at: event.created_at || nowIso(),
    };
    shiftCashEvents.push(created);
    return { ...created };
  },

  async listShiftCashEvents(shiftId: string): Promise<ShiftCashEvent[]> {
    return shiftCashEvents
      .filter((e) => e.shift_id === shiftId)
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .map((e) => ({ ...e }));
  },

  async getDrawerReconciliation(
    shiftId: string,
  ): Promise<DrawerReconciliation> {
    const shift = shifts.get(shiftId);
    if (!shift) throw new Error(`Shift ${shiftId} not found.`);
    return computeReconciliation(shift);
  },

  async closeShift(input: {
    shiftId: string;
    countedCents: number;
    note?: string | null;
  }): Promise<Shift | null> {
    const shift = shifts.get(input.shiftId);
    if (!shift) return null;
    const updated: Shift = {
      ...shift,
      status: "closed",
      closed_at: nowIso(),
      counted_cents: input.countedCents,
      close_note: input.note ?? null,
    };
    shifts.set(updated.id, updated);
    return { ...updated };
  },
};

/** Test helper: clear the per-device / per-location PIN budgets only. */
export function resetMockPinLimits(): void {
  pinLimits.clear();
}

/** Test helper: clear PIN budgets/locks and staff sessions. */
export function resetMockPinState(): void {
  pinLimits.clear();
  pinLocks.clear();
  staffSessions.clear();
}

/** Test helper: clear placed orders + reset the sequence + KDS seed flag. */
export function resetMockOrders(): void {
  orders.clear();
  marketplaceStores.clear();
  orderSeq = 0;
  kitchenSeeded = false;
}

/** Test helper: clear payments + connect state. */
export function resetMockPayments(): void {
  payments.clear();
  refundLocks.clear();
  adjustmentRecords.length = 0;
  paymentSessions.clear();
  storedQuotes.clear();
  connectAccounts.clear();
  terminalLocations.clear();
  terminalReaders.clear();
  printers.clear();
  printJobs.clear();
  printSettings.clear();
}

/** Test helper: clear customers, magic-link tokens, and deliveries. */
export function resetMockOnline(): void {
  customers.clear();
  magicLinks.clear();
  deliveries.clear();
}
