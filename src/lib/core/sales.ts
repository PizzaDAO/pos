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
  f.service_fee_cents = o.totals.service_fee_cents;
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
