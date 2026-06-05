/**
 * Pure reporting helpers (Phase 5).
 *
 * Derive a {@link SalesReport} from a set of orders + their payment tenders.
 * Kept side-effect-free + DB-agnostic: the mock driver passes in the orders it
 * holds; a future Supabase driver can run the same math over rows it fetches.
 * All money is integer cents.
 */
import type { Order, OrderChannel, Payment } from "@/lib/db";
import type {
  DateRange,
  PaymentMixSlice,
  SalesBucket,
  SalesReport,
} from "@/lib/db/backoffice-types";

/** Human label for an order channel. */
export function channelLabel(channel: OrderChannel): string {
  switch (channel) {
    case "in_store":
      return "In-store";
    case "online_pickup":
      return "Online pickup";
    case "online_delivery":
      return "Online delivery";
    default:
      return channel;
  }
}

/** Human label for a payment rail (incl. cash). */
export function railLabel(rail: string): string {
  switch (rail) {
    case "cash":
      return "Cash";
    case "stripe_terminal":
      return "Card (terminal)";
    case "stripe_online":
      return "Card (online)";
    case "crypto_onchain_usdc":
      return "Crypto (onchain USDC)";
    case "crypto_coinbase":
      return "Crypto (Coinbase)";
    default:
      return rail;
  }
}

/** Coarse payment family for the cash/card/crypto mix. */
export function railFamily(rail: string): "cash" | "card" | "crypto" {
  if (rail === "cash") return "cash";
  if (rail.startsWith("crypto")) return "crypto";
  return "card";
}

/** ISO timestamp → "yyyy-mm-dd" (UTC; the mock seed uses UTC timestamps). */
export function isoDate(iso: string): string {
  return iso.slice(0, 10);
}

/** Whether an order's created date falls within an inclusive date range. */
export function inRange(order: Order, range: DateRange): boolean {
  const day = isoDate(order.created_at);
  if (range.from && day < range.from) return false;
  if (range.to && day > range.to) return false;
  return true;
}

/** Gross (non-voided line totals) for an order. */
export function orderGrossCents(order: Order): number {
  return order.items
    .filter((i) => !i.voided)
    .reduce((sum, i) => sum + i.unit_price_cents * i.quantity, 0);
}

function pushBucket(
  map: Map<string, SalesBucket>,
  key: string,
  label: string,
  gross: number,
  count: number,
): void {
  const existing = map.get(key);
  if (existing) {
    existing.gross_cents += gross;
    existing.count += count;
  } else {
    map.set(key, { key, label, gross_cents: gross, count });
  }
}

function sortBuckets(map: Map<string, SalesBucket>): SalesBucket[] {
  return [...map.values()].sort((a, b) => b.gross_cents - a.gross_cents);
}

export interface BuildReportInput {
  tenantId: string;
  /** null → tenant rollup across locations. */
  locationId: string | null;
  range: DateRange;
  orders: Order[];
  /** All payment tenders for the orders above (any subset is fine). */
  payments: Payment[];
  /** Resolve a menu item id → category id+name (for the byCategory slice). */
  categoryOf: (itemId: string) => { id: string; name: string } | null;
  /** Resolve a location id → display name (for the byLocation slice). */
  locationName: (locationId: string) => string;
}

/**
 * Build a full sales report from orders + payments. Voided/refunded orders are
 * excluded from the sales slices but counted in the void/refund tallies. The
 * payment mix sums tenders that aren't failed/canceled.
 */
export function buildSalesReport(input: BuildReportInput): SalesReport {
  const { orders, payments, range } = input;

  const byDay = new Map<string, SalesBucket>();
  const byItem = new Map<string, SalesBucket>();
  const byCategory = new Map<string, SalesBucket>();
  const byChannel = new Map<string, SalesBucket>();
  const byLocation = new Map<string, SalesBucket>();

  let orderCount = 0;
  let grossCents = 0;
  let discountCents = 0;
  let taxCents = 0;
  let tipCents = 0;
  let voidCount = 0;
  let voidCents = 0;
  let refundCount = 0;
  let refundCents = 0;

  for (const order of orders) {
    if (!inRange(order, range)) continue;

    if (order.status === "voided") {
      voidCount += 1;
      voidCents += order.totals.total_cents;
      continue;
    }
    if (order.status === "refunded") {
      refundCount += 1;
      refundCents += order.totals.total_cents;
      // refunded orders still represent rung sales; keep them in the tallies
      // below so the period gross matches the register, but they're flagged.
    }

    const gross = orderGrossCents(order);
    orderCount += 1;
    grossCents += gross;
    discountCents += order.totals.discount_cents;
    taxCents += order.totals.tax_cents;
    tipCents += order.totals.tip_cents;

    pushBucket(byDay, isoDate(order.created_at), isoDate(order.created_at), gross, 1);
    pushBucket(
      byChannel,
      order.channel,
      channelLabel(order.channel),
      gross,
      1,
    );
    pushBucket(
      byLocation,
      order.location_id,
      input.locationName(order.location_id),
      gross,
      1,
    );

    for (const line of order.items) {
      if (line.voided) continue;
      const lineGross = line.unit_price_cents * line.quantity;
      pushBucket(byItem, line.item_id, line.item_name, lineGross, line.quantity);
      const cat = input.categoryOf(line.item_id);
      if (cat) {
        pushBucket(byCategory, cat.id, cat.name, lineGross, line.quantity);
      } else {
        pushBucket(byCategory, "uncategorized", "Uncategorized", lineGross, line.quantity);
      }
    }
  }

  // Payment mix — over tenders for the in-range orders only.
  const orderIds = new Set(
    orders.filter((o) => inRange(o, range)).map((o) => o.id),
  );
  // Map order id → its order-level tip, to avoid double-counting tips that were
  // already folded into the order total (online orders) vs. tips recorded on the
  // tender (in-store, where the order-level tip is 0).
  const orderLevelTip = new Map<string, number>();
  for (const o of orders) {
    if (inRange(o, range)) orderLevelTip.set(o.id, o.totals.tip_cents);
  }
  const mixMap = new Map<string, PaymentMixSlice>();
  let feesCents = 0;
  let tenderTipCents = 0;
  for (const p of payments) {
    if (!orderIds.has(p.order_id)) continue;
    if (p.status === "failed" || p.status === "canceled") continue;
    feesCents += p.application_fee_cents;
    // Only count a tender's tip toward the headline total when the order itself
    // didn't already carry a tip (prevents double-counting online tips).
    if ((orderLevelTip.get(p.order_id) ?? 0) === 0) {
      tenderTipCents += p.tip_cents;
    }
    const slice = mixMap.get(p.rail) ?? {
      rail: p.rail,
      label: railLabel(p.rail),
      count: 0,
      amount_cents: 0,
      tip_cents: 0,
      application_fee_cents: 0,
    };
    slice.count += 1;
    slice.amount_cents += p.amount_cents;
    slice.tip_cents += p.tip_cents;
    slice.application_fee_cents += p.application_fee_cents;
    mixMap.set(p.rail, slice);
  }

  const netCents = grossCents - discountCents;

  return {
    tenant_id: input.tenantId,
    location_id: input.locationId,
    range,
    order_count: orderCount,
    gross_cents: grossCents,
    discount_cents: discountCents,
    net_cents: netCents,
    tax_cents: taxCents,
    // Order-level tips (online) + tender tips on orders without one (in-store).
    tip_cents: tipCents + tenderTipCents,
    fees_cents: feesCents,
    void_count: voidCount,
    void_cents: voidCents,
    refund_count: refundCount,
    refund_cents: refundCents,
    byDay: [...byDay.values()].sort((a, b) => a.key.localeCompare(b.key)),
    byItem: sortBuckets(byItem),
    byCategory: sortBuckets(byCategory),
    byChannel: sortBuckets(byChannel),
    byLocation: sortBuckets(byLocation),
    paymentMix: [...mixMap.values()].sort(
      (a, b) => b.amount_cents - a.amount_cents,
    ),
  };
}
