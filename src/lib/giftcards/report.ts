/**
 * Stored-value lines of the sales report / Z-report. Pure and client-safe.
 *
 * Gift card SALES are a liability, not revenue: their orders are kept out of
 * gross, net, tax, the order count and the payment mix, and summarized here as
 * money taken for cards (by tender family, so the drawer still reconciles).
 * REDEMPTIONS are how a normal, taxed order was paid: those orders stay in the
 * sales figures and their gift card / store credit tenders show in the payment
 * mix (family "other"); here they are totalled as liability released.
 * Store credit ISSUED has no order: the reports route adds it from the ledger.
 */
import type { Order, Payment } from "@/lib/db";
import type { StoredValueReport } from "@/lib/db/backoffice-types";
import type { LedgerEntry } from "./types";

export function isStoredValueOrder(order: Pick<Order, "core_ext">): boolean {
  return !!order.core_ext?.stored_value;
}

export function isStoredValueRail(rail: string): boolean {
  return rail === "gift_card" || rail === "store_credit";
}

function settled(p: Payment): boolean {
  return p.status === "captured" || p.status === "authorized" || p.status === "refunded";
}

type Family = "cash" | "card" | "crypto" | "other";

/**
 * Summarize stored value over the in-range orders and their tenders.
 * `familyOf` maps a tender to cash/card/crypto/other (reports.railFamily).
 */
export function buildStoredValueReport(
  orders: readonly Order[],
  payments: readonly Payment[],
  familyOf: (p: Payment) => Family,
): StoredValueReport {
  const byId = new Map(orders.map((o) => [o.id, o]));
  const out: StoredValueReport = {
    sold_count: 0,
    sold_cents: 0,
    sold_refunded_cents: 0,
    sold_by_family: { cash: 0, card: 0, crypto: 0, other: 0 },
    redeemed_count: 0,
    redeemed_gift_card_cents: 0,
    redeemed_store_credit_cents: 0,
    returned_to_card_cents: 0,
  };
  const soldOrders = new Set<string>();
  for (const p of payments) {
    const order = byId.get(p.order_id);
    if (!order || !settled(p)) continue;
    if (isStoredValueOrder(order)) {
      soldOrders.add(order.id);
      out.sold_cents += p.amount_cents;
      out.sold_refunded_cents += Math.min(p.refunded_cents, p.amount_cents + p.tip_cents);
      out.sold_by_family[familyOf(p)] += p.amount_cents;
    } else if (isStoredValueRail(p.rail)) {
      out.redeemed_count += 1;
      if (p.rail === "gift_card") out.redeemed_gift_card_cents += p.amount_cents;
      else out.redeemed_store_credit_cents += p.amount_cents;
      out.returned_to_card_cents += p.refunded_cents;
    }
  }
  out.sold_count = soldOrders.size;
  return out;
}

/** Store credit issued / voided in a ledger slice (the reports route adds it). */
export function storeCreditIssued(
  entries: readonly LedgerEntry[],
  storeCreditAccountIds: ReadonlySet<string>,
  locationId: string | null,
): { issued_count: number; issued_cents: number } {
  let issued_count = 0;
  let issued_cents = 0;
  for (const e of entries) {
    if (!storeCreditAccountIds.has(e.account_id) || e.kind !== "issue") continue;
    if (locationId && e.location_id && e.location_id !== locationId) continue;
    issued_count += 1;
    issued_cents += e.amount_cents;
  }
  return { issued_count, issued_cents };
}
