/**
 * POS rows -> Open Pizza core contract (`@openpizza/core` v1) mappers.
 *
 * PURE (no I/O, no env): every function takes POS domain objects and returns a
 * contract object that validates against the matching zod schema. The `/api/v1`
 * handlers and the event outbox share these, so a resource looks identical in a
 * REST response and in a webhook payload.
 *
 * Conventions: money stays integer cents; POS's single `order_status` is split
 * onto the two contract axes (`fromPosOrderStatus`); POS `shifts` are exposed as
 * `drawer_sessions`; ids are POS ids verbatim (the contract accepts them).
 */
import {
  allocate,
  businessDate,
  fromPosChannel,
  fromPosOrderStatus,
  stableHash,
  type Address as CoreAddress,
  type Customer as CoreCustomer,
  type DailySales as CoreDailySales,
  type Delivery as CoreDelivery,
  type DrawerSession as CoreDrawerSession,
  type Location as CoreLocation,
  type Menu as CoreMenu,
  type Order as CoreOrder,
  type OrderLine as CoreOrderLine,
  type Payment as CorePayment,
  type StaffMember as CoreStaffMember,
  type Tenant as CoreTenant,
} from "@openpizza/core";
import type {
  BusinessDayClose,
  Customer,
  DeliveryRecord,
  DrawerReconciliation,
  LocationMenuOverride,
  Menu,
  Order,
  OrderItem,
  Payment,
  Shift,
  Staff,
  StoreSettings,
  Tenant,
  Location,
} from "@/lib/db";

const PHONE_RE = /^\+[1-9]\d{6,14}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const POS_SOURCE = "openpizza_pos" as const;

function cleanPhone(p: string | null | undefined): string | null {
  if (!p) return null;
  const compact = p.replace(/[\s().-]/g, "");
  return PHONE_RE.test(compact) ? compact : null;
}

function cleanEmail(e: string | null | undefined): string | null {
  return e && EMAIL_RE.test(e) ? e : null;
}

/** Force an ISO string into RFC 3339 UTC `Z` form (Postgres returns `+00:00`). */
export function ts(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? new Date(0).toISOString() : d.toISOString();
}

// ---------------------------------------------------------------------------
// Tenant
// ---------------------------------------------------------------------------

export function toContractTenant(
  tenant: Tenant,
  firstLocation: { timezone: string; currency: string } | null,
): CoreTenant {
  return {
    id: tenant.id,
    name: tenant.name,
    slug: tenant.slug,
    status: tenant.status,
    source: POS_SOURCE,
    default_currency: firstLocation?.currency ?? "USD",
    default_timezone: firstLocation?.timezone ?? "America/New_York",
    locale: "en-US",
    external_ids: {},
    created_at: ts(tenant.created_at),
    updated_at: ts(tenant.created_at),
  };
}

// ---------------------------------------------------------------------------
// Location
// ---------------------------------------------------------------------------

function addressOf(loc: Location): CoreAddress {
  const country =
    loc.country && /^[A-Z]{2}$/.test(loc.country) ? loc.country : "US";
  if (loc.address_line1 && loc.city) {
    return {
      line1: loc.address_line1,
      line2: loc.address_line2 ?? null,
      city: loc.city,
      region: loc.region ?? null,
      postal_code: loc.postal_code ?? null,
      country,
    };
  }
  // Legacy single-line address: "123 Main St, Springfield".
  const parts = (loc.address ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  return {
    line1: parts[0] ?? loc.name,
    line2: null,
    city: loc.city ?? parts[1] ?? "Unknown",
    region: loc.region ?? null,
    postal_code: loc.postal_code ?? null,
    country,
  };
}

const DEFAULT_FULFILLMENT = {
  pickup_enabled: true,
  delivery_enabled: false,
  prep_minutes: 15,
  scheduling_lead_minutes: 0,
  scheduling_horizon_days: 7,
  hours: [] as NonNullable<
    NonNullable<StoreSettings["fulfillment"]>["hours"]
  >,
  delivery_zones: [] as NonNullable<
    NonNullable<StoreSettings["fulfillment"]>["delivery_zones"]
  >,
  delivery_providers: [] as string[],
};

export function toContractLocation(
  loc: Location,
  settings: StoreSettings,
): CoreLocation {
  const f = settings.fulfillment ?? DEFAULT_FULFILLMENT;
  const address = addressOf(loc);
  const geo =
    typeof loc.lat === "number" && typeof loc.lng === "number"
      ? { lat: loc.lat, lng: loc.lng }
      : null;
  return {
    id: loc.id,
    tenant_id: loc.tenant_id,
    name: loc.name,
    slug: loc.slug,
    status: "active",
    timezone: loc.timezone,
    currency: settings.currency,
    address,
    geo,
    jurisdiction: {
      country: address.country,
      region: address.region ?? null,
      code: address.region
        ? `${address.country}-${address.region}`
        : address.country,
    },
    hours: {
      regular: f.hours.map((d) => ({
        weekday: d.weekday,
        windows: d.closed ? [] : [{ open: d.open, close: d.close }],
      })),
      special: [],
      services: {},
    },
    fulfillment: {
      pickup_enabled: f.pickup_enabled,
      delivery_enabled: f.delivery_enabled,
      dine_in_enabled: true,
      accepting_orders: true,
      prep_minutes: f.prep_minutes,
      scheduling_lead_minutes: f.scheduling_lead_minutes,
      scheduling_horizon_days: f.scheduling_horizon_days,
      delivery_zones: f.delivery_zones.map((z) => ({
        id: z.id,
        name: z.name,
        postal_codes: z.postal_codes,
        fee_cents: z.fee_cents,
        eta_minutes: z.eta_minutes,
        min_subtotal_cents: z.min_subtotal_cents,
      })),
      delivery_providers: f.delivery_providers,
      tip_presets_bps: settings.tip_presets_bps,
      max_line_quantity: 99,
    },
    pricing: {
      tax_rate_bps: settings.tax_rate_bps,
      delivery_fee_taxable: false,
      service_fee_bps: 0,
      service_fee_taxable: true,
    },
    payment_methods: ["card", "cash", "crypto"],
    external_ids: {},
    created_at: ts(loc.created_at),
    updated_at: ts(loc.created_at),
  };
}

// ---------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------

type ItemKind =
  | "pizza"
  | "side"
  | "salad"
  | "wings"
  | "drink"
  | "dessert"
  | "other";

/** POS has no item kind; infer it from the category/item name. */
export function inferItemKind(categoryName: string, itemName: string): ItemKind {
  const s = `${categoryName} ${itemName}`.toLowerCase();
  if (/(wing)/.test(s)) return "wings";
  if (/(salad)/.test(s)) return "salad";
  if (/(drink|soda|beverage|water|juice|coffee|tea)/.test(s)) return "drink";
  if (/(dessert|cannoli|cookie|brownie|cake|zeppol|gelato)/.test(s))
    return "dessert";
  if (/(pizza|pie|slice|calzone)/.test(s)) return "pizza";
  if (/(side|knot|bread|fries|garlic|appetizer)/.test(s)) return "side";
  return "other";
}

type ModifierRole = "crust" | "sauce" | "cheese" | "topping" | "dressing" | "other";

/** POS modifier groups are untyped; infer the contract role from the name. */
export function inferModifierRole(groupName: string): ModifierRole {
  const s = groupName.toLowerCase();
  if (/crust|dough/.test(s)) return "crust";
  if (/sauce/.test(s)) return "sauce";
  if (/cheese/.test(s)) return "cheese";
  if (/topping/.test(s)) return "topping";
  if (/dressing/.test(s)) return "dressing";
  return "other";
}

/**
 * Contract menu for a location. Pass the menu read with
 * `includeUnavailable: true` plus the location's overrides: 86'd items stay in
 * the menu with `availability.available = false` (consumers see them, `priceCart`
 * rejects them), and prices already include location overrides.
 */
export function toContractMenu(input: {
  menu: Menu;
  overrides: LocationMenuOverride[];
  currency: string;
  now?: Date;
}): CoreMenu {
  const { menu, overrides, currency } = input;
  const eighty6 = (type: LocationMenuOverride["target_type"], id: string) =>
    overrides.some(
      (o) => o.target_type === type && o.target_id === id && o.available === false,
    );
  const avail = (type: LocationMenuOverride["target_type"], id: string) =>
    eighty6(type, id)
      ? { available: false, reason: "86" }
      : { available: true };

  const categories = menu.categories.map((cat, ci) => ({
    id: cat.id,
    name: cat.name,
    sort_order: cat.sort_order ?? ci,
    external_ids: {},
    items: cat.items.map((item, ii) => {
      const sizes =
        item.sizes.length > 0
          ? item.sizes.map((s) => ({
              id: s.id,
              name: s.name,
              price_cents: s.price_cents,
              availability: avail("size", s.id),
              sort_order: s.sort_order,
              external_ids: {},
            }))
          : [
              // POS items without sizes are priced purely by modifiers.
              // Synthetic single size; its id is the item id (see cartToPosLines).
              {
                id: item.id,
                name: "Regular",
                price_cents: 0,
                availability: avail("item", item.id),
                sort_order: 0,
                external_ids: {},
              },
            ];
      return {
        id: item.id,
        category_id: cat.id,
        name: item.name,
        description: item.description,
        kind: inferItemKind(cat.name, item.name),
        sizes,
        modifier_groups: item.modifierGroups.map((g, gi) => ({
          id: g.id,
          name: g.name,
          role: inferModifierRole(g.name),
          role_inferred: true,
          min_select: g.min_select,
          max_select: Math.max(1, g.max_select),
          supports_half: g.supports_half,
          // Mirrors the POS builder: required single-select groups default to
          // their first option.
          default_modifier_ids:
            g.min_select >= 1 && g.max_select === 1 && g.modifiers[0]
              ? [g.modifiers[0].id]
              : ([] as string[]),
          sort_order: gi,
          external_ids: {},
          modifiers: g.modifiers.map((m) => ({
            id: m.id,
            group_id: g.id,
            name: m.name,
            price_cents: m.price_cents,
            availability: avail("modifier", m.id),
            dietary_tags: [] as string[],
            sort_order: m.sort_order,
            external_ids: {},
          })),
        })),
        half_and_half: {
          allowed: item.is_half_and_half_capable,
          pricing_rule: "half_price_ceil",
          specialty_halves: false,
        },
        availability: avail("item", item.id),
        dietary_tags: [] as string[],
        tags: [] as string[],
        images: [] as { url: string }[],
        station: item.station,
        tax_exempt: false,
        sort_order: ii,
        external_ids: {},
      };
    }),
  }));

  const body = { tenant_id: menu.tenantId, location_id: menu.locationId, categories };
  return {
    tenant_id: menu.tenantId,
    location_id: menu.locationId,
    currency,
    version: stableHash(body),
    as_of: (input.now ?? new Date()).toISOString(),
    categories,
  } as CoreMenu;
}

// ---------------------------------------------------------------------------
// Payments + orders
// ---------------------------------------------------------------------------

export function railToMethod(rail: string): "card" | "cash" | "crypto" | "other" {
  if (rail === "cash") return "cash";
  if (rail.startsWith("stripe")) return "card";
  if (rail.startsWith("crypto")) return "crypto";
  return "other";
}

export function railToProcessor(rail: string): string {
  if (rail.startsWith("stripe")) return "stripe";
  if (rail === "crypto_coinbase") return "coinbase";
  return rail;
}

/** Tender status with the refund variants the contract has and POS folds. */
function tenderStatus(p: Payment): string {
  if (p.refunded_cents > 0 && p.status !== "refunded") {
    return p.refunded_cents >= p.amount_cents + p.tip_cents
      ? "refunded"
      : "partially_refunded";
  }
  return p.status;
}

export function toContractPayment(p: Payment): CorePayment {
  return {
    id: p.id,
    tenant_id: p.tenant_id,
    location_id: p.location_id,
    order_id: p.order_id,
    method: railToMethod(p.rail),
    processor: railToProcessor(p.rail),
    status: tenderStatus(p) as CorePayment["status"],
    currency: p.currency,
    amount_cents: p.amount_cents,
    tip_cents: p.tip_cents,
    refunded_cents: p.refunded_cents,
    application_fee_cents: p.application_fee_cents,
    cash_tendered_cents: p.cash_tendered_cents,
    cash_change_cents: p.cash_change_cents,
    processor_ref: p.charge_id ?? p.crypto_tx_hash ?? null,
    staff_id: null,
    simulated: p.simulated,
    external_ids: {},
    created_at: ts(p.created_at),
    updated_at: ts(p.updated_at),
  };
}

/** Payment axis derived from the tenders (the POS status loses it after `paid`). */
export function derivePaymentStatus(
  order: Order,
  payments: Payment[],
): { payment_status: CoreOrder["payment_status"]; amount_due_cents: number } {
  const live = payments.filter(
    (p) => p.status === "captured" || p.status === "refunded",
  );
  const captured = live.reduce((s, p) => s + p.amount_cents, 0);
  const capturedWithTips = live.reduce(
    (s, p) => s + p.amount_cents + p.tip_cents,
    0,
  );
  const refunded = payments.reduce((s, p) => s + p.refunded_cents, 0);
  const total = order.totals.total_cents;
  const due = Math.max(0, total - captured);

  let status: CoreOrder["payment_status"];
  if (refunded > 0 && refunded >= capturedWithTips && capturedWithTips > 0) {
    status = "refunded";
  } else if (refunded > 0) {
    status = "partially_refunded";
  } else if (total === 0 || captured >= total) {
    status = "paid";
  } else if (captured > 0) {
    status = "partially_paid";
  } else {
    status = "unpaid";
  }
  // POS `refunded` / `paid` statuses are authoritative when payments are not loaded.
  const hint = fromPosOrderStatus(order.status).payment_status;
  if (payments.length === 0 && hint) status = hint;
  return { payment_status: status, amount_due_cents: due };
}

function contractChannel(order: Order): string {
  const explicit = order.source?.channel;
  if (explicit) return explicit;
  return fromPosChannel(order.channel).channel;
}

function sourceOf(order: Order): CoreOrder["source"] {
  const s = order.source;
  if (s) {
    return {
      type: s.type,
      module: s.module ?? "pos",
      agent_client_id: s.agent_client_id ?? null,
      external_ref: s.external_ref ?? null,
      offline_synced: s.offline_synced ?? false,
      device_id: s.device_id ?? null,
    };
  }
  return {
    type: order.channel === "in_store" ? "pos_terminal" : "web",
    module: "pos",
    agent_client_id: null,
    external_ref: null,
    offline_synced: false,
    device_id: null,
  };
}

function toContractLines(order: Order): CoreOrderLine[] {
  const live = order.items.filter((i) => !i.voided);
  const discounts = allocate(
    Math.min(order.totals.discount_cents, order.totals.subtotal_cents),
    live.map((i) => i.line_total_cents),
  );
  let li = 0;
  return order.items.map((i: OrderItem) => {
    const discount = i.voided ? 0 : (discounts[li++] ?? 0);
    return {
      id: i.id,
      line_type: "item",
      item_id: i.item_id,
      item_name: i.item_name,
      station: i.station ?? null,
      size_id: i.size_id,
      size_name: i.size_name,
      quantity: Math.max(1, i.quantity),
      base_price_cents: i.base_price_cents,
      modifiers: i.modifiers.map((m) => ({
        group_id: m.group_id,
        group_name: m.group_name,
        role: inferModifierRole(m.group_name),
        modifier_id: m.modifier_id,
        modifier_name: m.modifier_name,
        placement: m.placement,
        price_cents: m.price_cents,
      })),
      unit_price_cents: i.unit_price_cents,
      line_total_cents: i.voided ? 0 : i.line_total_cents,
      discount_cents: discount,
      net_cents: (i.voided ? 0 : i.line_total_cents) - discount,
      tax_exempt: false,
      notes: i.notes,
      voided: i.voided,
    } as CoreOrderLine;
  });
}

export function toContractOrder(input: {
  order: Order;
  payments: Payment[];
  timezone: string;
  customer?: Customer | null;
}): CoreOrder {
  const { order, payments, timezone, customer } = input;
  const axes = fromPosOrderStatus(order.status);
  const pay = derivePaymentStatus(order, payments);
  const f = order.fulfillment;
  const isDraft = order.status === "draft";
  const deliveryFee = f?.delivery_fee_cents ?? 0;

  const addr = f?.address;
  const fulfillment: CoreOrder["fulfillment"] = {
    type: f?.type ?? fromPosChannel(order.channel).fulfillment_type,
    scheduled_for:
      f && f.scheduled_for !== "asap" ? ts(f.scheduled_for) : null,
    promised_at: f?.promised_at ? ts(f.promised_at) : null,
    address: addr
      ? {
          line1: addr.line1,
          line2: addr.line2 ?? null,
          city: addr.city,
          region: addr.region || null,
          postal_code: addr.postal_code || null,
          country: /^[A-Z]{2}$/.test(addr.country) ? addr.country : "US",
        }
      : null,
    zone_id: f?.zone_id ?? null,
    delivery_notes: f?.delivery_notes ?? null,
  };

  const contact = {
    name: f?.contact?.name ?? customer?.name ?? null,
    email: cleanEmail(customer?.email),
    phone: cleanPhone(f?.contact?.phone ?? customer?.phone),
  };

  const t = order.totals;
  const canceled = order.status === "voided";
  const created = ts(order.created_at);
  const updated = ts(order.updated_at);

  return {
    id: order.id,
    tenant_id: order.tenant_id,
    location_id: order.location_id,
    order_number: order.order_number,
    version: Math.max(1, order.version ?? 1),
    channel: contractChannel(order),
    source: sourceOf(order),
    fulfillment_status: axes.fulfillment_status,
    payment_status: pay.payment_status,
    hold: isDraft
      ? {
          reason: order.hold?.reason ?? "manual",
          expires_at: order.hold?.expires_at ?? null,
        }
      : null,
    fire_at: null,
    currency: order.currency,
    lines: toContractLines(order),
    adjustments:
      t.discount_cents > 0
        ? [
            {
              id: "adj_discount",
              type: "discount",
              source: "pos.manual",
              label: "Discount",
              amount_cents: t.discount_cents,
            },
          ]
        : [],
    totals: {
      subtotal_cents: t.subtotal_cents,
      discount_cents: t.discount_cents,
      service_fee_cents: 0,
      delivery_fee_cents: deliveryFee,
      taxable_cents: t.taxable_cents,
      tax_cents: t.tax_cents,
      tip_cents: t.tip_cents,
      total_cents: t.total_cents,
    },
    tenders: payments.map((p) => ({
      payment_id: p.id,
      method: railToMethod(p.rail),
      processor: railToProcessor(p.rail),
      status: tenderStatus(p),
      amount_cents: p.amount_cents,
      tip_cents: p.tip_cents,
      refunded_cents: p.refunded_cents,
    })),
    amount_due_cents: pay.amount_due_cents,
    fulfillment,
    customer_id: order.customer_id ?? null,
    contact,
    staff_id: order.staff_id ?? null,
    notes: order.notes,
    quote_id: null,
    tax_exempt: false,
    business_date: businessDate(order.created_at, timezone),
    metadata: {},
    external_ids: {},
    created_at: created,
    updated_at: updated,
    placed_at: isDraft ? null : created,
    completed_at: order.status === "completed" ? updated : null,
    canceled_at: canceled ? updated : null,
    cancel_reason: null,
  } as CoreOrder;
}

// ---------------------------------------------------------------------------
// Customers, staff, drawer sessions, deliveries
// ---------------------------------------------------------------------------

export function toContractCustomer(
  c: Customer,
  stats: { order_count: number; last_order_at: string | null; lifetime_spend_cents: number },
): CoreCustomer {
  const noConsent = { opt_in: false, at: null, source: null };
  const name = c.name?.trim() || null;
  const [first, ...rest] = (name ?? "").split(/\s+/);
  return {
    id: c.id,
    tenant_id: c.tenant_id,
    email: cleanEmail(c.email),
    phone: cleanPhone(c.phone),
    name,
    first_name: first || null,
    last_name: rest.length ? rest.join(" ") : null,
    verified: c.verified,
    marketing: { email: noConsent, sms: noConsent },
    stats: {
      order_count: stats.order_count,
      last_order_at: stats.last_order_at ? ts(stats.last_order_at) : null,
      lifetime_spend_cents: stats.lifetime_spend_cents,
    },
    tags: [],
    external_ids: {},
    created_at: ts(c.created_at),
    updated_at: ts(c.updated_at),
  };
}

export function toContractStaff(s: Staff, hasPin: boolean): CoreStaffMember {
  return {
    id: s.id,
    tenant_id: s.tenant_id,
    name: s.name,
    role: s.role,
    roles: [s.role],
    active: s.active,
    user_id: s.user_id ?? null,
    location_ids: s.location_ids ?? [],
    has_pin: hasPin,
    external_ids: {},
    created_at: ts(s.created_at),
    updated_at: ts(s.created_at),
  };
}

export function toContractDrawerSession(input: {
  shift: Shift;
  recon: DrawerReconciliation;
  currency: string;
  timezone: string;
}): CoreDrawerSession {
  const { shift, recon } = input;
  return {
    id: shift.id,
    tenant_id: shift.tenant_id,
    location_id: shift.location_id,
    staff_id: shift.staff_id,
    status: shift.status,
    currency: input.currency,
    opened_at: ts(shift.opened_at),
    closed_at: shift.closed_at ? ts(shift.closed_at) : null,
    opening_float_cents: shift.opening_float_cents,
    cash_sales_cents: Math.max(0, recon.cash_sales_cents),
    paid_in_cents: Math.max(0, recon.paid_in_cents),
    payouts_cents: Math.max(0, recon.payouts_cents),
    expected_cents: recon.expected_cents,
    counted_cents: recon.counted_cents,
    over_short_cents: recon.over_short_cents,
    close_note: shift.close_note,
    business_date: businessDate(shift.opened_at, input.timezone),
  };
}

export function toContractDelivery(input: {
  record: DeliveryRecord;
  order: Order | null;
  payments: Payment[];
  location: CoreLocation;
}): CoreDelivery {
  const { record, order, location } = input;
  const d = record.dropoff;
  const pay = order
    ? derivePaymentStatus(order, input.payments)
    : { amount_due_cents: 0 };
  const summary = order
    ? order.items
        .filter((i) => !i.voided)
        .map((i) => `${i.quantity}x ${i.size_name ? `${i.size_name} ` : ""}${i.item_name}`)
        .join(", ")
    : null;
  return {
    id: record.id,
    tenant_id: record.tenant_id,
    location_id: record.location_id,
    order_id: record.order_id,
    provider: record.provider,
    status: record.status,
    currency: record.currency,
    fee_cents: record.fee_cents,
    tip_cents: order?.totals.tip_cents ?? 0,
    amount_due_cents: pay.amount_due_cents,
    eta_minutes: record.eta_minutes,
    promised_at: order?.fulfillment?.promised_at
      ? ts(order.fulfillment.promised_at)
      : null,
    pickup: { address: location.address, geo: location.geo },
    dropoff: {
      address: {
        line1: d.line1,
        line2: d.line2 ?? null,
        city: d.city,
        region: d.region || null,
        postal_code: d.postal_code || null,
        country: /^[A-Z]{2}$/.test(d.country) ? d.country : "US",
      },
      geo: null,
      contact: {
        name: order?.fulfillment?.contact?.name ?? null,
        phone: cleanPhone(order?.fulfillment?.contact?.phone),
      },
      notes: order?.fulfillment?.delivery_notes ?? null,
    },
    driver:
      record.driver_name || record.driver_phone
        ? {
            staff_id: null,
            name: record.driver_name,
            phone: record.driver_phone,
          }
        : null,
    items_summary: summary,
    provider_delivery_id: record.provider_delivery_id,
    tracking_url: record.tracking_ref,
    simulated: record.simulated,
    external_ids: {},
    created_at: ts(record.created_at),
    updated_at: ts(record.updated_at),
  } as CoreDelivery;
}

// ---------------------------------------------------------------------------
// Business-day close -> DailySales
// ---------------------------------------------------------------------------

export function toContractDailySales(
  close: BusinessDayClose,
  currency: string,
): CoreDailySales {
  const r = close.report;
  const net = r.net_cents;
  return {
    tenant_id: close.tenant_id,
    location_id: close.location_id,
    business_date: close.business_date,
    currency,
    order_count: r.order_count,
    units: 0,
    gross_cents: r.gross_cents,
    discount_cents: r.discount_cents,
    net_cents: net,
    tax_cents: r.tax_cents,
    tip_cents: r.tip_cents,
    delivery_fee_cents: 0,
    service_fee_cents: 0,
    refund_cents: r.refund_cents,
    void_count: r.void_count,
    by_channel: r.byChannel.map((b) => ({
      key: b.key,
      label: b.label,
      order_count: b.count,
      units: 0,
      gross_cents: b.gross_cents,
      discount_cents: 0,
      net_cents: b.gross_cents,
      tax_cents: 0,
      tip_cents: 0,
      delivery_fee_cents: 0,
      service_fee_cents: 0,
      refund_cents: 0,
      void_count: 0,
    })),
    payment_mix: r.paymentMix.map((m) => ({
      method: railToMethod(m.rail),
      count: m.count,
      amount_cents: m.amount_cents,
      tip_cents: m.tip_cents,
      application_fee_cents: m.application_fee_cents,
    })),
    closed: true,
    closed_at: ts(close.closed_at),
  };
}
