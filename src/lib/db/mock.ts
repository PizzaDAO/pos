/**
 * In-memory PosDriver — Phase 1 default (Supabase deferred).
 *
 * Assembles the menu graph from `seed-data.ts` and keeps placed orders in a
 * module-level Map for the lifetime of the server process. `createOrder` is an
 * idempotent upsert-by-UUID: re-submitting an order with an id that already
 * exists is a no-op that returns the stored order, so offline-queue retries
 * never produce duplicates.
 *
 * Everything here is pure data + maps; it never reads env vars and works with no
 * configuration, so the app builds and runs offline in the Vercel preview.
 */
import type { PosDriver } from "./driver";
import type {
  CreateOrderInput,
  Menu,
  MenuCategoryWithItems,
  MenuItemDetail,
  MenuModifierGroup,
  Order,
  OrderStatus,
  StoreSettings,
} from "./menu-types";
import type {
  ConnectAccount,
  Payment,
  PaymentSettings,
} from "./payment-types";
import {
  itemModifierGroups,
  itemSizes,
  menuCategories,
  menuItems,
  modifierGroups,
  modifiers,
  paymentSettings,
  storeSettings,
} from "./seed-data";
import { seedKitchenOrders } from "./kds-seed";

/** Process-lifetime order store, keyed by client UUID for idempotent upsert. */
const orders = new Map<string, Order>();
/** Payment tenders keyed by client UUID (idempotency key). */
const payments = new Map<string, Payment>();
/** Connect onboarding status keyed by tenant id. */
const connectAccounts = new Map<string, ConnectAccount>();
let orderSeq = 0;

/**
 * KDS demo seed (mock-only). Serverless lambdas are stateless: the in-memory
 * `orders` Map does NOT persist across cold starts, so a freshly-spun Vercel
 * instance would show an EMPTY kitchen board. To keep `/kitchen` demoable in the
 * preview we lazily seed a handful of open kitchen orders (varied ages,
 * stations, and statuses) the first time orders are read/listed in a given warm
 * instance. Orders actually placed in the same warm instance still appear
 * alongside the seed. This entire behavior disappears once Supabase is wired —
 * persistence then comes from Postgres, not this Map.
 */
let kitchenSeeded = false;
function ensureKitchenSeed(): void {
  if (kitchenSeeded) return;
  kitchenSeeded = true;
  for (const order of seedKitchenOrders()) {
    if (!orders.has(order.id)) orders.set(order.id, order);
  }
}

function buildMenuItemDetail(itemId: string): MenuItemDetail | null {
  const item = menuItems.find((i) => i.id === itemId);
  if (!item) return null;

  const sizes = itemSizes
    .filter((s) => s.item_id === itemId)
    .sort((a, b) => a.sort_order - b.sort_order);

  const groupLinks = itemModifierGroups
    .filter((l) => l.item_id === itemId)
    .sort((a, b) => a.sort_order - b.sort_order);

  const modifierGroupsForItem: MenuModifierGroup[] = groupLinks
    .map((link) => {
      const group = modifierGroups.find((g) => g.id === link.group_id);
      if (!group) return null;
      const mods = modifiers
        .filter((m) => m.group_id === group.id)
        .sort((a, b) => a.sort_order - b.sort_order);
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
        .map((i) => buildMenuItemDetail(i.id))
        .filter((d): d is MenuItemDetail => d !== null);
      return { ...category, items } satisfies MenuCategoryWithItems;
    });

  return { tenantId, locationId, categories };
}

function nextOrderNumber(): string {
  orderSeq += 1;
  // Zero-padded, prefixed; deterministic per process. Real impl uses a DB seq.
  return `A-${String(orderSeq).padStart(4, "0")}`;
}

export const mockDriver: PosDriver = {
  name: "mock",

  async getMenu(tenantId, locationId): Promise<Menu> {
    return assembleMenu(tenantId, locationId);
  },

  async getStoreSettings(tenantId, locationId): Promise<StoreSettings> {
    const found = storeSettings.find(
      (s) => s.tenant_id === tenantId && s.location_id === locationId,
    );
    if (found) return found;
    // Safe default so the terminal still totals if a location lacks settings.
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
    // Idempotent: if this UUID was already placed, return it unchanged.
    const existing = orders.get(input.id);
    if (existing) return existing;

    const now = new Date().toISOString();
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
      created_at: now,
      updated_at: now,
    };
    orders.set(order.id, order);
    return order;
  },

  async getOrder(id: string): Promise<Order | null> {
    ensureKitchenSeed();
    return orders.get(id) ?? null;
  },

  async listOrders(tenantId, locationId): Promise<Order[]> {
    ensureKitchenSeed();
    return [...orders.values()]
      .filter(
        (o) => o.tenant_id === tenantId && o.location_id === locationId,
      )
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  },

  async updateOrderStatus(
    id: string,
    status: OrderStatus,
  ): Promise<Order | null> {
    ensureKitchenSeed();
    const order = orders.get(id);
    if (!order) return null;
    const updated: Order = {
      ...order,
      status,
      updated_at: new Date().toISOString(),
    };
    orders.set(id, updated);
    return updated;
  },

  // -- Payments --------------------------------------------------------------

  async getPaymentSettings(
    tenantId,
    locationId,
  ): Promise<PaymentSettings> {
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
      // Merge mutable fields (status/refund/crypto confirmation), keep created_at.
      const merged: Payment = {
        ...existing,
        ...payment,
        created_at: existing.created_at,
        updated_at: new Date().toISOString(),
      };
      payments.set(payment.id, merged);
      return merged;
    }
    const now = new Date().toISOString();
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
      updated_at: new Date().toISOString(),
    };
    connectAccounts.set(account.tenant_id, merged);
    return merged;
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
