/**
 * Owner reports: pure aggregation, comparison and CSV helpers.
 *
 * The Supabase driver gets the same {@link OwnerReportBundle} straight from the
 * SQL function `report_sales_bundle` (supabase/migrations/20261113000600): this
 * module's {@link buildOwnerBundle} is its twin over in-memory orders for the
 * mock driver and the unit tests, so the two must keep the same definitions:
 *
 *   sale     = order status not in draft / awaiting_payment / abandoned / voided
 *   gross    = Σ unit_price × quantity of non-voided lines
 *   discount = order totals.discount_cents
 *   refunds  = Σ tender refunded_cents
 *   net      = gross − discount − refunds
 *   tips     = order-level tip, else the tenders' tips (never both)
 *   tenders  = payments in status captured | refunded
 *
 * Time: every order is bucketed in ITS OWN location's timezone, and the business
 * day starts `business_day_cutoff_minutes` after local midnight (so 01:30 on a
 * 04:00 cutoff belongs to the previous day). All money is integer cents.
 */
import type { Location, Order, Payment, Staff } from "@/lib/db";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ReportChannel =
  | "terminal"
  | "online"
  | "delivery"
  | "kiosk"
  | "catering"
  | "marketplace"
  | "phone"
  | "agent";

export interface OwnerDailyRow {
  location_id: string;
  location_name: string;
  business_date: string;
  orders: number;
  gross_cents: number;
  discount_cents: number;
  refund_cents: number;
  tax_cents: number;
  tip_cents: number;
  void_count: number;
  void_cents: number;
  cash_cents: number;
  card_cents: number;
  crypto_cents: number;
  other_cents: number;
}

export interface OwnerChannelRow {
  channel: string;
  orders: number;
  gross_cents: number;
  discount_cents: number;
  refund_cents: number;
}

export interface OwnerTenderRow {
  key: string;
  count: number;
  amount_cents: number;
  tip_cents: number;
  refunded_cents: number;
}

export interface OwnerHourCell {
  /** 0 = Sunday … 6 = Saturday, of the BUSINESS day. */
  dow: number;
  /** Local clock hour 0-23. */
  hour: number;
  orders: number;
  sales_cents: number;
}

export interface OwnerItemRow {
  item_id: string;
  name: string;
  category: string | null;
  qty: number;
  revenue_cents: number;
}

export interface OwnerCategoryRow {
  key: string;
  name: string;
  qty: number;
  revenue_cents: number;
}

export interface OwnerStaffRow {
  staff_id: string | null;
  name: string;
  orders: number;
  sales_cents: number;
  tip_cents: number;
  refund_cents: number;
  /** Voided orders + voided lines. */
  void_count: number;
}

/** What `report_sales_bundle` returns for one range. */
export interface OwnerReportBundle {
  daily: OwnerDailyRow[];
  channels: OwnerChannelRow[];
  tenders: OwnerTenderRow[];
  hourly: OwnerHourCell[];
  items: OwnerItemRow[];
  categories: OwnerCategoryRow[];
  /** Σ revenue over ALL items (the denominator for "% of sales"). */
  item_total_cents: number;
  staff: OwnerStaffRow[];
}

export interface OwnerSummary {
  orders: number;
  gross_cents: number;
  discount_cents: number;
  /** Comps are folded into discounts until the comps ledger lands. */
  comp_cents: number;
  refund_cents: number;
  net_cents: number;
  tax_cents: number;
  tip_cents: number;
  void_count: number;
  void_cents: number;
  cash_cents: number;
  card_cents: number;
  crypto_cents: number;
  other_cents: number;
  avg_ticket_cents: number;
}

export const EMPTY_BUNDLE: OwnerReportBundle = {
  daily: [],
  channels: [],
  tenders: [],
  hourly: [],
  items: [],
  categories: [],
  item_total_cents: 0,
  staff: [],
};

// ---------------------------------------------------------------------------
// Dates and timezones
// ---------------------------------------------------------------------------

/** Longest range a report may cover (keeps the SQL and the payload bounded). */
export const MAX_RANGE_DAYS = 366;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** True for a real calendar date "yyyy-mm-dd". */
export function isValidDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** True for an IANA zone this runtime knows. */
export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Inclusive day count of a range. */
export function rangeDays(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}

/** The equally long range immediately before `from..to`. */
export function previousRange(from: string, to: string): { from: string; to: string } {
  const days = rangeDays(from, to);
  const prevTo = addDays(from, -1);
  return { from: addDays(prevTo, -(days - 1)), to: prevTo };
}

/** Validate a requested range; returns an error message or null. */
export function rangeError(from: string | null, to: string | null): string | null {
  if (!from || !to) return "from and to (yyyy-mm-dd) are required.";
  if (!isValidDate(from) || !isValidDate(to)) return "from and to must be valid yyyy-mm-dd dates.";
  if (from > to) return "from must not be after to.";
  if (rangeDays(from, to) > MAX_RANGE_DAYS) return `Range is limited to ${MAX_RANGE_DAYS} days.`;
  return null;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  const key = isValidTimezone(tz) ? tz : "UTC";
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: key,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    formatters.set(key, f);
  }
  return f;
}

/** Local wall clock of an instant in a timezone (DST-correct via Intl). */
export function localClock(iso: string, tz: string): { y: number; mo: number; d: number; h: number; mi: number } {
  const parts: Record<string, string> = {};
  for (const p of formatter(tz).formatToParts(new Date(iso))) parts[p.type] = p.value;
  return {
    y: Number(parts.year),
    mo: Number(parts.month),
    d: Number(parts.day),
    h: Number(parts.hour) % 24,
    mi: Number(parts.minute),
  };
}

/**
 * The business date ("yyyy-mm-dd") and the clock hour an instant falls on at a
 * location. The cutoff is subtracted from the LOCAL wall clock, exactly like the
 * SQL (`created_at at time zone tz - cutoff`), so DST days stay consistent.
 */
export function businessDay(
  iso: string,
  tz: string,
  cutoffMinutes: number,
): { date: string; dow: number; hour: number } {
  const c = localClock(iso, tz);
  const wall = Date.UTC(c.y, c.mo - 1, c.d, c.h, c.mi) - cutoffMinutes * 60_000;
  const bd = new Date(wall);
  return { date: bd.toISOString().slice(0, 10), dow: bd.getUTCDay(), hour: c.h };
}

// ---------------------------------------------------------------------------
// Aggregation (mock driver + tests; Supabase does this in SQL)
// ---------------------------------------------------------------------------

const NON_SALE = new Set(["draft", "awaiting_payment", "abandoned", "voided"]);
const COUNTED_TENDER = new Set(["captured", "refunded"]);
const SOURCE_CHANNELS = new Set(["kiosk", "catering", "marketplace", "phone", "agent"]);

/** Report channel of an order (see the module header). */
export function reportChannel(order: Pick<Order, "channel" | "source">): ReportChannel {
  const sc = order.source?.channel;
  if (sc && SOURCE_CHANNELS.has(sc)) return sc as ReportChannel;
  if (order.channel === "online_delivery") return "delivery";
  if (order.channel === "online_pickup") return "online";
  return "terminal";
}

export const CHANNEL_LABELS: Record<string, string> = {
  terminal: "Terminal (in-store)",
  online: "Online pickup",
  delivery: "Delivery",
  kiosk: "Kiosk",
  catering: "Catering",
  marketplace: "Marketplace",
  phone: "Phone",
  agent: "Agent / API",
};

/** Tolerant number read: anything that is not a finite number counts as 0. */
function cents(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.round(v) : 0;
}

type TenderFamily = "cash" | "card" | "crypto" | "other";

function tenderFamily(p: Pick<Payment, "rail" | "method">): TenderFamily {
  if (p.rail === "external") {
    return p.method === "cash" || p.method === "card" || p.method === "crypto" ? p.method : "other";
  }
  if (p.rail === "cash") return "cash";
  if (p.rail === "stripe_terminal" || p.rail === "stripe_online") return "card";
  if (String(p.rail).startsWith("crypto")) return "crypto";
  return "other";
}

/** Tender key: the rail, or `external:<method>:<processor>` (same as SQL). */
export function tenderKey(p: Pick<Payment, "rail" | "method" | "processor">): string {
  if (p.rail !== "external") return p.rail;
  const clean = (v: string | null | undefined) => (v ?? "").replace(/[:\s]/g, "_");
  return `external:${clean(p.method) || "other"}:${clean(p.processor)}`;
}

export interface BuildBundleInput {
  tenantId: string;
  /** null = every location of the tenant. */
  locationId: string | null;
  from: string;
  to: string;
  topN?: number;
  orders: Order[];
  payments: Payment[];
  locations: Location[];
  staff: Pick<Staff, "id" | "name">[];
  categoryOf: (itemId: string) => { id: string; name: string } | null;
}

/** Hard cap on item rows (matches the SQL). */
export const MAX_TOP_N = 200;

export function buildOwnerBundle(input: BuildBundleInput): OwnerReportBundle {
  const topN = Math.min(Math.max(input.topN ?? 50, 1), MAX_TOP_N);
  const locById = new Map(input.locations.map((l) => [l.id, l]));
  const staffName = new Map(input.staff.map((s) => [s.id, s.name]));
  const paysByOrder = new Map<string, Payment[]>();
  for (const p of input.payments) {
    const list = paysByOrder.get(p.order_id) ?? [];
    list.push(p);
    paysByOrder.set(p.order_id, list);
  }

  const daily = new Map<string, OwnerDailyRow>();
  const channels = new Map<string, OwnerChannelRow>();
  const tenders = new Map<string, OwnerTenderRow>();
  const hourly = new Map<string, OwnerHourCell>();
  const items = new Map<string, OwnerItemRow>();
  const cats = new Map<string, OwnerCategoryRow>();
  const staff = new Map<string, OwnerStaffRow>();
  let itemTotal = 0;

  for (const o of input.orders) {
    if (o.tenant_id !== input.tenantId) continue;
    if (input.locationId && o.location_id !== input.locationId) continue;
    const loc = locById.get(o.location_id);
    if (!loc) continue;
    const isVoid = o.status === "voided";
    const isSale = !NON_SALE.has(o.status);
    if (!isSale && !isVoid) continue;
    const when = businessDay(o.created_at, loc.timezone, loc.business_day_cutoff_minutes ?? 0);
    if (when.date < input.from || when.date > input.to) continue;

    const key = `${o.location_id}|${when.date}`;
    const d =
      daily.get(key) ??
      ({
        location_id: o.location_id,
        location_name: loc.name,
        business_date: when.date,
        orders: 0,
        gross_cents: 0,
        discount_cents: 0,
        refund_cents: 0,
        tax_cents: 0,
        tip_cents: 0,
        void_count: 0,
        void_cents: 0,
        cash_cents: 0,
        card_cents: 0,
        crypto_cents: 0,
        other_cents: 0,
      } satisfies OwnerDailyRow);
    daily.set(key, d);

    const sKey = o.staff_id ?? "";
    const st =
      staff.get(sKey) ??
      ({
        staff_id: o.staff_id ?? null,
        name: o.staff_id ? (staffName.get(o.staff_id) ?? "Unattributed") : "Unattributed",
        orders: 0,
        sales_cents: 0,
        tip_cents: 0,
        refund_cents: 0,
        void_count: 0,
      } satisfies OwnerStaffRow);
    staff.set(sKey, st);

    if (isVoid) {
      d.void_count += 1;
      d.void_cents += cents(o.totals?.total_cents);
      st.void_count += 1;
      continue;
    }

    const live = o.items.filter((i) => !i.voided);
    const gross = live.reduce((s, i) => s + i.unit_price_cents * i.quantity, 0);
    const discount = cents(o.totals?.discount_cents);
    const counted = (paysByOrder.get(o.id) ?? []).filter((p) => COUNTED_TENDER.has(p.status));
    const refunded = counted.reduce((s, p) => s + p.refunded_cents, 0);
    const orderTip = cents(o.totals?.tip_cents);
    const tip = orderTip > 0 ? orderTip : counted.reduce((s, p) => s + p.tip_cents, 0);

    d.orders += 1;
    d.gross_cents += gross;
    d.discount_cents += discount;
    d.refund_cents += refunded;
    d.tax_cents += cents(o.totals?.tax_cents);
    d.tip_cents += tip;
    for (const p of counted) {
      d[`${tenderFamily(p)}_cents`] += p.amount_cents;
      const tk = tenderKey(p);
      const t = tenders.get(tk) ?? { key: tk, count: 0, amount_cents: 0, tip_cents: 0, refunded_cents: 0 };
      t.count += 1;
      t.amount_cents += p.amount_cents;
      t.tip_cents += p.tip_cents;
      t.refunded_cents += p.refunded_cents;
      tenders.set(tk, t);
    }

    const ch = reportChannel(o);
    const c = channels.get(ch) ?? { channel: ch, orders: 0, gross_cents: 0, discount_cents: 0, refund_cents: 0 };
    c.orders += 1;
    c.gross_cents += gross;
    c.discount_cents += discount;
    c.refund_cents += refunded;
    channels.set(ch, c);

    const hk = `${when.dow}|${when.hour}`;
    const h = hourly.get(hk) ?? { dow: when.dow, hour: when.hour, orders: 0, sales_cents: 0 };
    h.orders += 1;
    h.sales_cents += gross - discount;
    hourly.set(hk, h);

    st.orders += 1;
    st.sales_cents += gross - discount;
    st.tip_cents += tip;
    st.refund_cents += refunded;
    st.void_count += o.items.length - live.length;

    for (const line of live) {
      const rev = line.unit_price_cents * line.quantity;
      itemTotal += rev;
      const cat = input.categoryOf(line.item_id);
      const it =
        items.get(line.item_id) ??
        ({ item_id: line.item_id, name: line.item_name, category: cat?.name ?? null, qty: 0, revenue_cents: 0 } satisfies OwnerItemRow);
      it.qty += line.quantity;
      it.revenue_cents += rev;
      items.set(line.item_id, it);
      const ck = cat?.id ?? "uncategorized";
      const ct = cats.get(ck) ?? { key: ck, name: cat?.name ?? "Uncategorized", qty: 0, revenue_cents: 0 };
      ct.qty += line.quantity;
      ct.revenue_cents += rev;
      cats.set(ck, ct);
    }
  }

  return {
    daily: [...daily.values()].sort(
      (a, b) => a.business_date.localeCompare(b.business_date) || a.location_name.localeCompare(b.location_name),
    ),
    channels: [...channels.values()].sort((a, b) => b.gross_cents - a.gross_cents),
    tenders: [...tenders.values()].sort((a, b) => b.amount_cents - a.amount_cents),
    hourly: [...hourly.values()].sort((a, b) => a.dow - b.dow || a.hour - b.hour),
    items: [...items.values()]
      .sort((a, b) => b.revenue_cents - a.revenue_cents || a.name.localeCompare(b.name))
      .slice(0, topN),
    categories: [...cats.values()].sort((a, b) => b.revenue_cents - a.revenue_cents).slice(0, 200),
    item_total_cents: itemTotal,
    staff: [...staff.values()].sort((a, b) => b.sales_cents - a.sales_cents).slice(0, 200),
  };
}

// ---------------------------------------------------------------------------
// Summary + comparison
// ---------------------------------------------------------------------------

export function summarize(daily: OwnerDailyRow[]): OwnerSummary {
  const s: OwnerSummary = {
    orders: 0,
    gross_cents: 0,
    discount_cents: 0,
    comp_cents: 0,
    refund_cents: 0,
    net_cents: 0,
    tax_cents: 0,
    tip_cents: 0,
    void_count: 0,
    void_cents: 0,
    cash_cents: 0,
    card_cents: 0,
    crypto_cents: 0,
    other_cents: 0,
    avg_ticket_cents: 0,
  };
  for (const d of daily) {
    s.orders += d.orders;
    s.gross_cents += d.gross_cents;
    s.discount_cents += d.discount_cents;
    s.refund_cents += d.refund_cents;
    s.tax_cents += d.tax_cents;
    s.tip_cents += d.tip_cents;
    s.void_count += d.void_count;
    s.void_cents += d.void_cents;
    s.cash_cents += d.cash_cents;
    s.card_cents += d.card_cents;
    s.crypto_cents += d.crypto_cents;
    s.other_cents += d.other_cents;
  }
  s.net_cents = s.gross_cents - s.discount_cents - s.refund_cents;
  s.avg_ticket_cents = s.orders > 0 ? Math.round(s.net_cents / s.orders) : 0;
  return s;
}

export interface Delta {
  current: number;
  previous: number;
  diff: number;
  /** Fractional change vs previous (0.1 = +10%); null when previous is 0. */
  pct: number | null;
}

export function delta(current: number, previous: number): Delta {
  return {
    current,
    previous,
    diff: current - previous,
    pct: previous === 0 ? null : (current - previous) / Math.abs(previous),
  };
}

const COMPARED: (keyof OwnerSummary)[] = [
  "orders",
  "gross_cents",
  "discount_cents",
  "refund_cents",
  "net_cents",
  "tax_cents",
  "tip_cents",
  "avg_ticket_cents",
];

export function compareSummaries(cur: OwnerSummary, prev: OwnerSummary): Record<string, Delta> {
  const out: Record<string, Delta> = {};
  for (const k of COMPARED) out[k] = delta(cur[k], prev[k]);
  return out;
}

/** 7 x 24 matrix of sales cents (rows = Sun..Sat) plus the max cell. */
export function heatmapGrid(hourly: OwnerHourCell[]): { orders: number[][]; sales: number[][]; max: number } {
  const orders = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
  const sales = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
  let max = 0;
  for (const h of hourly) {
    if (h.dow < 0 || h.dow > 6 || h.hour < 0 || h.hour > 23) continue;
    orders[h.dow]![h.hour] = h.orders;
    sales[h.dow]![h.hour] = h.sales_cents;
    max = Math.max(max, h.sales_cents);
  }
  return { orders, sales, max };
}

/** Share of `part` in `total` as a 0-100 number with one decimal. */
export function pctOf(part: number, total: number): number {
  return total > 0 ? Math.round((part / total) * 1000) / 10 : 0;
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/**
 * One CSV cell. Quotes when needed, and neutralises spreadsheet formula
 * injection (a name like `=HYPERLINK(...)` becomes text) for string cells.
 */
export function csvCell(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return "";
  let s = typeof v === "number" ? String(v) : v;
  if (typeof v === "string" && /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header: string[], rows: (string | number | null | undefined)[][]): string {
  return [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

const dollars = (c: number): string => (c / 100).toFixed(2);
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export type OwnerReportKind =
  | "summary"
  | "channels"
  | "tenders"
  | "hourly"
  | "items"
  | "categories"
  | "staff"
  | "accountant";

export const REPORT_KINDS: OwnerReportKind[] = [
  "summary",
  "channels",
  "tenders",
  "hourly",
  "items",
  "categories",
  "staff",
  "accountant",
];

/** CSV text for one report. Money columns are dollars with two decimals. */
export function bundleToCsv(kind: OwnerReportKind, b: OwnerReportBundle, tenderLabel: (key: string) => string): string {
  switch (kind) {
    case "summary":
    case "accountant": {
      // Accountant export: one row per location per business day.
      return toCsv(
        [
          "business_date", "location", "orders", "gross_sales", "discounts", "refunds", "net_sales", "tax",
          "tips", "voids", "void_amount", "cash", "card", "crypto", "other_tenders",
        ],
        b.daily.map((d) => [
          d.business_date, d.location_name, d.orders, dollars(d.gross_cents), dollars(d.discount_cents),
          dollars(d.refund_cents), dollars(d.gross_cents - d.discount_cents - d.refund_cents), dollars(d.tax_cents),
          dollars(d.tip_cents), d.void_count, dollars(d.void_cents), dollars(d.cash_cents), dollars(d.card_cents),
          dollars(d.crypto_cents), dollars(d.other_cents),
        ]),
      );
    }
    case "channels":
      return toCsv(
        ["channel", "orders", "gross_sales", "discounts", "refunds", "net_sales"],
        b.channels.map((c) => [
          CHANNEL_LABELS[c.channel] ?? c.channel, c.orders, dollars(c.gross_cents), dollars(c.discount_cents),
          dollars(c.refund_cents), dollars(c.gross_cents - c.discount_cents - c.refund_cents),
        ]),
      );
    case "tenders":
      return toCsv(
        ["tender", "payments", "amount", "tips", "refunded"],
        b.tenders.map((t) => [tenderLabel(t.key), t.count, dollars(t.amount_cents), dollars(t.tip_cents), dollars(t.refunded_cents)]),
      );
    case "hourly":
      return toCsv(
        ["weekday", "hour", "orders", "net_sales_before_refunds"],
        b.hourly.map((h) => [DOW[h.dow] ?? h.dow, h.hour, h.orders, dollars(h.sales_cents)]),
      );
    case "items":
      return toCsv(
        ["item", "category", "quantity", "revenue", "percent_of_sales"],
        b.items.map((i) => [i.name, i.category, i.qty, dollars(i.revenue_cents), pctOf(i.revenue_cents, b.item_total_cents)]),
      );
    case "categories":
      return toCsv(
        ["category", "quantity", "revenue", "percent_of_sales"],
        b.categories.map((c) => [c.name, c.qty, dollars(c.revenue_cents), pctOf(c.revenue_cents, b.item_total_cents)]),
      );
    case "staff":
      return toCsv(
        ["staff", "orders", "sales", "tips", "refunds", "voids"],
        b.staff.map((s) => [s.name, s.orders, dollars(s.sales_cents), dollars(s.tip_cents), dollars(s.refund_cents), s.void_count]),
      );
  }
}
