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
} from "./backoffice-types";
import type { Location } from "./types";
import {
  inventoryItems as seedInventoryItems,
  itemInventoryLinks as seedItemInventoryLinks,
  itemModifierGroups,
  itemSizes as seedItemSizes,
  locations,
  menuCategories as seedMenuCategories,
  menuItems as seedMenuItems,
  modifierGroups as seedModifierGroups,
  modifiers as seedModifiers,
  paymentSettings,
  staff as seedStaff,
  storeSettings,
} from "./seed-data";
import { seedKitchenOrders } from "./kds-seed";
import { buildSalesReport, isoDate } from "@/lib/reports";

// ---------------------------------------------------------------------------
// MUTABLE menu state (Phase 5). Cloned from the seed so admin CRUD can mutate
// it without touching the immutable seed module. A future Supabase driver
// replaces these with table reads/writes; call sites are unchanged.
// ---------------------------------------------------------------------------
const menuCategories: MenuCategory[] = seedMenuCategories.map((c) => ({ ...c }));
const menuItems: MenuItem[] = seedMenuItems.map((i) => ({ ...i }));
const itemSizes: ItemSize[] = seedItemSizes.map((s) => ({ ...s }));
const modifierGroups: ModifierGroup[] = seedModifierGroups.map((g) => ({ ...g }));
const modifiers: Modifier[] = seedModifiers.map((m) => ({ ...m }));

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
const staffById = new Map<string, Staff>(seedStaff.map((s) => [s.id, { ...s }]));
const shifts = new Map<string, Shift>();
const shiftCashEvents: ShiftCashEvent[] = [];
const businessDayCloses = new Map<string, BusinessDayClose>();

/** Process-lifetime order store, keyed by client UUID for idempotent upsert. */
const orders = new Map<string, Order>();
/** Payment tenders keyed by client UUID (idempotency key). */
const payments = new Map<string, Payment>();
/** Connect onboarding status keyed by tenant id. */
const connectAccounts = new Map<string, ConnectAccount>();
/** Online-ordering customers keyed by id. */
const customers = new Map<string, Customer>();
/** Magic-link tokens (stubbed, never emailed) keyed by token. */
const magicLinks = new Map<string, MagicLinkToken>();
/** Deliveries keyed by id. */
const deliveries = new Map<string, DeliveryRecord>();
let orderSeq = 0;
let idSeq = 0;

function nowIso(): string {
  return new Date().toISOString();
}

/** Deterministic-enough unique id for mock-created rows. */
function genId(prefix: string): string {
  idSeq += 1;
  return `${prefix}-${Date.now().toString(36)}-${idSeq}`;
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
        // 86'd modifiers drop out of the menu graph for this location.
        .filter(
          (m) => getOverride(locationId, "modifier", m.id)?.available !== false,
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

function assembleMenu(tenantId: string, locationId: string): Menu {
  const categories: MenuCategoryWithItems[] = menuCategories
    .filter((c) => c.tenant_id === tenantId)
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((category) => {
      const items = menuItems
        .filter(
          (i) => i.tenant_id === tenantId && i.category_id === category.id,
        )
        // An item 86'd at this location drops out of the menu entirely.
        .filter(
          (i) => getOverride(locationId, "item", i.id)?.available !== false,
        )
        .map((i) => buildMenuItemDetail(i.id, locationId))
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
  const expected =
    shift.opening_float_cents + cashSales + paidIn - payouts;
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

  async listLocations(tenantId: string): Promise<Location[]> {
    return locations.filter((l) => l.tenant_id === tenantId);
  },

  async getLocationBySlug(slug: string): Promise<Location | null> {
    return locations.find((l) => l.slug === slug) ?? null;
  },

  async getMenu(tenantId, locationId): Promise<Menu> {
    return assembleMenu(tenantId, locationId);
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
      items: input.items,
      discount_cents: input.discount_cents,
      totals: input.totals,
      notes: input.notes,
      order_number: input.order_number ?? nextOrderNumber(),
      customer_id: input.customer_id ?? null,
      fulfillment: input.fulfillment,
      created_at: now,
      updated_at: now,
    };
    orders.set(order.id, order);
    // Phase 5: deplete linked inventory on the single order funnel (terminal +
    // shop both land here), unless the order was created already voided.
    if (order.status !== "voided") depleteForOrder(order);
    return order;
  },

  async getOrder(id: string): Promise<Order | null> {
    ensureKitchenSeed();
    return orders.get(id) ?? null;
  },

  async listOrders(tenantId, locationId): Promise<Order[]> {
    ensureKitchenSeed();
    return [...orders.values()]
      .filter((o) => o.tenant_id === tenantId && o.location_id === locationId)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  },

  async updateOrderStatus(
    id: string,
    status: OrderStatus,
  ): Promise<Order | null> {
    ensureKitchenSeed();
    const order = orders.get(id);
    if (!order) return null;
    const updated: Order = { ...order, status, updated_at: nowIso() };
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
    if (existing) {
      const merged: Payment = {
        ...existing,
        ...payment,
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

  // -- Stripe Connect --------------------------------------------------------

  async getConnectAccount(tenantId: string): Promise<ConnectAccount | null> {
    return connectAccounts.get(tenantId) ?? null;
  },

  async upsertConnectAccount(
    account: ConnectAccount,
  ): Promise<ConnectAccount> {
    const existing = connectAccounts.get(account.tenant_id);
    const merged: ConnectAccount = {
      ...account,
      created_at: existing?.created_at ?? account.created_at,
      updated_at: nowIso(),
    };
    connectAccounts.set(account.tenant_id, merged);
    return merged;
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

  async upsertCustomer(customer: Customer): Promise<Customer> {
    const email = customer.email.trim().toLowerCase();
    const existingById = customers.get(customer.id);
    const existingByEmail = existingById
      ? null
      : [...customers.values()].find(
          (c) => c.tenant_id === customer.tenant_id && c.email === email,
        );
    const base = existingById ?? existingByEmail;
    const now = nowIso();
    const merged: Customer = {
      ...customer,
      id: base?.id ?? customer.id,
      email,
      verified: customer.verified || base?.verified || false,
      name: customer.name ?? base?.name ?? null,
      phone: customer.phone ?? base?.phone ?? null,
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

  async upsertModifierGroup(
    input: ModifierGroupInput,
  ): Promise<ModifierGroup> {
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
      .filter(
        (i) => i.tenant_id === tenantId && i.location_id === locationId,
      )
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((i) => ({ ...i, low: i.on_hand <= i.low_threshold }));
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
      .filter(
        (m) => m.tenant_id === tenantId && m.location_id === locationId,
      )
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
    });
  },

  async getBusinessDayClose(
    tenantId: string,
    locationId: string,
    businessDate: string,
  ): Promise<BusinessDayClose | null> {
    return (
      businessDayCloses.get(`${locationId}:${businessDate}`) ?? null
    );
  },

  async closeBusinessDay(
    tenantId: string,
    locationId: string,
    businessDate: string,
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
        isoDate(s.closed_at) === businessDate,
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
      drawer: {
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
    return [...staffById.values()]
      .filter((s) => s.tenant_id === tenantId)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((s) => ({ ...s }));
  },

  async upsertStaff(staff: Staff): Promise<Staff> {
    const existing = staffById.get(staff.id);
    const merged: Staff = {
      ...staff,
      id: staff.id || genId("staff"),
      created_at: existing?.created_at ?? staff.created_at ?? nowIso(),
    };
    staffById.set(merged.id, merged);
    return { ...merged };
  },

  async listShifts(tenantId: string, locationId: string): Promise<Shift[]> {
    return [...shifts.values()]
      .filter(
        (s) => s.tenant_id === tenantId && s.location_id === locationId,
      )
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

/** Test helper: clear placed orders + reset the sequence + KDS seed flag. */
export function resetMockOrders(): void {
  orders.clear();
  orderSeq = 0;
  kitchenSeeded = false;
}

/** Test helper: clear payments + connect state. */
export function resetMockPayments(): void {
  payments.clear();
  connectAccounts.clear();
}

/** Test helper: clear customers, magic-link tokens, and deliveries. */
export function resetMockOnline(): void {
  customers.clear();
  magicLinks.clear();
  deliveries.clear();
}
