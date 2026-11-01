/**
 * Sales rollups in the contract shape (`SalesSummary`, `DailySales`), computed
 * from contract orders (already mapped) so figures match what consumers can
 * recompute from `/v1/orders`.
 *
 * Voided orders count only toward `void_count`. Held (unpaid, unreleased)
 * orders are excluded. Refunds come from tender `refunded_cents`.
 *
 * Online checkouts that were never paid (`awaiting_payment`, `abandoned`) are
 * not sales at all, not even voids: callers drop them from the POS rows BEFORE
 * mapping with {@link isSalesRow}, the same rule as main's reports
 * (src/lib/reports.ts). (After mapping, `abandoned` would look like a void.)
 */
import type {
  DailySales,
  HourlySales,
  ItemSales,
  Order,
  SalesFigures,
  SalesGroupBy,
  SalesSummary,
} from "@openpizza/core";
import { isUnpaidOnlineStatus, type Order as PosOrder } from "@/lib/db/menu-types";

/** Pre-mapping row filter for every sales rollup: no unpaid online checkouts. */
export function isSalesRow(o: Pick<PosOrder, "status">): boolean {
  return !isUnpaidOnlineStatus(o.status);
}

type Bucket = SalesFigures & { key: string; label: string };

export function emptyFigures(): SalesFigures {
  return {
    order_count: 0,
    units: 0,
    gross_cents: 0,
    discount_cents: 0,
    net_cents: 0,
    tax_cents: 0,
    tip_cents: 0,
    delivery_fee_cents: 0,
    service_fee_cents: 0,
    refund_cents: 0,
    void_count: 0,
  };
}

function add(a: SalesFigures, b: Partial<SalesFigures>): void {
  for (const k of Object.keys(b) as (keyof SalesFigures)[]) {
    a[k] += b[k] ?? 0;
  }
}

/** Order-level figures. */
function orderFigures(o: Order): SalesFigures {
  const f = emptyFigures();
  if (o.fulfillment_status === "canceled") {
    f.void_count = 1;
    return f;
  }
  f.order_count = 1;
  f.units = o.lines.filter((l) => !l.voided).reduce((s, l) => s + l.quantity, 0);
  f.gross_cents = o.totals.subtotal_cents;
  f.discount_cents = o.totals.discount_cents;
  f.net_cents = o.totals.subtotal_cents - o.totals.discount_cents;
  f.tax_cents = o.totals.tax_cents;
  f.tip_cents = o.totals.tip_cents;
  f.delivery_fee_cents = o.totals.delivery_fee_cents;
  // Custom fee lines are service-fee revenue: net + tax + tip + delivery + service
  // ties to the order total (and so to the tenders).
  f.service_fee_cents = o.totals.service_fee_cents + (o.totals.fees_cents ?? 0);
  f.refund_cents = o.tenders.reduce((s, t) => s + t.refunded_cents, 0);
  return f;
}

function countable(o: Order): boolean {
  return o.fulfillment_status !== "held";
}

/** Local hour ("00".."23") of an instant in a timezone. */
export function localHour(iso: string, tz: string): string {
  const h = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "2-digit",
    hour12: false,
  })
    .formatToParts(new Date(iso))
    .find((p) => p.type === "hour")?.value;
  return (h === "24" ? "00" : (h ?? "00")).padStart(2, "0");
}

export interface SummaryInput {
  tenant_id: string;
  location_id: string | null;
  from: string;
  to: string;
  group_by: SalesGroupBy;
  currency: string;
  orders: Order[];
  /** location_id -> {name, timezone} (for location/hour grouping). */
  locations: Map<string, { name: string; timezone: string }>;
  /** item_id -> category {id, name} (for category grouping). */
  categories?: Map<string, { id: string; name: string }>;
}

export function buildSalesSummary(input: SummaryInput): SalesSummary {
  const inRange = input.orders.filter(
    (o) =>
      countable(o) && o.business_date >= input.from && o.business_date <= input.to,
  );
  const totals = emptyFigures();
  for (const o of inRange) add(totals, orderFigures(o));

  const buckets = new Map<string, Bucket>();
  const bucket = (key: string, label: string): Bucket => {
    let b = buckets.get(key);
    if (!b) {
      b = { key, label, ...emptyFigures() };
      buckets.set(key, b);
    }
    return b;
  };

  for (const o of inRange) {
    const of = orderFigures(o);
    switch (input.group_by) {
      case "location":
        add(
          bucket(
            o.location_id,
            input.locations.get(o.location_id)?.name ?? o.location_id,
          ),
          of,
        );
        break;
      case "channel":
        add(bucket(o.channel, o.channel), of);
        break;
      case "day":
        add(bucket(o.business_date, o.business_date), of);
        break;
      case "hour": {
        const tz = input.locations.get(o.location_id)?.timezone ?? "UTC";
        const h = localHour(o.created_at, tz);
        add(bucket(h, `${h}:00`), of);
        break;
      }
      case "item":
      case "category":
      case "size": {
        if (o.fulfillment_status === "canceled") break;
        const seen = new Set<string>();
        for (const l of o.lines) {
          if (l.voided) continue;
          let key: string;
          let label: string;
          if (input.group_by === "item") {
            key = l.item_id;
            label = l.item_name;
          } else if (input.group_by === "size") {
            key = l.size_name ?? "none";
            label = l.size_name ?? "No size";
          } else {
            const c = input.categories?.get(l.item_id);
            key = c?.id ?? "uncategorized";
            label = c?.name ?? "Uncategorized";
          }
          const b = bucket(key, label);
          if (!seen.has(key)) {
            b.order_count += 1;
            seen.add(key);
          }
          b.units += l.quantity;
          b.gross_cents += l.line_total_cents;
          b.discount_cents += l.discount_cents;
          b.net_cents += l.net_cents;
        }
        break;
      }
    }
  }

  return {
    tenant_id: input.tenant_id,
    location_id: input.location_id,
    from: input.from,
    to: input.to,
    group_by: input.group_by,
    currency: input.currency,
    totals,
    buckets: [...buckets.values()].sort((a, b) => a.key.localeCompare(b.key)),
  };
}

export function buildDailySales(input: {
  tenant_id: string;
  location_id: string;
  business_date: string;
  currency: string;
  orders: Order[];
  payments: {
    method: string;
    status: string;
    amount_cents: number;
    tip_cents: number;
    application_fee_cents: number;
  }[];
  closedAt: string | null;
}): DailySales {
  const day = input.orders.filter(
    (o) => countable(o) && o.business_date === input.business_date,
  );
  const totals = emptyFigures();
  const channels = new Map<string, Bucket>();
  for (const o of day) {
    const f = orderFigures(o);
    add(totals, f);
    let b = channels.get(o.channel);
    if (!b) {
      b = { key: o.channel, label: o.channel, ...emptyFigures() };
      channels.set(o.channel, b);
    }
    add(b, f);
  }
  const mix = new Map<
    string,
    {
      method: string;
      count: number;
      amount_cents: number;
      tip_cents: number;
      application_fee_cents: number;
    }
  >();
  for (const p of input.payments) {
    if (p.status !== "captured" && p.status !== "refunded") continue;
    const m = mix.get(p.method) ?? {
      method: p.method,
      count: 0,
      amount_cents: 0,
      tip_cents: 0,
      application_fee_cents: 0,
    };
    m.count += 1;
    m.amount_cents += p.amount_cents;
    m.tip_cents += p.tip_cents;
    m.application_fee_cents += p.application_fee_cents;
    mix.set(p.method, m);
  }
  return {
    tenant_id: input.tenant_id,
    location_id: input.location_id,
    business_date: input.business_date,
    currency: input.currency,
    ...totals,
    by_channel: [...channels.values()],
    payment_mix: [...mix.values()],
    closed: input.closedAt !== null,
    closed_at: input.closedAt,
  };
}

// ---------------------------------------------------------------------------
// Hourly + item-level rollups (sales.hourly, sales.items)
// ---------------------------------------------------------------------------

const dtfCache = new Map<string, Intl.DateTimeFormat>();
function dtf(tz: string): Intl.DateTimeFormat {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
    });
    dtfCache.set(tz, f);
  }
  return f;
}

/**
 * Wall-clock date (YYYY-MM-DD) and hour (0..23) of an instant in a zone. Uses the
 * zone's own rules per instant, so a DST day is right: spring-forward has no
 * hour 2 row, fall-back folds both 01:xx hours into one (date, hour) bucket.
 */
export function localDateHour(iso: string, tz: string): { date: string; hour: number } {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = dtf(tz).formatToParts(new Date(iso));
  } catch {
    parts = dtf("UTC").formatToParts(new Date(iso));
  }
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    hour: Number(get("hour")) % 24,
  };
}

/**
 * `sales.hourly`: one row per location-local date x hour that had orders.
 * Caller passes orders already limited to the business-date range (the same
 * set `sales.daily` counts), so the rows of one business_date add up to that
 * day's daily figures. Held and canceled orders are excluded (daily counts a
 * cancel only in void_count). Bucketed by placed_at, else created_at, in the
 * LOCATION's zone.
 */
export interface HourlyOrderInput {
  location_id: string;
  business_date: string;
  fulfillment_status: string;
  placed_at: string | null;
  created_at: string;
  totals: { subtotal_cents: number; discount_cents: number; tip_cents: number };
}

export function buildHourlySales(input: {
  from: string;
  to: string;
  orders: HourlyOrderInput[];
  timezones: Map<string, string>;
}): HourlySales[] {
  const rows = new Map<string, HourlySales>();
  for (const o of input.orders) {
    if (o.fulfillment_status === "held" || o.fulfillment_status === "canceled") continue;
    if (o.business_date < input.from || o.business_date > input.to) continue;
    const tz = input.timezones.get(o.location_id) ?? "UTC";
    const { date, hour } = localDateHour(o.placed_at ?? o.created_at, tz);
    const key = `${o.location_id}|${date}|${hour}|${o.business_date}`;
    let r = rows.get(key);
    if (!r) {
      r = {
        location_id: o.location_id,
        date,
        business_date: o.business_date,
        hour,
        order_count: 0,
        net_cents: 0,
        gross_cents: 0,
        tip_cents: 0,
      };
      rows.set(key, r);
    }
    r.order_count += 1;
    r.gross_cents += o.totals.subtotal_cents;
    r.net_cents += o.totals.subtotal_cents - o.totals.discount_cents;
    r.tip_cents += o.totals.tip_cents;
  }
  return [...rows.values()].sort(
    (a, b) =>
      a.location_id.localeCompare(b.location_id) ||
      a.date.localeCompare(b.date) ||
      a.hour - b.hour ||
      a.business_date.localeCompare(b.business_date),
  );
}

/**
 * `sales.items`: per location x business date x item x size. Voided lines and
 * canceled / held orders are skipped. Names come from the order lines (they
 * survive menu edits); the category falls back to the menu's item -> category map.
 */
export function buildItemSales(input: {
  from: string;
  to: string;
  orders: Order[];
  categoryOfItem?: Map<string, string>;
}): ItemSales[] {
  const rows = new Map<string, ItemSales & { _orders: Set<string> }>();
  for (const o of input.orders) {
    if (!countable(o) || o.fulfillment_status === "canceled") continue;
    if (o.business_date < input.from || o.business_date > input.to) continue;
    for (const l of o.lines) {
      if (l.voided) continue;
      const key = `${o.location_id}|${o.business_date}|${l.item_id}|${l.size_id ?? ""}`;
      let r = rows.get(key);
      if (!r) {
        r = {
          location_id: o.location_id,
          business_date: o.business_date,
          item_id: l.item_id,
          item_name: l.item_name,
          size_id: l.size_id ?? null,
          size_name: l.size_name ?? null,
          category_id: l.category_id ?? input.categoryOfItem?.get(l.item_id) ?? null,
          units: 0,
          order_count: 0,
          gross_cents: 0,
          discount_cents: 0,
          net_cents: 0,
          _orders: new Set(),
        };
        rows.set(key, r);
      }
      r.units += l.quantity;
      r.gross_cents += l.line_total_cents;
      r.discount_cents += l.discount_cents;
      r.net_cents += Math.max(0, l.net_cents);
      r._orders.add(o.id);
    }
  }
  return [...rows.values()]
    .map(({ _orders, ...r }) => ({ ...r, order_count: _orders.size }))
    .sort(
      (a, b) =>
        a.location_id.localeCompare(b.location_id) ||
        a.business_date.localeCompare(b.business_date) ||
        a.item_id.localeCompare(b.item_id) ||
        (a.size_id ?? "").localeCompare(b.size_id ?? ""),
    );
}
