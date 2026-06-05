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
import type {
  Customer,
  DeliveryRecord,
  MagicLinkToken,
} from "./customer-types";
import type { Location } from "./types";
import {
  itemModifierGroups,
  itemSizes,
  locations,
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
/** Online-ordering customers keyed by id. */
const customers = new Map<string, Customer>();
/** Magic-link tokens (stubbed, never emailed) keyed by token. */
const magicLinks = new Map<string, MagicLinkToken>();
/** Deliveries keyed by id. */
const deliveries = new Map<string, DeliveryRecord>();
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
      customer_id: input.customer_id ?? null,
      fulfillment: input.fulfillment,
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
    // Idempotent on (tenant, email): a new id reuses an existing customer.
    const existingById = customers.get(customer.id);
    const existingByEmail = existingById
      ? null
      : [...customers.values()].find(
          (c) => c.tenant_id === customer.tenant_id && c.email === email,
        );
    const base = existingById ?? existingByEmail;
    const now = new Date().toISOString();
    const merged: Customer = {
      ...customer,
      id: base?.id ?? customer.id,
      email,
      // Don't downgrade a verified customer back to guest.
      verified: customer.verified || base?.verified || false,
      name: customer.name ?? base?.name ?? null,
      phone: customer.phone ?? base?.phone ?? null,
      created_at: base?.created_at ?? now,
      updated_at: now,
    };
    customers.set(merged.id, merged);
    return merged;
  },

  async createMagicLinkToken(
    token: MagicLinkToken,
  ): Promise<MagicLinkToken> {
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
      updated_at: new Date().toISOString(),
    };
    customers.set(verified.id, verified);
    return verified;
  },

  // -- Deliveries (Phase 4) --------------------------------------------------

  async upsertDelivery(delivery: DeliveryRecord): Promise<DeliveryRecord> {
    const existing = deliveries.get(delivery.id);
    const now = new Date().toISOString();
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
      .filter(
        (d) => d.tenant_id === tenantId && d.location_id === locationId,
      )
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
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
