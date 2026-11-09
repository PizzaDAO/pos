/**
 * Receipt model builder (Phase 2) — pure, integer cents.
 *
 * Turns an order + its tenders into a fully-itemized receipt: line items with
 * modifiers (incl. half-and-half placement), discount, tax, tip, platform fee,
 * each tender, and change due. Used by the on-screen receipt and the
 * print/email/SMS stubs.
 */
import type { Order, OrderItem, Payment } from "@/lib/db";
import { tenderRailLabel } from "./registry";
import {
  coveringBaseCents,
  isFullyRefunded,
  liveTenders,
  tipRefundedCents,
} from "./refund-state";
import { currentAdjustments, foodDueCents } from "@/lib/adjustments/math";

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
  /** Card-present details (truncated card data + EMV fields) for reader tenders. */
  card: ReceiptCard | null;
}

/** The EMV fields a card receipt must print (Stripe: terminal/features/receipts). */
export interface ReceiptCard {
  /** e.g. "Visa •••• 4242". */
  summary: string;
  entryMethod: string | null;
  applicationName: string | null;
  /** Dedicated file name (AID). */
  aid: string | null;
  accountType: string | null;
  authCode: string | null;
}

const BRAND_NAMES: Record<string, string> = {
  visa: "Visa",
  mastercard: "Mastercard",
  amex: "Amex",
  discover: "Discover",
  diners: "Diners Club",
  jcb: "JCB",
  unionpay: "UnionPay",
};

const ENTRY_METHODS: Record<string, string> = {
  contact_emv: "Chip",
  contactless_emv: "Tap",
  magnetic_stripe_track2: "Swipe",
  magnetic_stripe_fallback: "Swipe",
  contactless_magstripe_mode: "Tap",
};

function str(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

/** Card details from a reader tender's `raw.card_receipt`, or null (cash, crypto, unsettled). */
export function cardReceiptOf(p: Payment): ReceiptCard | null {
  const c = p.raw?.card_receipt;
  if (!c || typeof c !== "object") return null;
  const r = c as Record<string, unknown>;
  const brandKey = str(r.brand)?.toLowerCase() ?? null;
  const brand = brandKey ? (BRAND_NAMES[brandKey] ?? brandKey) : "Card";
  const last4 = str(r.last4);
  const method = str(r.read_method);
  return {
    summary: last4 ? `${brand} •••• ${last4}` : brand,
    entryMethod: method ? (ENTRY_METHODS[method] ?? method.replace(/_/g, " ")) : null,
    applicationName: str(r.application_preferred_name),
    aid: str(r.dedicated_file_name),
    accountType: str(r.account_type),
    authCode: str(r.authorization_code),
  };
}

export interface Receipt {
  orderNumber: string;
  currency: string;
  lines: ReceiptLine[];
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  /** Custom fee lines on the order (catering service fee, ...), shown as their own rows. */
  fees: { label: string; amountCents: number }[];
  feesCents: number;
  tipCents: number;
  /** Total platform application fee across card tenders. */
  applicationFeeCents: number;
  totalCents: number;
  tenders: ReceiptTender[];
  totalTenderedCents: number;
  totalChangeCents: number;
  balanceCents: number;
  paid: boolean;
  /** Total refunded back across tenders (tip included in each tender's amount). */
  refundedCents: number;
  /** The gratuity part of `refundedCents` (tip refunds are shown separately). */
  tipRefundedCents: number;
  /** Money kept after refunds (tendered amounts incl. tips, minus refunds). */
  netPaidCents: number;
  /** Comps + discounts applied (Σ = discountCents). */
  adjustments: { label: string; type: "comp" | "discount"; amountCents: number }[];
  /** Every refund, oldest first, with the tender it went back to. */
  refunds: { tenderLabel: string; amountCents: number; tipCents: number; at: string; reason: string | null }[];
  /** Every non-failed tender has been refunded (the order is closed out). */
  fullyRefunded: boolean;
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
  // Same rule as the payments service (refund-state.ts coveringBaseCents): a
  // refund after the order was paid in full never re-opens the balance.
  const coveredCents = coveringBaseCents(payments, foodDueCents(order));

  const tenders: ReceiptTender[] = payments.map((p) => ({
    rail: p.rail,
    label: tenderRailLabel(p.rail),
    amountCents: p.amount_cents + p.tip_cents,
    tipCents: p.tip_cents,
    status: p.status,
    changeCents: p.cash_change_cents,
    simulated: p.simulated,
    card: cardReceiptOf(p),
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
  // Food due (an online order's own tip rides on the tender, not the base).
  const balanceCents = Math.max(0, foodDueCents(order) - coveredCents);

  const live = liveTenders(payments);
  const refundedCents = live.reduce((sum, p) => sum + p.refunded_cents, 0);
  const tipRefunded = live.reduce((sum, p) => sum + tipRefundedCents(p), 0);
  const fullyRefunded = isFullyRefunded(order, payments);
  const keptCents = live
    .filter((p) => p.status === "captured" || p.status === "authorized" || p.status === "refunded")
    .reduce((sum, p) => sum + p.amount_cents + p.tip_cents, 0);
  const refunds = live
    .flatMap((p) =>
      (p.refunds ?? []).map((r) => ({
        tenderLabel: tenderRailLabel(p.rail),
        amountCents: r.amount_cents,
        tipCents: typeof r.tip_cents === "number" ? r.tip_cents : 0,
        at: r.at,
        reason: r.reason,
      })),
    )
    .sort((a, b) => a.at.localeCompare(b.at));

  return {
    refundedCents,
    tipRefundedCents: tipRefunded,
    netPaidCents: Math.max(0, keptCents - refundedCents),
    adjustments: currentAdjustments(order).map((a) => ({
      label: a.label,
      type: a.type,
      amountCents: a.amount_cents,
    })),
    refunds,
    fullyRefunded,
    orderNumber: order.order_number,
    currency: order.currency,
    lines,
    subtotalCents: order.totals.subtotal_cents,
    discountCents: order.totals.discount_cents,
    taxCents: order.totals.tax_cents,
    fees: (order.core_ext?.fees ?? []).map((f) => ({
      label: f.label,
      amountCents: f.amount_cents,
    })),
    feesCents: order.totals.fees_cents ?? 0,
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
