/**
 * Supabase-backed PosDriver — the LIVE persistence implementation.
 *
 * Implements the exact same `PosDriver` contract as the in-memory `mock.ts`, so
 * `getPosDriver()` can swap to it WITHOUT touching any call site. It is selected
 * in `client.ts` only when the Supabase env vars are present; otherwise the mock
 * remains the default (the app must build/run/test with zero env vars).
 *
 * Design:
 *   * One `@supabase/supabase-js` client is constructed lazily from env. On the
 *     SERVER we use the service-role key (so background/API writes work) but
 *     EVERY tenant-scoped query carries an explicit tenant_id/location_id filter,
 *     so service-role usage never crosses tenants even though it bypasses RLS
 *     (see supabase/README.md). In the browser the anon key + the user's session
 *     would be used and RLS enforces scope; this module is intended for
 *     server-side use (route handlers / RSC), matching the mock's call sites.
 *   * The relational order graph (orders -> order_items -> order_item_modifiers)
 *     is read back and re-assembled into the same `Order` object the mock
 *     returns. Computed/structured fields (totals, fulfillment, report snapshots,
 *     raw rail data) are stored as jsonb and round-tripped verbatim.
 *   * Menu reads fold per-location overrides + 86 exactly like the mock's
 *     `assembleMenu`, so the terminal/shop are byte-for-byte equivalent.
 *
 * Money is always integer minor units; nothing here uses floats.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { PosDriver } from "./driver";
import type {
  ItemSize,
  Menu,
  MenuCategoryWithItems,
  MenuItem,
  MenuItemDetail,
  MenuModifierGroup,
  Modifier,
  ModifierGroup,
  Order,
  OrderItem,
  OrderItemModifier,
  OrderStatus,
  StoreSettings,
} from "./menu-types";
import type {
  ConnectAccount,
  Payment,
  PaymentSettings,
} from "./payment-types";
import type { Customer, DeliveryRecord } from "./customer-types";
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
import type { Location, Membership, Tenant, User } from "./types";
import type {
  AuditLogEntry,
  OnboardingStep,
  PlanTier,
  Subscription,
  TenantHealth,
  TenantOnboarding,
} from "./saas-types";
import { ONBOARDING_STEPS } from "./saas-types";
import { buildStarterMenu } from "@/lib/saas/menu-template";
import { buildSalesReport, isoDate } from "@/lib/reports";

// ---------------------------------------------------------------------------
// Config + client construction (lazy; never at module load).
// ---------------------------------------------------------------------------

export interface SupabaseDriverConfig {
  url: string;
  /** Service-role key (server) when available, else anon key. */
  key: string;
}

/**
 * Resolve Supabase config from the environment at CALL time. Prefers the
 * service-role key on the server (so writes succeed), falling back to the anon
 * key. Returns null when not configured so callers stay on the mock driver.
 */
export function readSupabaseConfig(): SupabaseDriverConfig | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const key = serviceKey || anonKey;
  if (!url || !key) return null;
  return { url, key };
}

function genUuid(): string {
  // crypto.randomUUID is available in Node 18+ and the browser.
  return globalThis.crypto.randomUUID();
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Slugify a name into a URL-safe base slug (uniqueness handled by caller). */
function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "tenant"
  );
}

// ---------------------------------------------------------------------------
// Row <-> domain mappers. The DB stores enums/jsonb that map 1:1 to the TS
// shapes; these helpers normalise nullable columns the mock returns as `null`
// and re-assemble structured blobs.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

function mapTenant(r: Row): Tenant {
  return {
    id: r.id as string,
    name: r.name as string,
    slug: r.slug as string,
    status: r.status as Tenant["status"],
    created_at: r.created_at as string,
  };
}

function mapLocation(r: Row): Location {
  return {
    id: r.id as string,
    tenant_id: r.tenant_id as string,
    name: r.name as string,
    slug: r.slug as string,
    timezone: r.timezone as string,
    address: (r.address as string | null) ?? null,
    created_at: r.created_at as string,
  };
}

function mapUser(r: Row): User {
  return {
    id: r.id as string,
    email: r.email as string,
    created_at: r.created_at as string,
  };
}

function mapStoreSettings(r: Row): StoreSettings {
  return {
    tenant_id: r.tenant_id as string,
    location_id: r.location_id as string,
    currency: r.currency as string,
    tax_rate_bps: r.tax_rate_bps as number,
    tip_presets_bps: (r.tip_presets_bps as number[]) ?? [],
    kds_thresholds:
      (r.kds_thresholds as StoreSettings["kds_thresholds"]) ?? undefined,
    fulfillment: (r.fulfillment as StoreSettings["fulfillment"]) ?? undefined,
  };
}

function mapPaymentSettings(r: Row): PaymentSettings {
  return {
    tenant_id: r.tenant_id as string,
    location_id: r.location_id as string,
    currency: r.currency as string,
    platform_fee_bps: r.platform_fee_bps as number,
    platform_fee_flat_cents: r.platform_fee_flat_cents as number,
    tip_presets_bps: (r.tip_presets_bps as number[]) ?? [],
  };
}

function mapOrder(r: Row, items: OrderItem[]): Order {
  return {
    id: r.id as string,
    tenant_id: r.tenant_id as string,
    location_id: r.location_id as string,
    status: r.status as OrderStatus,
    channel: r.channel as Order["channel"],
    currency: r.currency as string,
    items,
    discount_cents: r.discount_cents as number,
    totals: r.totals as Order["totals"],
    notes: (r.notes as string | null) ?? null,
    order_number: r.order_number as string,
    customer_id: (r.customer_id as string | null) ?? null,
    staff_id: (r.staff_id as string | null) ?? null,
    fulfillment: (r.fulfillment as Order["fulfillment"]) ?? undefined,
    created_at: r.created_at as string,
    updated_at: r.updated_at as string,
  };
}

function mapPayment(r: Row): Payment {
  return {
    id: r.id as string,
    order_id: r.order_id as string,
    tenant_id: r.tenant_id as string,
    location_id: r.location_id as string,
    rail: r.rail as Payment["rail"],
    status: r.status as Payment["status"],
    amount_cents: r.amount_cents as number,
    tip_cents: r.tip_cents as number,
    application_fee_cents: r.application_fee_cents as number,
    currency: r.currency as string,
    charge_id: (r.charge_id as string | null) ?? null,
    connect_account_id: (r.connect_account_id as string | null) ?? null,
    crypto_tx_hash: (r.crypto_tx_hash as string | null) ?? null,
    crypto_chain: (r.crypto_chain as string | null) ?? null,
    cash_tendered_cents: (r.cash_tendered_cents as number | null) ?? null,
    cash_change_cents: (r.cash_change_cents as number | null) ?? null,
    refunded_cents: r.refunded_cents as number,
    simulated: r.simulated as boolean,
    raw: (r.raw as Record<string, unknown> | null) ?? null,
    created_at: r.created_at as string,
    updated_at: r.updated_at as string,
  };
}

function mapInventoryItem(r: Row): InventoryItem {
  return {
    id: r.id as string,
    tenant_id: r.tenant_id as string,
    location_id: r.location_id as string,
    name: r.name as string,
    unit: r.unit as InventoryItem["unit"],
    on_hand: r.on_hand as number,
    low_threshold: r.low_threshold as number,
    created_at: r.created_at as string,
    updated_at: r.updated_at as string,
  };
}

function mapInventoryMovement(r: Row): InventoryMovement {
  return {
    id: r.id as string,
    tenant_id: r.tenant_id as string,
    location_id: r.location_id as string,
    inventory_item_id: r.inventory_item_id as string,
    reason: r.reason as MovementReason,
    delta: r.delta as number,
    resulting_on_hand: r.resulting_on_hand as number,
    order_id: (r.order_id as string | null) ?? null,
    note: (r.note as string | null) ?? null,
    created_at: r.created_at as string,
  };
}

function mapStaff(r: Row, opts?: { includePin?: boolean }): Staff {
  return {
    id: r.id as string,
    tenant_id: r.tenant_id as string,
    name: r.name as string,
    role: r.role as Staff["role"],
    active: r.active as boolean,
    // pin_hash is only carried for server-side PIN verification (getStaffById);
    // list/upsert results omit it so it never reaches the client.
    pin_hash: opts?.includePin ? ((r.pin_hash as string | null) ?? null) : undefined,
    created_at: r.created_at as string,
  };
}

function mapShift(r: Row): Shift {
  return {
    id: r.id as string,
    tenant_id: r.tenant_id as string,
    location_id: r.location_id as string,
    staff_id: r.staff_id as string,
    status: r.status as Shift["status"],
    opened_at: r.opened_at as string,
    closed_at: (r.closed_at as string | null) ?? null,
    opening_float_cents: r.opening_float_cents as number,
    counted_cents: (r.counted_cents as number | null) ?? null,
    close_note: (r.close_note as string | null) ?? null,
    created_at: r.created_at as string,
  };
}

function mapCustomer(r: Row): Customer {
  return {
    id: r.id as string,
    tenant_id: r.tenant_id as string,
    email: r.email as string,
    name: (r.name as string | null) ?? null,
    phone: (r.phone as string | null) ?? null,
    verified: r.verified as boolean,
    created_at: r.created_at as string,
    updated_at: r.updated_at as string,
  };
}

function mapDelivery(r: Row): DeliveryRecord {
  return {
    id: r.id as string,
    order_id: r.order_id as string,
    tenant_id: r.tenant_id as string,
    location_id: r.location_id as string,
    provider: r.provider as string,
    status: r.status as DeliveryRecord["status"],
    zone_id: (r.zone_id as string | null) ?? null,
    fee_cents: r.fee_cents as number,
    currency: r.currency as string,
    eta_minutes: (r.eta_minutes as number | null) ?? null,
    provider_delivery_id: (r.provider_delivery_id as string | null) ?? null,
    tracking_ref: (r.tracking_ref as string | null) ?? null,
    dropoff: r.dropoff as DeliveryRecord["dropoff"],
    driver_name: (r.driver_name as string | null) ?? null,
    driver_phone: (r.driver_phone as string | null) ?? null,
    simulated: r.simulated as boolean,
    created_at: r.created_at as string,
    updated_at: r.updated_at as string,
  };
}

function mapSubscription(r: Row): Subscription {
  return {
    id: r.id as string,
    tenant_id: r.tenant_id as string,
    tier: r.tier as PlanTier,
    status: r.status as Subscription["status"],
    current_period_end: r.current_period_end as string,
    trial_end: (r.trial_end as string | null) ?? null,
    cancel_at_period_end: r.cancel_at_period_end as boolean,
    simulated: r.simulated as boolean,
    stripe_customer_id: (r.stripe_customer_id as string | null) ?? null,
    stripe_subscription_id: (r.stripe_subscription_id as string | null) ?? null,
    created_at: r.created_at as string,
    updated_at: r.updated_at as string,
  };
}

function mapOnboarding(r: Row): TenantOnboarding {
  return {
    tenant_id: r.tenant_id as string,
    current_step: r.current_step as OnboardingStep,
    completed_steps: (r.completed_steps as OnboardingStep[]) ?? [],
    live: r.live as boolean,
    created_at: r.created_at as string,
    updated_at: r.updated_at as string,
  };
}

function mapAudit(r: Row): AuditLogEntry {
  return {
    id: r.id as string,
    actor_user_id: r.actor_user_id as string,
    actor_label: r.actor_label as string,
    action: r.action as AuditLogEntry["action"],
    tenant_id: (r.tenant_id as string | null) ?? null,
    detail: (r.detail as string | null) ?? null,
    created_at: r.created_at as string,
  };
}

function mapOverride(r: Row): LocationMenuOverride {
  return {
    id: r.id as string,
    tenant_id: r.tenant_id as string,
    location_id: r.location_id as string,
    target_type: r.target_type as OverrideTargetType,
    target_id: r.target_id as string,
    price_cents: (r.price_cents as number | null) ?? null,
    available: (r.available as boolean | null) ?? null,
    updated_at: r.updated_at as string,
  };
}

function mapConnect(r: Row): ConnectAccount {
  return {
    tenant_id: r.tenant_id as string,
    account_id: r.account_id as string,
    status: r.status as ConnectAccount["status"],
    charges_enabled: r.charges_enabled as boolean,
    payouts_enabled: r.payouts_enabled as boolean,
    details_submitted: r.details_submitted as boolean,
    simulated: r.simulated as boolean,
    created_at: r.created_at as string,
    updated_at: r.updated_at as string,
  };
}

// ---------------------------------------------------------------------------
// Driver factory.
// ---------------------------------------------------------------------------

export function createSupabaseDriver(
  config: SupabaseDriverConfig,
): PosDriver {
  const sb: SupabaseClient = createClient(config.url, config.key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  /** Throw on a Supabase error; return data otherwise. */
  function unwrap<T>(res: { data: T | null; error: { message: string } | null }): T {
    if (res.error) throw new Error(`Supabase: ${res.error.message}`);
    return res.data as T;
  }

  // -- Menu assembly (mirrors mock.assembleMenu, folding overrides + 86) ------
  async function assembleMenu(
    tenantId: string,
    locationId: string,
  ): Promise<Menu> {
    const [cats, items, sizes, groups, mods, links, overrides] =
      await Promise.all([
        sb
          .from("menu_categories")
          .select("*")
          .eq("tenant_id", tenantId)
          .order("sort_order"),
        sb.from("menu_items").select("*").eq("tenant_id", tenantId),
        sb.from("item_sizes").select("*"),
        sb.from("modifier_groups").select("*").eq("tenant_id", tenantId),
        sb.from("modifiers").select("*"),
        sb.from("item_modifier_groups").select("*"),
        sb
          .from("location_menu_overrides")
          .select("*")
          .eq("tenant_id", tenantId)
          .eq("location_id", locationId),
      ]);

    const categoryRows = unwrap(cats) as Row[];
    const itemRows = unwrap(items) as Row[];
    const sizeRows = unwrap(sizes) as Row[];
    const groupRows = unwrap(groups) as Row[];
    const modRows = unwrap(mods) as Row[];
    const linkRows = unwrap(links) as Row[];
    const overrideRows = (unwrap(overrides) as Row[]).map(mapOverride);

    const ov = (type: OverrideTargetType, targetId: string) =>
      overrideRows.find(
        (o) => o.target_type === type && o.target_id === targetId,
      );

    const buildItemDetail = (itemRow: Row): MenuItemDetail => {
      const item: MenuItem = {
        id: itemRow.id as string,
        tenant_id: itemRow.tenant_id as string,
        category_id: itemRow.category_id as string,
        name: itemRow.name as string,
        description: (itemRow.description as string | null) ?? null,
        is_half_and_half_capable: itemRow.is_half_and_half_capable as boolean,
        station: itemRow.station as MenuItem["station"],
      };
      const itemSizes: ItemSize[] = sizeRows
        .filter((s) => s.item_id === item.id)
        .sort((a, b) => (a.sort_order as number) - (b.sort_order as number))
        .map((s) => {
          const o = ov("size", s.id as string);
          return {
            id: s.id as string,
            item_id: s.item_id as string,
            name: s.name as string,
            price_cents:
              o?.price_cents != null
                ? o.price_cents
                : (s.price_cents as number),
            sort_order: s.sort_order as number,
          };
        });

      const groupLinks = linkRows
        .filter((l) => l.item_id === item.id)
        .sort((a, b) => (a.sort_order as number) - (b.sort_order as number));

      const modifierGroups: MenuModifierGroup[] = groupLinks
        .map((link) => {
          const g = groupRows.find((x) => x.id === link.group_id);
          if (!g) return null;
          const group: ModifierGroup = {
            id: g.id as string,
            tenant_id: g.tenant_id as string,
            name: g.name as string,
            min_select: g.min_select as number,
            max_select: g.max_select as number,
            supports_half: g.supports_half as boolean,
          };
          const groupMods: Modifier[] = modRows
            .filter((m) => m.group_id === group.id)
            .filter((m) => ov("modifier", m.id as string)?.available !== false)
            .sort(
              (a, b) => (a.sort_order as number) - (b.sort_order as number),
            )
            .map((m) => {
              const o = ov("modifier", m.id as string);
              return {
                id: m.id as string,
                group_id: m.group_id as string,
                name: m.name as string,
                price_cents:
                  o?.price_cents != null
                    ? o.price_cents
                    : (m.price_cents as number),
                sort_order: m.sort_order as number,
              };
            });
          return { ...group, modifiers: groupMods };
        })
        .filter((g): g is MenuModifierGroup => g !== null);

      return { ...item, sizes: itemSizes, modifierGroups };
    };

    const categories: MenuCategoryWithItems[] = categoryRows.map((c) => {
      const catItems = itemRows
        .filter((i) => i.category_id === c.id)
        .filter((i) => ov("item", i.id as string)?.available !== false)
        .map(buildItemDetail);
      return {
        id: c.id as string,
        tenant_id: c.tenant_id as string,
        name: c.name as string,
        sort_order: c.sort_order as number,
        items: catItems,
      };
    });

    return { tenantId, locationId, categories };
  }

  // -- Order graph read (orders + items + modifiers) --------------------------
  async function readOrderRow(orderRow: Row): Promise<Order> {
    const orderId = orderRow.id as string;
    const itemRows = unwrap(
      await sb
        .from("order_items")
        .select("*")
        .eq("order_id", orderId)
        .order("sort_order"),
    ) as Row[];
    const itemIds = itemRows.map((r) => r.id as string);
    const modRows =
      itemIds.length === 0
        ? []
        : (unwrap(
            await sb
              .from("order_item_modifiers")
              .select("*")
              .in("order_item_id", itemIds)
              .order("sort_order"),
          ) as Row[]);

    const items: OrderItem[] = itemRows.map((ir) => {
      const mods: OrderItemModifier[] = modRows
        .filter((m) => m.order_item_id === ir.id)
        .map((m) => ({
          group_id: m.group_id as string,
          group_name: m.group_name as string,
          modifier_id: m.modifier_id as string,
          modifier_name: m.modifier_name as string,
          price_cents: m.price_cents as number,
          placement: m.placement as OrderItemModifier["placement"],
        }));
      return {
        id: ir.id as string,
        item_id: ir.item_id as string,
        item_name: ir.item_name as string,
        station: (ir.station as OrderItem["station"]) ?? undefined,
        size_id: (ir.size_id as string | null) ?? null,
        size_name: (ir.size_name as string | null) ?? null,
        base_price_cents: ir.base_price_cents as number,
        quantity: ir.quantity as number,
        modifiers: mods,
        notes: (ir.notes as string | null) ?? null,
        voided: ir.voided as boolean,
        unit_price_cents: ir.unit_price_cents as number,
        line_total_cents: ir.line_total_cents as number,
      };
    });

    return mapOrder(orderRow, items);
  }

  /** Write an order's line items + modifiers (delete-then-insert children). */
  async function writeOrderItems(
    orderId: string,
    items: OrderItem[],
  ): Promise<void> {
    // Children cascade on order delete, but on a fresh insert there are none.
    const itemRows = items.map((line, idx) => ({
      id: line.id,
      order_id: orderId,
      item_id: line.item_id,
      item_name: line.item_name,
      station: line.station ?? null,
      size_id: line.size_id,
      size_name: line.size_name,
      base_price_cents: line.base_price_cents,
      quantity: line.quantity,
      notes: line.notes,
      voided: line.voided,
      unit_price_cents: line.unit_price_cents,
      line_total_cents: line.line_total_cents,
      sort_order: idx,
    }));
    if (itemRows.length > 0) {
      unwrap(await sb.from("order_items").insert(itemRows).select());
    }
    const modRows = items.flatMap((line) =>
      line.modifiers.map((m, idx) => ({
        id: genUuid(),
        order_item_id: line.id,
        group_id: m.group_id,
        group_name: m.group_name,
        modifier_id: m.modifier_id,
        modifier_name: m.modifier_name,
        price_cents: m.price_cents,
        placement: m.placement,
        sort_order: idx,
      })),
    );
    if (modRows.length > 0) {
      unwrap(await sb.from("order_item_modifiers").insert(modRows).select());
    }
  }

  // -- Inventory movement (read level, apply delta, write ledger) -------------
  async function applyMovementInternal(input: {
    inventoryItemId: string;
    reason: MovementReason;
    delta: number;
    orderId?: string | null;
    note?: string | null;
  }): Promise<{ item: InventoryItem; movement: InventoryMovement } | null> {
    const existing = unwrap(
      await sb
        .from("inventory_items")
        .select("*")
        .eq("id", input.inventoryItemId)
        .maybeSingle(),
    ) as Row | null;
    if (!existing) return null;
    const item = mapInventoryItem(existing);
    const newOnHand = Math.max(0, item.on_hand + input.delta);
    const updated = mapInventoryItem(
      unwrap(
        await sb
          .from("inventory_items")
          .update({ on_hand: newOnHand, updated_at: nowIso() })
          .eq("id", item.id)
          .select()
          .single(),
      ) as Row,
    );
    const movement = mapInventoryMovement(
      unwrap(
        await sb
          .from("inventory_movements")
          .insert({
            id: genUuid(),
            tenant_id: item.tenant_id,
            location_id: item.location_id,
            inventory_item_id: item.id,
            reason: input.reason,
            delta: input.delta,
            resulting_on_hand: newOnHand,
            order_id: input.orderId ?? null,
            note: input.note ?? null,
          })
          .select()
          .single(),
      ) as Row,
    );
    return { item: updated, movement };
  }

  /** Resolve the location-scoped inventory row for a template id (by name). */
  async function resolveLocationInventory(
    templateInventoryId: string,
    tenantId: string,
    locationId: string,
  ): Promise<InventoryItem | undefined> {
    const tplRow = unwrap(
      await sb
        .from("inventory_items")
        .select("*")
        .eq("id", templateInventoryId)
        .maybeSingle(),
    ) as Row | null;
    if (!tplRow) return undefined;
    const template = mapInventoryItem(tplRow);
    if (template.location_id === locationId) return template;
    const match = unwrap(
      await sb
        .from("inventory_items")
        .select("*")
        .eq("tenant_id", tenantId)
        .eq("location_id", locationId)
        .eq("name", template.name)
        .maybeSingle(),
    ) as Row | null;
    return match ? mapInventoryItem(match) : undefined;
  }

  async function depleteForOrder(order: Order): Promise<void> {
    const links = (unwrap(
      await sb
        .from("item_inventory_links")
        .select("*")
        .eq("tenant_id", order.tenant_id),
    ) as Row[]).map(
      (r): ItemInventoryLink => ({
        id: r.id as string,
        tenant_id: r.tenant_id as string,
        source_type: r.source_type as ItemInventoryLink["source_type"],
        source_id: r.source_id as string,
        inventory_item_id: r.inventory_item_id as string,
        qty_per_unit: r.qty_per_unit as number,
      }),
    );

    const consumption = new Map<string, number>();
    const addLink = async (
      sourceType: "item" | "modifier",
      sourceId: string,
      units: number,
    ) => {
      for (const link of links) {
        if (link.source_type !== sourceType || link.source_id !== sourceId) {
          continue;
        }
        const inv = await resolveLocationInventory(
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
      await addLink("item", line.item_id, line.quantity);
      for (const mod of line.modifiers) {
        await addLink("modifier", mod.modifier_id, line.quantity);
      }
    }

    for (const [invId, qty] of consumption) {
      if (qty <= 0) continue;
      await applyMovementInternal({
        inventoryItemId: invId,
        reason: "depletion",
        delta: -qty,
        orderId: order.id,
        note: `Sold on order ${order.order_number}`,
      });
    }
  }

  // -- Drawer reconciliation (shared by report + close) -----------------------
  function reconcileFromEvents(
    shift: Shift,
    events: ShiftCashEvent[],
  ): DrawerReconciliation {
    let cashSales = 0;
    let paidIn = 0;
    let payouts = 0;
    for (const e of events) {
      if (e.type === "sale") cashSales += e.amount_cents;
      else if (e.type === "paid_in") paidIn += e.amount_cents;
      else payouts += Math.abs(e.amount_cents);
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

  async function nextOrderNumber(
    tenantId: string,
    locationId: string,
  ): Promise<string> {
    // Sequential A-#### per location, derived from the current order count.
    const { count } = await sb
      .from("orders")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId)
      .eq("location_id", locationId);
    return `A-${String((count ?? 0) + 1).padStart(4, "0")}`;
  }

  // -------------------------------------------------------------------------
  // PosDriver implementation.
  // -------------------------------------------------------------------------
  const driver: PosDriver = {
    name: "supabase",

    // -- Tenancy + self-serve SaaS -----------------------------------------
    async listTenants() {
      return (unwrap(
        await sb.from("tenants").select("*").order("created_at"),
      ) as Row[]).map(mapTenant);
    },

    async getTenant(tenantId) {
      const r = unwrap(
        await sb.from("tenants").select("*").eq("id", tenantId).maybeSingle(),
      ) as Row | null;
      return r ? mapTenant(r) : null;
    },

    async createTenant(input) {
      const now = nowIso();
      const existingSlugs = new Set(
        ((unwrap(await sb.from("tenants").select("slug")) as Row[]) ?? []).map(
          (r) => r.slug as string,
        ),
      );
      let slug = slugify(input.businessName);
      if (existingSlugs.has(slug)) {
        let n = 2;
        while (existingSlugs.has(`${slug}-${n}`)) n += 1;
        slug = `${slug}-${n}`;
      }
      const tenant = mapTenant(
        unwrap(
          await sb
            .from("tenants")
            .insert({
              id: genUuid(),
              name: input.businessName.trim(),
              slug,
              status: "suspended",
              created_at: now,
            })
            .select()
            .single(),
        ) as Row,
      );

      const email = input.ownerEmail.trim().toLowerCase();
      let ownerRow = unwrap(
        await sb.from("users").select("*").eq("email", email).maybeSingle(),
      ) as Row | null;
      if (!ownerRow) {
        ownerRow = unwrap(
          await sb
            .from("users")
            .insert({ id: genUuid(), email, created_at: now })
            .select()
            .single(),
        ) as Row;
      }
      const owner = mapUser(ownerRow);

      // Owner membership so RLS lets them operate the tenant immediately.
      unwrap(
        await sb
          .from("memberships")
          .insert({
            id: genUuid(),
            user_id: owner.id,
            tenant_id: tenant.id,
            role: "owner",
            created_at: now,
          })
          .select(),
      );

      unwrap(
        await sb
          .from("tenant_onboarding")
          .insert({
            tenant_id: tenant.id,
            current_step: "location",
            completed_steps: ["business"],
            live: false,
            created_at: now,
            updated_at: now,
          })
          .select(),
      );

      return { tenant, owner };
    },

    async setTenantStatus(tenantId, status) {
      const r = unwrap(
        await sb
          .from("tenants")
          .update({ status })
          .eq("id", tenantId)
          .select()
          .maybeSingle(),
      ) as Row | null;
      return r ? mapTenant(r) : null;
    },

    async createLocation(input) {
      const now = nowIso();
      const existingSlugs = new Set(
        ((unwrap(await sb.from("locations").select("slug")) as Row[]) ?? []).map(
          (r) => r.slug as string,
        ),
      );
      let slug = slugify(input.name);
      if (existingSlugs.has(slug)) {
        let n = 2;
        while (existingSlugs.has(`${slug}-${n}`)) n += 1;
        slug = `${slug}-${n}`;
      }
      const location = mapLocation(
        unwrap(
          await sb
            .from("locations")
            .insert({
              id: genUuid(),
              tenant_id: input.tenant_id,
              name: input.name.trim(),
              slug,
              timezone: input.timezone ?? "America/New_York",
              address: input.address ?? null,
              created_at: now,
            })
            .select()
            .single(),
        ) as Row,
      );

      // Default store + payment settings for the new location.
      unwrap(
        await sb.from("store_settings").insert({
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
        }),
      );
      unwrap(
        await sb.from("payment_settings").insert({
          tenant_id: input.tenant_id,
          location_id: location.id,
          currency: "USD",
          platform_fee_bps: 250,
          platform_fee_flat_cents: 10,
          tip_presets_bps: [1500, 1800, 2000],
        }),
      );

      return location;
    },

    async importStarterMenu(tenantId) {
      const existing = unwrap(
        await sb
          .from("menu_categories")
          .select("id")
          .eq("tenant_id", tenantId)
          .limit(1),
      ) as Row[];
      if (existing.length > 0) return;
      const tpl = buildStarterMenu(tenantId);
      unwrap(await sb.from("menu_categories").insert(tpl.categories).select());
      unwrap(await sb.from("menu_items").insert(tpl.items).select());
      unwrap(await sb.from("item_sizes").insert(tpl.sizes).select());
      unwrap(
        await sb.from("modifier_groups").insert(tpl.modifierGroups).select(),
      );
      unwrap(await sb.from("modifiers").insert(tpl.modifiers).select());
      unwrap(
        await sb
          .from("item_modifier_groups")
          .insert(tpl.itemModifierGroups)
          .select(),
      );
    },

    // -- Onboarding --------------------------------------------------------
    async getOnboarding(tenantId) {
      const r = unwrap(
        await sb
          .from("tenant_onboarding")
          .select("*")
          .eq("tenant_id", tenantId)
          .maybeSingle(),
      ) as Row | null;
      return r ? mapOnboarding(r) : null;
    },

    async completeOnboardingStep(tenantId, step) {
      const now = nowIso();
      const existing = await this.getOnboarding(tenantId);
      const base: TenantOnboarding =
        existing ?? {
          tenant_id: tenantId,
          current_step: "business",
          completed_steps: [],
          live: false,
          created_at: now,
          updated_at: now,
        };
      const completed = base.completed_steps.includes(step)
        ? base.completed_steps
        : [...base.completed_steps, step];
      const next =
        ONBOARDING_STEPS.find((s) => !completed.includes(s)) ?? "go_live";
      const updated = mapOnboarding(
        unwrap(
          await sb
            .from("tenant_onboarding")
            .upsert({
              tenant_id: tenantId,
              current_step: next,
              completed_steps: completed,
              live: base.live,
              created_at: base.created_at,
              updated_at: now,
            })
            .select()
            .single(),
        ) as Row,
      );
      return updated;
    },

    async goLive(tenantId) {
      const ob = await this.completeOnboardingStep(tenantId, "go_live");
      const updated = mapOnboarding(
        unwrap(
          await sb
            .from("tenant_onboarding")
            .update({ live: true, updated_at: nowIso() })
            .eq("tenant_id", tenantId)
            .select()
            .single(),
        ) as Row,
      );
      await sb.from("tenants").update({ status: "active" }).eq("id", tenantId);
      return { ...ob, ...updated };
    },

    // -- Subscriptions -----------------------------------------------------
    async getSubscription(tenantId) {
      const r = unwrap(
        await sb
          .from("subscriptions")
          .select("*")
          .eq("tenant_id", tenantId)
          .maybeSingle(),
      ) as Row | null;
      return r ? mapSubscription(r) : null;
    },

    async upsertSubscription(sub) {
      const existing = await this.getSubscription(sub.tenant_id);
      const merged = mapSubscription(
        unwrap(
          await sb
            .from("subscriptions")
            .upsert({
              ...sub,
              created_at: existing?.created_at ?? sub.created_at ?? nowIso(),
              updated_at: nowIso(),
            })
            .select()
            .single(),
        ) as Row,
      );
      return merged;
    },

    async advanceSubscriptionStatus(tenantId, status) {
      const sub = await this.getSubscription(tenantId);
      if (!sub) return null;
      const updated = mapSubscription(
        unwrap(
          await sb
            .from("subscriptions")
            .update({
              status,
              current_period_end:
                status === "active"
                  ? new Date(Date.now() + 30 * 86_400_000).toISOString()
                  : sub.current_period_end,
              trial_end: status === "active" ? null : sub.trial_end,
              updated_at: nowIso(),
            })
            .eq("tenant_id", tenantId)
            .select()
            .single(),
        ) as Row,
      );
      return updated;
    },

    async changeSubscriptionTier(tenantId, tier) {
      const sub = await this.getSubscription(tenantId);
      if (!sub) return null;
      const updated = mapSubscription(
        unwrap(
          await sb
            .from("subscriptions")
            .update({ tier, updated_at: nowIso() })
            .eq("tenant_id", tenantId)
            .select()
            .single(),
        ) as Row,
      );
      return updated;
    },

    // -- Platform admin + health -------------------------------------------
    async isPlatformAdmin(userId) {
      const r = unwrap(
        await sb
          .from("platform_admins")
          .select("user_id")
          .eq("user_id", userId)
          .maybeSingle(),
      ) as Row | null;
      return r !== null;
    },

    async listPlatformAdmins() {
      return (unwrap(
        await sb.from("platform_admins").select("*"),
      ) as Row[]).map((r) => ({
        user_id: r.user_id as string,
        created_at: r.created_at as string,
      }));
    },

    async getUser(userId) {
      const r = unwrap(
        await sb.from("users").select("*").eq("id", userId).maybeSingle(),
      ) as Row | null;
      return r ? mapUser(r) : null;
    },

    async getUserByEmail(email) {
      const r = unwrap(
        await sb
          .from("users")
          .select("*")
          .ilike("email", email.trim())
          .maybeSingle(),
      ) as Row | null;
      return r ? mapUser(r) : null;
    },

    async listMembershipsForUser(userId) {
      return (
        unwrap(
          await sb.from("memberships").select("*").eq("user_id", userId),
        ) as Row[]
      ).map((r) => ({
        id: r.id as string,
        user_id: r.user_id as string,
        tenant_id: r.tenant_id as string,
        role: r.role as Membership["role"],
        created_at: r.created_at as string,
      }));
    },

    async listTenantHealth() {
      const tenantsList = await this.listTenants();
      const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
      const out: TenantHealth[] = [];
      for (const t of tenantsList) {
        const locs = unwrap(
          await sb.from("locations").select("id").eq("tenant_id", t.id),
        ) as Row[];
        const recent = unwrap(
          await sb
            .from("orders")
            .select("totals,status")
            .eq("tenant_id", t.id)
            .neq("status", "voided")
            .gte("created_at", since),
        ) as Row[];
        const connect = await this.getConnectAccount(t.id);
        out.push({
          tenant_id: t.id,
          name: t.name,
          slug: t.slug,
          status: t.status,
          location_count: locs.length,
          recent_order_count: recent.length,
          recent_gross_cents: recent.reduce(
            (sum, o) =>
              sum +
              ((o.totals as { total_cents?: number } | null)?.total_cents ?? 0),
            0,
          ),
          subscription: await this.getSubscription(t.id),
          onboarding: await this.getOnboarding(t.id),
          connected: connect?.status === "connected",
        });
      }
      return out;
    },

    // -- Audit log ---------------------------------------------------------
    async appendAuditLog(entry) {
      return mapAudit(
        unwrap(
          await sb
            .from("audit_log")
            .insert({ ...entry, id: genUuid(), created_at: nowIso() })
            .select()
            .single(),
        ) as Row,
      );
    },

    async listAuditLog(tenantId) {
      let q = sb
        .from("audit_log")
        .select("*")
        .order("created_at", { ascending: false });
      if (tenantId) q = q.eq("tenant_id", tenantId);
      return (unwrap(await q) as Row[]).map(mapAudit);
    },

    // -- Locations + menu read ---------------------------------------------
    async listLocations(tenantId) {
      return (unwrap(
        await sb.from("locations").select("*").eq("tenant_id", tenantId),
      ) as Row[]).map(mapLocation);
    },

    async getLocationBySlug(slug) {
      const r = unwrap(
        await sb.from("locations").select("*").eq("slug", slug).maybeSingle(),
      ) as Row | null;
      return r ? mapLocation(r) : null;
    },

    async getMenu(tenantId, locationId) {
      return assembleMenu(tenantId, locationId);
    },

    async getStoreSettings(tenantId, locationId) {
      const r = unwrap(
        await sb
          .from("store_settings")
          .select("*")
          .eq("tenant_id", tenantId)
          .eq("location_id", locationId)
          .maybeSingle(),
      ) as Row | null;
      if (r) return mapStoreSettings(r);
      return {
        tenant_id: tenantId,
        location_id: locationId,
        currency: "USD",
        tax_rate_bps: 0,
        tip_presets_bps: [1500, 1800, 2000],
        kds_thresholds: { warn_seconds: 300, urgent_seconds: 600 },
      };
    },

    // -- Orders ------------------------------------------------------------
    async createOrder(input) {
      const existingRow = unwrap(
        await sb.from("orders").select("*").eq("id", input.id).maybeSingle(),
      ) as Row | null;
      if (existingRow) return readOrderRow(existingRow);

      const now = nowIso();
      const orderNumber =
        input.order_number ??
        (await nextOrderNumber(input.tenant_id, input.location_id));
      const status = input.status ?? "placed";
      const orderRow = unwrap(
        await sb
          .from("orders")
          .insert({
            id: input.id,
            tenant_id: input.tenant_id,
            location_id: input.location_id,
            status,
            channel: input.channel,
            currency: input.currency,
            discount_cents: input.discount_cents,
            totals: input.totals,
            notes: input.notes,
            order_number: orderNumber,
            customer_id: input.customer_id ?? null,
            staff_id: input.staff_id ?? null,
            fulfillment: input.fulfillment ?? null,
            created_at: now,
            updated_at: now,
          })
          .select()
          .single(),
      ) as Row;
      await writeOrderItems(input.id, input.items);
      const order = await readOrderRow(orderRow);
      if (order.status !== "voided") await depleteForOrder(order);
      return order;
    },

    async getOrder(id) {
      const r = unwrap(
        await sb.from("orders").select("*").eq("id", id).maybeSingle(),
      ) as Row | null;
      return r ? readOrderRow(r) : null;
    },

    async listOrders(tenantId, locationId) {
      const rows = unwrap(
        await sb
          .from("orders")
          .select("*")
          .eq("tenant_id", tenantId)
          .eq("location_id", locationId)
          .order("created_at", { ascending: false }),
      ) as Row[];
      return Promise.all(rows.map((r) => readOrderRow(r)));
    },

    async updateOrderStatus(id, status) {
      const r = unwrap(
        await sb
          .from("orders")
          .update({ status, updated_at: nowIso() })
          .eq("id", id)
          .select()
          .maybeSingle(),
      ) as Row | null;
      return r ? readOrderRow(r) : null;
    },

    // -- Payments ----------------------------------------------------------
    async getPaymentSettings(tenantId, locationId) {
      const r = unwrap(
        await sb
          .from("payment_settings")
          .select("*")
          .eq("tenant_id", tenantId)
          .eq("location_id", locationId)
          .maybeSingle(),
      ) as Row | null;
      if (r) return mapPaymentSettings(r);
      return {
        tenant_id: tenantId,
        location_id: locationId,
        currency: "USD",
        platform_fee_bps: 250,
        platform_fee_flat_cents: 10,
        tip_presets_bps: [1500, 1800, 2000],
      };
    },

    async upsertPayment(payment) {
      const existing = unwrap(
        await sb
          .from("payments")
          .select("created_at")
          .eq("id", payment.id)
          .maybeSingle(),
      ) as Row | null;
      const now = nowIso();
      const row = mapPayment(
        unwrap(
          await sb
            .from("payments")
            .upsert({
              ...payment,
              created_at:
                (existing?.created_at as string) ?? payment.created_at ?? now,
              updated_at: now,
            })
            .select()
            .single(),
        ) as Row,
      );
      return row;
    },

    async getPayment(id) {
      const r = unwrap(
        await sb.from("payments").select("*").eq("id", id).maybeSingle(),
      ) as Row | null;
      return r ? mapPayment(r) : null;
    },

    async getPaymentByChargeId(chargeId) {
      const r = unwrap(
        await sb
          .from("payments")
          .select("*")
          .eq("charge_id", chargeId)
          .maybeSingle(),
      ) as Row | null;
      return r ? mapPayment(r) : null;
    },

    async listPaymentsForOrder(orderId) {
      return (unwrap(
        await sb
          .from("payments")
          .select("*")
          .eq("order_id", orderId)
          .order("created_at"),
      ) as Row[]).map(mapPayment);
    },

    // -- Stripe Connect ----------------------------------------------------
    async getConnectAccount(tenantId) {
      const r = unwrap(
        await sb
          .from("connect_accounts")
          .select("*")
          .eq("tenant_id", tenantId)
          .maybeSingle(),
      ) as Row | null;
      return r ? mapConnect(r) : null;
    },

    async upsertConnectAccount(account) {
      const existing = await this.getConnectAccount(account.tenant_id);
      return mapConnect(
        unwrap(
          await sb
            .from("connect_accounts")
            .upsert({
              ...account,
              created_at: existing?.created_at ?? account.created_at,
              updated_at: nowIso(),
            })
            .select()
            .single(),
        ) as Row,
      );
    },

    // -- Customers ---------------------------------------------------------
    async getCustomerByEmail(tenantId, email) {
      const r = unwrap(
        await sb
          .from("customers")
          .select("*")
          .eq("tenant_id", tenantId)
          .eq("email", email.trim().toLowerCase())
          .maybeSingle(),
      ) as Row | null;
      return r ? mapCustomer(r) : null;
    },

    async getCustomer(id) {
      const r = unwrap(
        await sb.from("customers").select("*").eq("id", id).maybeSingle(),
      ) as Row | null;
      return r ? mapCustomer(r) : null;
    },

    async upsertCustomer(customer) {
      const email = customer.email.trim().toLowerCase();
      const byId = unwrap(
        await sb
          .from("customers")
          .select("*")
          .eq("id", customer.id)
          .maybeSingle(),
      ) as Row | null;
      const byEmail = byId
        ? null
        : ((unwrap(
            await sb
              .from("customers")
              .select("*")
              .eq("tenant_id", customer.tenant_id)
              .eq("email", email)
              .maybeSingle(),
          ) as Row | null));
      const base = byId ? mapCustomer(byId) : byEmail ? mapCustomer(byEmail) : null;
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
      return mapCustomer(
        unwrap(
          await sb.from("customers").upsert(merged).select().single(),
        ) as Row,
      );
    },

    async createMagicLinkToken(token) {
      unwrap(await sb.from("magic_link_tokens").insert(token).select());
      return token;
    },

    async consumeMagicLinkToken(token) {
      const rec = unwrap(
        await sb
          .from("magic_link_tokens")
          .select("*")
          .eq("token", token)
          .maybeSingle(),
      ) as Row | null;
      if (!rec || rec.consumed) return null;
      if (new Date(rec.expires_at as string).getTime() < Date.now())
        return null;
      unwrap(
        await sb
          .from("magic_link_tokens")
          .update({ consumed: true })
          .eq("token", token),
      );
      const customer = unwrap(
        await sb
          .from("customers")
          .select("*")
          .eq("id", rec.customer_id as string)
          .maybeSingle(),
      ) as Row | null;
      if (!customer) return null;
      return mapCustomer(
        unwrap(
          await sb
            .from("customers")
            .update({ verified: true, updated_at: nowIso() })
            .eq("id", rec.customer_id as string)
            .select()
            .single(),
        ) as Row,
      );
    },

    // -- Deliveries --------------------------------------------------------
    async upsertDelivery(delivery) {
      const existing = unwrap(
        await sb
          .from("deliveries")
          .select("created_at")
          .eq("id", delivery.id)
          .maybeSingle(),
      ) as Row | null;
      const now = nowIso();
      return mapDelivery(
        unwrap(
          await sb
            .from("deliveries")
            .upsert({
              ...delivery,
              created_at:
                (existing?.created_at as string) ?? delivery.created_at ?? now,
              updated_at: now,
            })
            .select()
            .single(),
        ) as Row,
      );
    },

    async getDeliveryForOrder(orderId) {
      const r = unwrap(
        await sb
          .from("deliveries")
          .select("*")
          .eq("order_id", orderId)
          .maybeSingle(),
      ) as Row | null;
      return r ? mapDelivery(r) : null;
    },

    async getDelivery(id) {
      const r = unwrap(
        await sb.from("deliveries").select("*").eq("id", id).maybeSingle(),
      ) as Row | null;
      return r ? mapDelivery(r) : null;
    },

    async listDeliveries(tenantId, locationId) {
      return (unwrap(
        await sb
          .from("deliveries")
          .select("*")
          .eq("tenant_id", tenantId)
          .eq("location_id", locationId)
          .order("created_at", { ascending: false }),
      ) as Row[]).map(mapDelivery);
    },

    // -- Menu management ---------------------------------------------------
    async listCategories(tenantId) {
      return (unwrap(
        await sb
          .from("menu_categories")
          .select("*")
          .eq("tenant_id", tenantId)
          .order("sort_order"),
      ) as Row[]).map((r) => ({
        id: r.id as string,
        tenant_id: r.tenant_id as string,
        name: r.name as string,
        sort_order: r.sort_order as number,
      }));
    },

    async upsertCategory(input: CategoryInput) {
      if (input.id) {
        const cur = unwrap(
          await sb
            .from("menu_categories")
            .select("*")
            .eq("id", input.id)
            .maybeSingle(),
        ) as Row | null;
        if (cur) {
          const r = unwrap(
            await sb
              .from("menu_categories")
              .update({
                name: input.name,
                sort_order: input.sort_order ?? (cur.sort_order as number),
              })
              .eq("id", input.id)
              .select()
              .single(),
          ) as Row;
          return {
            id: r.id as string,
            tenant_id: r.tenant_id as string,
            name: r.name as string,
            sort_order: r.sort_order as number,
          };
        }
      }
      const count = (unwrap(
        await sb
          .from("menu_categories")
          .select("id")
          .eq("tenant_id", input.tenant_id),
      ) as Row[]).length;
      const r = unwrap(
        await sb
          .from("menu_categories")
          .insert({
            id: input.id ?? genUuid(),
            tenant_id: input.tenant_id,
            name: input.name,
            sort_order: input.sort_order ?? count + 1,
          })
          .select()
          .single(),
      ) as Row;
      return {
        id: r.id as string,
        tenant_id: r.tenant_id as string,
        name: r.name as string,
        sort_order: r.sort_order as number,
      };
    },

    async deleteCategory(id) {
      // FK cascade drops items -> sizes / links; overrides cascade via location.
      unwrap(await sb.from("menu_categories").delete().eq("id", id).select());
    },

    async upsertItem(input: ItemInput) {
      if (input.id) {
        const cur = unwrap(
          await sb
            .from("menu_items")
            .select("*")
            .eq("id", input.id)
            .maybeSingle(),
        ) as Row | null;
        if (cur) {
          const r = unwrap(
            await sb
              .from("menu_items")
              .update({
                category_id: input.category_id,
                name: input.name,
                description: input.description ?? (cur.description as string | null),
                is_half_and_half_capable:
                  input.is_half_and_half_capable ??
                  (cur.is_half_and_half_capable as boolean),
                station: input.station ?? (cur.station as MenuItem["station"]),
              })
              .eq("id", input.id)
              .select()
              .single(),
          ) as Row;
          return {
            id: r.id as string,
            tenant_id: r.tenant_id as string,
            category_id: r.category_id as string,
            name: r.name as string,
            description: (r.description as string | null) ?? null,
            is_half_and_half_capable: r.is_half_and_half_capable as boolean,
            station: r.station as MenuItem["station"],
          };
        }
      }
      const r = unwrap(
        await sb
          .from("menu_items")
          .insert({
            id: input.id ?? genUuid(),
            tenant_id: input.tenant_id,
            category_id: input.category_id,
            name: input.name,
            description: input.description ?? null,
            is_half_and_half_capable: input.is_half_and_half_capable ?? false,
            station: input.station ?? "oven",
          })
          .select()
          .single(),
      ) as Row;
      return {
        id: r.id as string,
        tenant_id: r.tenant_id as string,
        category_id: r.category_id as string,
        name: r.name as string,
        description: (r.description as string | null) ?? null,
        is_half_and_half_capable: r.is_half_and_half_capable as boolean,
        station: r.station as MenuItem["station"],
      };
    },

    async deleteItem(id) {
      unwrap(await sb.from("menu_items").delete().eq("id", id).select());
    },

    async upsertSize(input: SizeInput) {
      if (input.id) {
        const cur = unwrap(
          await sb
            .from("item_sizes")
            .select("*")
            .eq("id", input.id)
            .maybeSingle(),
        ) as Row | null;
        if (cur) {
          const r = unwrap(
            await sb
              .from("item_sizes")
              .update({
                name: input.name,
                price_cents: input.price_cents,
                sort_order: input.sort_order ?? (cur.sort_order as number),
              })
              .eq("id", input.id)
              .select()
              .single(),
          ) as Row;
          return {
            id: r.id as string,
            item_id: r.item_id as string,
            name: r.name as string,
            price_cents: r.price_cents as number,
            sort_order: r.sort_order as number,
          };
        }
      }
      const count = (unwrap(
        await sb.from("item_sizes").select("id").eq("item_id", input.item_id),
      ) as Row[]).length;
      const r = unwrap(
        await sb
          .from("item_sizes")
          .insert({
            id: input.id ?? genUuid(),
            item_id: input.item_id,
            name: input.name,
            price_cents: input.price_cents,
            sort_order: input.sort_order ?? count + 1,
          })
          .select()
          .single(),
      ) as Row;
      return {
        id: r.id as string,
        item_id: r.item_id as string,
        name: r.name as string,
        price_cents: r.price_cents as number,
        sort_order: r.sort_order as number,
      };
    },

    async deleteSize(id) {
      unwrap(await sb.from("item_sizes").delete().eq("id", id).select());
    },

    async listModifierGroups(tenantId) {
      return (unwrap(
        await sb
          .from("modifier_groups")
          .select("*")
          .eq("tenant_id", tenantId),
      ) as Row[]).map((r) => ({
        id: r.id as string,
        tenant_id: r.tenant_id as string,
        name: r.name as string,
        min_select: r.min_select as number,
        max_select: r.max_select as number,
        supports_half: r.supports_half as boolean,
      }));
    },

    async upsertModifierGroup(input: ModifierGroupInput) {
      if (input.id) {
        const cur = unwrap(
          await sb
            .from("modifier_groups")
            .select("*")
            .eq("id", input.id)
            .maybeSingle(),
        ) as Row | null;
        if (cur) {
          const r = unwrap(
            await sb
              .from("modifier_groups")
              .update({
                name: input.name,
                min_select: input.min_select ?? (cur.min_select as number),
                max_select: input.max_select ?? (cur.max_select as number),
                supports_half:
                  input.supports_half ?? (cur.supports_half as boolean),
              })
              .eq("id", input.id)
              .select()
              .single(),
          ) as Row;
          return {
            id: r.id as string,
            tenant_id: r.tenant_id as string,
            name: r.name as string,
            min_select: r.min_select as number,
            max_select: r.max_select as number,
            supports_half: r.supports_half as boolean,
          };
        }
      }
      const r = unwrap(
        await sb
          .from("modifier_groups")
          .insert({
            id: input.id ?? genUuid(),
            tenant_id: input.tenant_id,
            name: input.name,
            min_select: input.min_select ?? 0,
            max_select: input.max_select ?? 1,
            supports_half: input.supports_half ?? false,
          })
          .select()
          .single(),
      ) as Row;
      return {
        id: r.id as string,
        tenant_id: r.tenant_id as string,
        name: r.name as string,
        min_select: r.min_select as number,
        max_select: r.max_select as number,
        supports_half: r.supports_half as boolean,
      };
    },

    async deleteModifierGroup(id) {
      unwrap(await sb.from("modifier_groups").delete().eq("id", id).select());
    },

    async upsertModifier(input: ModifierInput) {
      if (input.id) {
        const cur = unwrap(
          await sb
            .from("modifiers")
            .select("*")
            .eq("id", input.id)
            .maybeSingle(),
        ) as Row | null;
        if (cur) {
          const r = unwrap(
            await sb
              .from("modifiers")
              .update({
                name: input.name,
                price_cents: input.price_cents,
                sort_order: input.sort_order ?? (cur.sort_order as number),
              })
              .eq("id", input.id)
              .select()
              .single(),
          ) as Row;
          return {
            id: r.id as string,
            group_id: r.group_id as string,
            name: r.name as string,
            price_cents: r.price_cents as number,
            sort_order: r.sort_order as number,
          };
        }
      }
      const count = (unwrap(
        await sb.from("modifiers").select("id").eq("group_id", input.group_id),
      ) as Row[]).length;
      const r = unwrap(
        await sb
          .from("modifiers")
          .insert({
            id: input.id ?? genUuid(),
            group_id: input.group_id,
            name: input.name,
            price_cents: input.price_cents,
            sort_order: input.sort_order ?? count + 1,
          })
          .select()
          .single(),
      ) as Row;
      return {
        id: r.id as string,
        group_id: r.group_id as string,
        name: r.name as string,
        price_cents: r.price_cents as number,
        sort_order: r.sort_order as number,
      };
    },

    async deleteModifier(id) {
      unwrap(await sb.from("modifiers").delete().eq("id", id).select());
    },

    // -- Per-location overrides --------------------------------------------
    async listOverrides(tenantId, locationId) {
      return (unwrap(
        await sb
          .from("location_menu_overrides")
          .select("*")
          .eq("tenant_id", tenantId)
          .eq("location_id", locationId),
      ) as Row[]).map(mapOverride);
    },

    async upsertOverride(input: OverrideInput) {
      const existing = unwrap(
        await sb
          .from("location_menu_overrides")
          .select("*")
          .eq("location_id", input.location_id)
          .eq("target_type", input.target_type)
          .eq("target_id", input.target_id)
          .maybeSingle(),
      ) as Row | null;
      const base = existing ? mapOverride(existing) : null;
      const merged: LocationMenuOverride = {
        id: base?.id ?? genUuid(),
        tenant_id: input.tenant_id,
        location_id: input.location_id,
        target_type: input.target_type,
        target_id: input.target_id,
        price_cents:
          input.price_cents !== undefined
            ? input.price_cents
            : (base?.price_cents ?? null),
        available:
          input.available !== undefined
            ? input.available
            : (base?.available ?? null),
        updated_at: nowIso(),
      };
      if (merged.price_cents == null && merged.available == null) {
        if (base) {
          unwrap(
            await sb
              .from("location_menu_overrides")
              .delete()
              .eq("id", base.id)
              .select(),
          );
        }
        return merged;
      }
      return mapOverride(
        unwrap(
          await sb
            .from("location_menu_overrides")
            .upsert(merged, {
              onConflict: "location_id,target_type,target_id",
            })
            .select()
            .single(),
        ) as Row,
      );
    },

    async clearOverride(tenantId, locationId, targetType, targetId) {
      unwrap(
        await sb
          .from("location_menu_overrides")
          .delete()
          .eq("location_id", locationId)
          .eq("target_type", targetType)
          .eq("target_id", targetId)
          .select(),
      );
    },

    // -- Inventory ---------------------------------------------------------
    async listInventory(tenantId, locationId) {
      return (unwrap(
        await sb
          .from("inventory_items")
          .select("*")
          .eq("tenant_id", tenantId)
          .eq("location_id", locationId)
          .order("name"),
      ) as Row[])
        .map(mapInventoryItem)
        .map(
          (i): InventoryItemView => ({
            ...i,
            low: i.on_hand <= i.low_threshold,
          }),
        );
    },

    async upsertInventoryItem(item) {
      const existing = item.id
        ? ((unwrap(
            await sb
              .from("inventory_items")
              .select("created_at")
              .eq("id", item.id)
              .maybeSingle(),
          ) as Row | null))
        : null;
      const now = nowIso();
      return mapInventoryItem(
        unwrap(
          await sb
            .from("inventory_items")
            .upsert({
              ...item,
              id: item.id || genUuid(),
              created_at:
                (existing?.created_at as string) ?? item.created_at ?? now,
              updated_at: now,
            })
            .select()
            .single(),
        ) as Row,
      );
    },

    async applyInventoryMovement(input) {
      const result = await applyMovementInternal(input);
      if (!result) {
        throw new Error(`Inventory item ${input.inventoryItemId} not found.`);
      }
      return result;
    },

    async listInventoryMovements(tenantId, locationId) {
      return (unwrap(
        await sb
          .from("inventory_movements")
          .select("*")
          .eq("tenant_id", tenantId)
          .eq("location_id", locationId)
          .order("created_at", { ascending: false }),
      ) as Row[]).map(mapInventoryMovement);
    },

    // -- Reports + end-of-day ----------------------------------------------
    async getSalesReport(tenantId, locationId, range: DateRange) {
      let oq = sb.from("orders").select("*").eq("tenant_id", tenantId);
      if (locationId !== null) oq = oq.eq("location_id", locationId);
      const orderRows = unwrap(await oq) as Row[];
      const scoped = await Promise.all(orderRows.map((r) => readOrderRow(r)));
      const orderIds = scoped.map((o) => o.id);
      const scopedPayments =
        orderIds.length === 0
          ? []
          : (unwrap(
              await sb.from("payments").select("*").in("order_id", orderIds),
            ) as Row[]).map(mapPayment);

      // Resolve category + location labels (tenant-scoped reads).
      const itemRows = unwrap(
        await sb
          .from("menu_items")
          .select("id,category_id")
          .eq("tenant_id", tenantId),
      ) as Row[];
      const catRows = unwrap(
        await sb
          .from("menu_categories")
          .select("id,name")
          .eq("tenant_id", tenantId),
      ) as Row[];
      const locRows = unwrap(
        await sb
          .from("locations")
          .select("id,name")
          .eq("tenant_id", tenantId),
      ) as Row[];
      const catNameById = new Map(
        catRows.map((c) => [c.id as string, c.name as string]),
      );
      const catOfItem = new Map(
        itemRows.map((i) => [i.id as string, i.category_id as string]),
      );
      const locNameById = new Map(
        locRows.map((l) => [l.id as string, l.name as string]),
      );

      return buildSalesReport({
        tenantId,
        locationId,
        range,
        orders: scoped,
        payments: scopedPayments,
        categoryOf: (itemId: string) => {
          const cid = catOfItem.get(itemId);
          if (!cid) return null;
          return { id: cid, name: catNameById.get(cid) ?? cid };
        },
        locationName: (id: string) => locNameById.get(id) ?? id,
      });
    },

    async getBusinessDayClose(tenantId, locationId, businessDate) {
      const r = unwrap(
        await sb
          .from("business_day_closes")
          .select("*")
          .eq("location_id", locationId)
          .eq("business_date", businessDate)
          .maybeSingle(),
      ) as Row | null;
      if (!r) return null;
      return {
        id: r.id as string,
        tenant_id: r.tenant_id as string,
        location_id: r.location_id as string,
        business_date: r.business_date as string,
        closed_at: r.closed_at as string,
        report: r.report as SalesReport,
        drawer: r.drawer as BusinessDayClose["drawer"],
      };
    },

    async closeBusinessDay(tenantId, locationId, businessDate) {
      const existing = await this.getBusinessDayClose(
        tenantId,
        locationId,
        businessDate,
      );
      if (existing) return existing;

      const report = await this.getSalesReport(tenantId, locationId, {
        from: businessDate,
        to: businessDate,
      });

      const shiftRows = unwrap(
        await sb
          .from("shifts")
          .select("*")
          .eq("location_id", locationId)
          .eq("status", "closed")
          .not("closed_at", "is", null),
      ) as Row[];
      const dayShifts = shiftRows
        .map(mapShift)
        .filter((s) => s.closed_at != null && isoDate(s.closed_at) === businessDate);

      let openingFloat = 0;
      let cashSales = 0;
      let expected = 0;
      let counted = 0;
      for (const s of dayShifts) {
        const events = (unwrap(
          await sb.from("shift_cash_events").select("*").eq("shift_id", s.id),
        ) as Row[]).map(
          (e): ShiftCashEvent => ({
            id: e.id as string,
            shift_id: e.shift_id as string,
            tenant_id: e.tenant_id as string,
            location_id: e.location_id as string,
            type: e.type as ShiftCashEvent["type"],
            amount_cents: e.amount_cents as number,
            order_id: (e.order_id as string | null) ?? null,
            note: (e.note as string | null) ?? null,
            created_at: e.created_at as string,
          }),
        );
        const rec = reconcileFromEvents(s, events);
        openingFloat += rec.opening_float_cents;
        cashSales += rec.cash_sales_cents;
        expected += rec.expected_cents;
        counted += rec.counted_cents ?? rec.expected_cents;
      }

      const drawer = {
        opening_float_cents: openingFloat,
        cash_sales_cents: cashSales,
        expected_cents: expected,
        counted_cents: counted,
        over_short_cents: counted - expected,
        shift_count: dayShifts.length,
      };
      const r = unwrap(
        await sb
          .from("business_day_closes")
          .insert({
            id: genUuid(),
            tenant_id: tenantId,
            location_id: locationId,
            business_date: businessDate,
            closed_at: nowIso(),
            report,
            drawer,
          })
          .select()
          .single(),
      ) as Row;
      return {
        id: r.id as string,
        tenant_id: r.tenant_id as string,
        location_id: r.location_id as string,
        business_date: r.business_date as string,
        closed_at: r.closed_at as string,
        report: r.report as SalesReport,
        drawer: r.drawer as BusinessDayClose["drawer"],
      };
    },

    // -- Staff & shifts ----------------------------------------------------
    async listStaff(tenantId) {
      // pin_hash omitted (default) so it never reaches the client.
      return (unwrap(
        await sb
          .from("staff")
          .select("*")
          .eq("tenant_id", tenantId)
          .order("name"),
      ) as Row[]).map((r) => mapStaff(r));
    },

    async getStaffById(tenantId, staffId) {
      const r = unwrap(
        await sb
          .from("staff")
          .select("*")
          .eq("tenant_id", tenantId)
          .eq("id", staffId)
          .maybeSingle(),
      ) as Row | null;
      // includePin: this is the trusted server PIN-verification path only.
      return r ? mapStaff(r, { includePin: true }) : null;
    },

    async upsertStaff(staff) {
      const existing = staff.id
        ? ((unwrap(
            await sb
              .from("staff")
              .select("created_at")
              .eq("id", staff.id)
              .maybeSingle(),
          ) as Row | null))
        : null;
      // Only write pin_hash when the caller explicitly set it (not undefined),
      // so an unrelated update can't accidentally wipe a staff member's PIN.
      const { pin_hash, ...rest } = staff;
      const row: Record<string, unknown> = {
        ...rest,
        id: staff.id || genUuid(),
        created_at:
          (existing?.created_at as string) ?? staff.created_at ?? nowIso(),
      };
      if (pin_hash !== undefined) row.pin_hash = pin_hash;
      return mapStaff(
        unwrap(await sb.from("staff").upsert(row).select().single()) as Row,
      );
    },

    async listShifts(tenantId, locationId) {
      return (unwrap(
        await sb
          .from("shifts")
          .select("*")
          .eq("tenant_id", tenantId)
          .eq("location_id", locationId)
          .order("opened_at", { ascending: false }),
      ) as Row[]).map(mapShift);
    },

    async getOpenShift(tenantId, locationId, staffId) {
      const r = unwrap(
        await sb
          .from("shifts")
          .select("*")
          .eq("tenant_id", tenantId)
          .eq("location_id", locationId)
          .eq("staff_id", staffId)
          .eq("status", "open")
          .maybeSingle(),
      ) as Row | null;
      return r ? mapShift(r) : null;
    },

    async openShift(input) {
      const open = await this.getOpenShift(
        input.tenantId,
        input.locationId,
        input.staffId,
      );
      if (open) return open;
      const now = nowIso();
      return mapShift(
        unwrap(
          await sb
            .from("shifts")
            .insert({
              id: genUuid(),
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
            })
            .select()
            .single(),
        ) as Row,
      );
    },

    async addShiftCashEvent(event) {
      const r = unwrap(
        await sb
          .from("shift_cash_events")
          .insert({
            ...event,
            id: event.id || genUuid(),
            created_at: event.created_at || nowIso(),
          })
          .select()
          .single(),
      ) as Row;
      return {
        id: r.id as string,
        shift_id: r.shift_id as string,
        tenant_id: r.tenant_id as string,
        location_id: r.location_id as string,
        type: r.type as ShiftCashEvent["type"],
        amount_cents: r.amount_cents as number,
        order_id: (r.order_id as string | null) ?? null,
        note: (r.note as string | null) ?? null,
        created_at: r.created_at as string,
      };
    },

    async listShiftCashEvents(shiftId) {
      return (unwrap(
        await sb
          .from("shift_cash_events")
          .select("*")
          .eq("shift_id", shiftId)
          .order("created_at"),
      ) as Row[]).map((e) => ({
        id: e.id as string,
        shift_id: e.shift_id as string,
        tenant_id: e.tenant_id as string,
        location_id: e.location_id as string,
        type: e.type as ShiftCashEvent["type"],
        amount_cents: e.amount_cents as number,
        order_id: (e.order_id as string | null) ?? null,
        note: (e.note as string | null) ?? null,
        created_at: e.created_at as string,
      }));
    },

    async getDrawerReconciliation(shiftId) {
      const shiftRow = unwrap(
        await sb.from("shifts").select("*").eq("id", shiftId).maybeSingle(),
      ) as Row | null;
      if (!shiftRow) throw new Error(`Shift ${shiftId} not found.`);
      const events = await this.listShiftCashEvents(shiftId);
      return reconcileFromEvents(mapShift(shiftRow), events);
    },

    async closeShift(input) {
      const r = unwrap(
        await sb
          .from("shifts")
          .update({
            status: "closed",
            closed_at: nowIso(),
            counted_cents: input.countedCents,
            close_note: input.note ?? null,
          })
          .eq("id", input.shiftId)
          .select()
          .maybeSingle(),
      ) as Row | null;
      return r ? mapShift(r) : null;
    },
  };

  return driver;
}
