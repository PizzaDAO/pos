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
  StoreSettings,
} from "./menu-types";
import {
  itemModifierGroups,
  itemSizes,
  menuCategories,
  menuItems,
  modifierGroups,
  modifiers,
  storeSettings,
} from "./seed-data";

/** Process-lifetime order store, keyed by client UUID for idempotent upsert. */
const orders = new Map<string, Order>();
let orderSeq = 0;

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
    return orders.get(id) ?? null;
  },

  async listOrders(tenantId, locationId): Promise<Order[]> {
    return [...orders.values()]
      .filter(
        (o) => o.tenant_id === tenantId && o.location_id === locationId,
      )
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  },
};

/** Test helper: clear placed orders + reset the sequence. */
export function resetMockOrders(): void {
  orders.clear();
  orderSeq = 0;
}
