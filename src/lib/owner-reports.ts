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
 *   fees     = order total − tip − tax − (gross − discount), floored at 0
 *              (delivery / custom fee lines; they are part of the tender amount)
 *   refunds  = Σ tender refunded_cents (cash back), split per order, TIP LAST
 *              per tender: tip = Σ max(refunded − amount, 0) capped at the order's
 *              tip (plus any overflow of sales beyond gross − discount); the rest
 *              is split pro-rata across sales, tax and fees (tax and fees capped
 *              at their own amount, sales takes the remainder). Each part comes
 *              off its own column, so a fully refunded order contributes 0 net,
 *              0 tax, 0 fees, 0 tip, and refund_cents = sales + tax + fees + tip
 *              always. See {@link splitRefund}.
 *              TODO(refunds-voids-comps): refunds are dated to the ORIGINAL
 *              order's business day (no refund timestamp exists yet); switch to
 *              the refund row's timestamp when that branch adds it.
 *   net      = gross − discount − refund sales part
 *   tips     = order-level tip, else the tenders' tips (never both), less tip refunds
 *   tenders  = payments in status captured | refunded
 *   stored value (20261113000920): gift card SALE / RELOAD orders
 *              (core_ext.stored_value) are a liability, never a sale: they are
 *              in no column above and only in `stored_value` (sold / refunded,
 *              plus redemptions on sales and the current outstanding liability).
 *              gift_card / store_credit tenders have their own daily columns.
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
  /** Total cash refunded (sales + tax + tip parts). */
  refund_cents: number;
  refund_sales_cents: number;
  refund_tax_cents: number;
  refund_fees_cents: number;
  refund_tip_cents: number;
  /** Delivery / custom fees, net of refunded fees. */
  fees_cents: number;
  /** Net of refunded tax. */
  tax_cents: number;
  /** Net of refunded tips. */
  tip_cents: number;
  void_count: number;
  void_cents: number;
  cash_cents: number;
  card_cents: number;
  crypto_cents: number;
  /** Gift card / store credit tenders (stored value redeemed on sales). */
  gift_card_cents: number;
  store_credit_cents: number;
  other_cents: number;
}

export interface OwnerChannelRow {
  channel: string;
  orders: number;
  gross_cents: number;
  discount_cents: number;
  refund_cents: number;
  refund_sales_cents: number;
  refund_fees_cents: number;
  fees_cents: number;
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
  /** Gift cards / store credit: a liability, kept out of every sales figure. */
  stored_value: OwnerStoredValue;
}

export interface OwnerStoredValue {
  /** Gift card sale + reload orders in range with counted tenders, and that money. */
  sold_count: number;
  sold_cents: number;
  sold_refunded_cents: number;
  /** Redeemed on sales in range, net of value refunded back to the cards. */
  redeemed_gift_card_cents: number;
  redeemed_store_credit_cents: number;
  /** Current outstanding balance on active cards (not range-bound). */
  outstanding_cents: number;
}

export const EMPTY_STORED_VALUE: OwnerStoredValue = {
  sold_count: 0,
  sold_cents: 0,
  sold_refunded_cents: 0,
  redeemed_gift_card_cents: 0,
  redeemed_store_credit_cents: 0,
  outstanding_cents: 0,
};

export interface OwnerSummary {
  orders: number;
  gross_cents: number;
  discount_cents: number;
  /** Comps are folded into discounts until the comps ledger lands. */
  comp_cents: number;
  /** Total cash refunded. */
  refund_cents: number;
  refund_sales_cents: number;
  refund_tax_cents: number;
  refund_fees_cents: number;
  refund_tip_cents: number;
  fees_cents: number;
  net_cents: number;
  tax_cents: number;
  tip_cents: number;
  void_count: number;
  void_cents: number;
  cash_cents: number;
  card_cents: number;
  crypto_cents: number;
  gift_card_cents: number;
  store_credit_cents: number;
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
  stored_value: EMPTY_STORED_VALUE,
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

/**
 * Canonical IANA zone for storage, or null when `tz` is not an "Area/City" zone
 * (or UTC). Abbreviations such as "EST" are rejected: they do not follow DST.
 */
export function canonicalTimezone(tz: string): string | null {
  const t = tz.trim();
  if (t.toUpperCase() === "UTC") return "UTC";
  if (!/^[A-Za-z]+(\/[A-Za-z0-9_+-]+)+$/.test(t)) return null;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: t }).resolvedOptions().timeZone;
  } catch {
    return null;
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

type TenderFamily = "cash" | "card" | "crypto" | "gift_card" | "store_credit" | "other";

function tenderFamily(p: Pick<Payment, "rail" | "method">): TenderFamily {
  if (p.rail === "external") {
    return p.method === "cash" || p.method === "card" || p.method === "crypto" ? p.method : "other";
  }
  if (p.rail === "cash") return "cash";
  if (p.rail === "stripe_terminal" || p.rail === "stripe_online") return "card";
  if (String(p.rail).startsWith("crypto")) return "crypto";
  if (p.rail === "gift_card" || p.rail === "store_credit") return p.rail;
  return "other";
}

/** Tender key: the rail, or `external:<method>:<processor>` (same as SQL). */
export function tenderKey(p: Pick<Payment, "rail" | "method" | "processor">): string {
  if (p.rail !== "external") return p.rail;
  const clean = (v: string | null | undefined) => (v ?? "").replace(/[:\s]/g, "_");
  return `external:${clean(p.method) || "other"}:${clean(p.processor)}`;
}

/**
 * Split an order's refunds, tip last per tender (mirrors the SQL). `tenders` are the order's
 * counted tenders; `sales` = gross − discount, `tax`, `fees` the order's amounts
 * and `tip` the tip counted for it. Invariant: total = tip + tax + fees + sales.
 */
export function splitRefund(
  tenders: Pick<Payment, "amount_cents" | "tip_cents" | "refunded_cents">[],
  amounts: { sales: number; tax: number; fees: number },
  tip: number,
): { total: number; tip: number; tax: number; fees: number; sales: number } {
  const total = tenders.reduce((s, p) => s + p.refunded_cents, 0);
  // Tip last, PER TENDER: only the part beyond a tender's own non-tip amount is tip.
  const tipRaw = tenders.reduce((s, p) => s + Math.max(p.refunded_cents - p.amount_cents, 0), 0);
  const refTip = Math.min(tipRaw, tip);
  const rest = total - refTip;
  const base = Math.max(amounts.sales, 0) + amounts.tax + amounts.fees;
  const share = (v: number) => (base > 0 ? Math.min(v, Math.round((rest * v) / base)) : 0);
  const refTax = share(amounts.tax);
  const refFees = share(amounts.fees);
  // Refunded sales never exceed what was sold; any overflow is tip.
  const sales = Math.min(rest - refTax - refFees, Math.max(amounts.sales, 0));
  const overflow = rest - refTax - refFees - sales;
  return { total, tip: refTip + overflow, tax: refTax, fees: refFees, sales };
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
  /** Current outstanding stored-value balance (the SQL reads the accounts). */
  storedValueOutstandingCents?: number;
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
  const sv: OwnerStoredValue = {
    ...EMPTY_STORED_VALUE,
    outstanding_cents: input.storedValueOutstandingCents ?? 0,
  };

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
    if (o.core_ext?.stored_value) {
      // A liability, never a sale (no day row, staff row, channel or tender line).
      if (!isSale) continue;
      const counted = (paysByOrder.get(o.id) ?? []).filter((p) => COUNTED_TENDER.has(p.status));
      if (counted.length > 0) sv.sold_count += 1;
      for (const p of counted) {
        sv.sold_cents += p.amount_cents;
        sv.sold_refunded_cents += Math.min(p.refunded_cents, p.amount_cents + p.tip_cents);
      }
      continue;
    }

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
        refund_sales_cents: 0,
        refund_tax_cents: 0,
        refund_fees_cents: 0,
        refund_tip_cents: 0,
        fees_cents: 0,
        tax_cents: 0,
        tip_cents: 0,
        void_count: 0,
        void_cents: 0,
        cash_cents: 0,
        card_cents: 0,
        crypto_cents: 0,
        gift_card_cents: 0,
        store_credit_cents: 0,
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
    const orderTip = cents(o.totals?.tip_cents);
    const tip = orderTip > 0 ? orderTip : counted.reduce((s, p) => s + p.tip_cents, 0);
    const tax = cents(o.totals?.tax_cents);
    const fees = Math.max(0, cents(o.totals?.total_cents) - cents(o.totals?.tip_cents) - tax - (gross - discount));
    const ref = splitRefund(counted, { sales: gross - discount, tax, fees }, tip);
    const refunded = ref.total;

    d.orders += 1;
    d.gross_cents += gross;
    d.discount_cents += discount;
    d.refund_cents += refunded;
    d.refund_sales_cents += ref.sales;
    d.refund_tax_cents += ref.tax;
    d.refund_fees_cents += ref.fees;
    d.fees_cents += fees - ref.fees;
    d.refund_tip_cents += ref.tip;
    d.tax_cents += tax - ref.tax;
    d.tip_cents += tip - ref.tip;
    for (const p of counted) {
      d[`${tenderFamily(p)}_cents`] += p.amount_cents;
      // Net of value returned to the card (a refund of that tender).
      const kept = p.amount_cents - Math.min(p.refunded_cents, p.amount_cents);
      if (p.rail === "gift_card") sv.redeemed_gift_card_cents += kept;
      if (p.rail === "store_credit") sv.redeemed_store_credit_cents += kept;
      const tk = tenderKey(p);
      const t = tenders.get(tk) ?? { key: tk, count: 0, amount_cents: 0, tip_cents: 0, refunded_cents: 0 };
      t.count += 1;
      t.amount_cents += p.amount_cents;
      t.tip_cents += p.tip_cents;
      t.refunded_cents += p.refunded_cents;
      tenders.set(tk, t);
    }

    const ch = reportChannel(o);
    const c =
      channels.get(ch) ??
      { channel: ch, orders: 0, gross_cents: 0, discount_cents: 0, refund_cents: 0, refund_sales_cents: 0, refund_fees_cents: 0, fees_cents: 0 };
    c.orders += 1;
    c.gross_cents += gross;
    c.discount_cents += discount;
    c.refund_cents += refunded;
    c.refund_sales_cents += ref.sales;
    c.refund_fees_cents += ref.fees;
    c.fees_cents += fees - ref.fees;
    channels.set(ch, c);

    const hk = `${when.dow}|${when.hour}`;
    const h = hourly.get(hk) ?? { dow: when.dow, hour: when.hour, orders: 0, sales_cents: 0 };
    h.orders += 1;
    h.sales_cents += gross - discount;
    hourly.set(hk, h);

    st.orders += 1;
    st.sales_cents += gross - discount - ref.sales;
    st.tip_cents += tip - ref.tip;
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
    stored_value: sv,
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
    refund_sales_cents: 0,
    refund_tax_cents: 0,
    refund_fees_cents: 0,
    refund_tip_cents: 0,
    fees_cents: 0,
    net_cents: 0,
    tax_cents: 0,
    tip_cents: 0,
    void_count: 0,
    void_cents: 0,
    cash_cents: 0,
    card_cents: 0,
    crypto_cents: 0,
    gift_card_cents: 0,
    store_credit_cents: 0,
    other_cents: 0,
    avg_ticket_cents: 0,
  };
  for (const d of daily) {
    s.orders += d.orders;
    s.gross_cents += d.gross_cents;
    s.discount_cents += d.discount_cents;
    s.refund_cents += d.refund_cents;
    s.refund_sales_cents += d.refund_sales_cents;
    s.refund_tax_cents += d.refund_tax_cents;
    s.refund_fees_cents += d.refund_fees_cents;
    s.refund_tip_cents += d.refund_tip_cents;
    s.fees_cents += d.fees_cents;
    s.tax_cents += d.tax_cents;
    s.tip_cents += d.tip_cents;
    s.void_count += d.void_count;
    s.void_cents += d.void_cents;
    s.cash_cents += d.cash_cents;
    s.card_cents += d.card_cents;
    s.crypto_cents += d.crypto_cents;
    s.gift_card_cents += d.gift_card_cents ?? 0;
    s.store_credit_cents += d.store_credit_cents ?? 0;
    s.other_cents += d.other_cents;
  }
  s.net_cents = s.gross_cents - s.discount_cents - s.refund_sales_cents;
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

/** Printed under every CSV that carries refunds. */
export const REFUND_NOTE =
  "# Refunds are dated to the original order's business day (refund timestamps are not recorded yet). A refund comes off sales, tax and fees pro-rata and off tips only beyond the non-tip amount; net_sales = gross - discounts - refunded sales.";

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
  const csv = bundleToCsvBody(kind, b, tenderLabel);
  return kind === "hourly" || kind === "items" || kind === "categories" ? csv : `${csv}${REFUND_NOTE}\r\n`;
}

function bundleToCsvBody(kind: OwnerReportKind, b: OwnerReportBundle, tenderLabel: (key: string) => string): string {
  switch (kind) {
    case "summary":
    case "accountant": {
      // Accountant export: one row per location per business day.
      return toCsv(
        [
          "business_date", "location", "orders", "gross_sales", "discounts", "refunds_total", "net_sales", "tax_net_of_refunds",
          "fees_net_of_refunds", "tips_net_of_refunds", "voids", "void_amount", "cash", "card", "crypto", "gift_card",
          "store_credit", "other_tenders",
        ],
        b.daily.map((d) => [
          d.business_date, d.location_name, d.orders, dollars(d.gross_cents), dollars(d.discount_cents),
          dollars(d.refund_cents), dollars(d.gross_cents - d.discount_cents - d.refund_sales_cents), dollars(d.tax_cents),
          dollars(d.fees_cents), dollars(d.tip_cents), d.void_count, dollars(d.void_cents), dollars(d.cash_cents), dollars(d.card_cents),
          dollars(d.crypto_cents), dollars(d.gift_card_cents ?? 0), dollars(d.store_credit_cents ?? 0),
          dollars(d.other_cents),
        ]),
      );
    }
    case "channels":
      return toCsv(
        ["channel", "orders", "gross_sales", "discounts", "refunds", "net_sales"],
        b.channels.map((c) => [
          CHANNEL_LABELS[c.channel] ?? c.channel, c.orders, dollars(c.gross_cents), dollars(c.discount_cents),
          dollars(c.refund_cents), dollars(c.gross_cents - c.discount_cents - c.refund_sales_cents),
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
