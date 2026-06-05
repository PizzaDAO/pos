/**
 * Receipt model builder (Phase 2) — pure, integer cents.
 *
 * Turns an order + its tenders into a fully-itemized receipt: line items with
 * modifiers (incl. half-and-half placement), discount, tax, tip, platform fee,
 * each tender, and change due. Used by the on-screen receipt and the
 * print/email/SMS stubs.
 */
import type { Order, OrderItem, Payment } from "@/lib/db";
import { PAYMENT_RAIL_LABELS } from "./registry";

export interface ReceiptLine {
  name: string;
  /** Modifier summary incl. half placement, e.g. "Mushrooms (L), Onions (R)". */
  modifiers: string;
  quantity: number;
  lineTotalCents: number;
  notes: string | null;
}

export interface ReceiptTender {
  rail: string;
  label: string;
  amountCents: number;
  tipCents: number;
  status: string;
  changeCents: number | null;
  simulated: boolean;
}

export interface Receipt {
  orderNumber: string;
  currency: string;
  lines: ReceiptLine[];
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  tipCents: number;
  /** Total platform application fee across card tenders. */
  applicationFeeCents: number;
  totalCents: number;
  tenders: ReceiptTender[];
  totalTenderedCents: number;
  totalChangeCents: number;
  balanceCents: number;
  paid: boolean;
}

function placementSuffix(placement: OrderItem["modifiers"][number]["placement"]): string {
  if (placement === "left") return " (L)";
  if (placement === "right") return " (R)";
  return "";
}

function summarizeModifiers(item: OrderItem): string {
  return item.modifiers
    .map((m) => `${m.modifier_name}${placementSuffix(m.placement)}`)
    .join(", ");
}

export function buildReceipt(order: Order, payments: Payment[]): Receipt {
  const lines: ReceiptLine[] = order.items
    .filter((i) => !i.voided)
    .map((i) => ({
      name: i.size_name ? `${i.item_name} · ${i.size_name}` : i.item_name,
      modifiers: summarizeModifiers(i),
      quantity: i.quantity,
      lineTotalCents: i.line_total_cents,
      notes: i.notes,
    }));

  const tipCents = payments.reduce((sum, p) => sum + p.tip_cents, 0);
  const applicationFeeCents = payments.reduce(
    (sum, p) => sum + p.application_fee_cents,
    0,
  );
  const coveredCents = payments
    .filter((p) => p.status !== "failed" && p.status !== "canceled")
    .reduce((sum, p) => sum + p.amount_cents, 0);

  const tenders: ReceiptTender[] = payments.map((p) => ({
    rail: p.rail,
    label: PAYMENT_RAIL_LABELS[p.rail],
    amountCents: p.amount_cents + p.tip_cents,
    tipCents: p.tip_cents,
    status: p.status,
    changeCents: p.cash_change_cents,
    simulated: p.simulated,
  }));

  const totalTenderedCents = payments.reduce(
    (sum, p) => sum + (p.cash_tendered_cents ?? p.amount_cents + p.tip_cents),
    0,
  );
  const totalChangeCents = payments.reduce(
    (sum, p) => sum + (p.cash_change_cents ?? 0),
    0,
  );

  // Order total excludes tip (tip is added at payment time); show tip separately.
  const grandTotalCents = order.totals.total_cents + tipCents;
  const balanceCents = Math.max(0, order.totals.total_cents - coveredCents);

  return {
    orderNumber: order.order_number,
    currency: order.currency,
    lines,
    subtotalCents: order.totals.subtotal_cents,
    discountCents: order.totals.discount_cents,
    taxCents: order.totals.tax_cents,
    tipCents,
    applicationFeeCents,
    totalCents: grandTotalCents,
    tenders,
    totalTenderedCents,
    totalChangeCents,
    balanceCents,
    paid: balanceCents === 0 && order.status === "paid",
  };
}
