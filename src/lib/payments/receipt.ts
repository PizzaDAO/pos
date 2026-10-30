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
