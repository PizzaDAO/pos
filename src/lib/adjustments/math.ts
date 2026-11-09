/**
 * Pure money math for refunds, voids and comps (integer cents, no I/O; safe in
 * client bundles so the till can preview exactly what the server will do).
 *
 *  - `unitShares`: what each UNIT of each line is worth out of the order's
 *    amount due (discounts, fees and tax spread by largest remainder), so
 *    refunding every unit of every line returns exactly the amount due, never a
 *    cent more.
 *  - `planRefundAllocation`: which tender returns how much, base and tip kept
 *    apart (tip refunds are separate and flagged).
 *  - `recomputeOrder`: totals after voids / comps / discounts.
 */
import type { Order, OrderItem, OrderTotals, Payment } from "@/lib/db";
import type {
  AdjustmentRecord,
  OrderAdjustment,
} from "@/lib/db/adjustment-types";
import { computeOrderTotals, roundHalfUp } from "@/lib/pricing";
import { refundableParts } from "@/lib/payments/refund-state";

/**
 * Split `total` across `weights` by largest remainder (ties to the earlier
 * index): the parts always sum to `total`. Zero weights everywhere = even split.
 */
export function allocateCents(total: number, weights: number[]): number[] {
  if (weights.length === 0) return [];
  const ws = weights.map((w) => (Number.isFinite(w) && w > 0 ? w : 0));
  let sum = ws.reduce((a, b) => a + b, 0);
  const use = sum === 0 ? ws.map(() => 1) : ws;
  if (sum === 0) sum = use.length;
  const raw = use.map((w) => (total * w) / sum);
  const floors = raw.map((r) => Math.floor(r));
  let left = total - floors.reduce((a, b) => a + b, 0);
  const order = raw
    .map((r, i) => ({ i, rem: r - Math.floor(r) }))
    .sort((a, b) => b.rem - a.rem || a.i - b.i);
  for (let k = 0; left > 0; k = (k + 1) % order.length) {
    const i = order[k]!.i;
    floors[i] = floors[i]! + 1;
    left -= 1;
  }
  return floors;
}

/** Food amount due on an order (total minus any ORDER-level tip). */
export function foodDueCents(order: Pick<Order, "totals">): number {
  return Math.max(0, order.totals.total_cents - (order.totals.tip_cents ?? 0));
}

/** Comp money currently applied to each line. */
export function compsByLine(adjustments: readonly OrderAdjustment[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const a of adjustments) {
    if (a.type !== "comp" || !a.line_ids?.length) continue;
    const parts = allocateCents(a.amount_cents, a.line_ids.map(() => 1));
    a.line_ids.forEach((id, i) => out.set(id, (out.get(id) ?? 0) + parts[i]!));
  }
  return out;
}

/**
 * Per-unit share of the order's amount due, for every live line: the due is
 * spread across lines by their net (line total minus comps on that line), then
 * evenly across the line's units. Σ over every unit == foodDueCents(order).
 */
export function unitShares(order: Order): Map<string, number[]> {
  const live = order.items.filter((i) => !i.voided);
  const comps = compsByLine(order.adjustments ?? []);
  const weights = live.map((i) =>
    Math.max(0, i.unit_price_cents * i.quantity - (comps.get(i.id) ?? 0)),
  );
  const perLine = allocateCents(foodDueCents(order), weights);
  const out = new Map<string, number[]>();
  live.forEach((line, idx) => {
    out.set(
      line.id,
      allocateCents(perLine[idx]!, new Array(Math.max(1, line.quantity)).fill(1)),
    );
  });
  return out;
}

/** Units of each line already refunded (failed refunds give their units back). */
export function refundedQuantities(records: readonly AdjustmentRecord[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of records) {
    if (r.kind !== "refund" || r.status === "failed") continue;
    for (const l of r.lines) out.set(l.line_id, (out.get(l.line_id) ?? 0) + l.quantity);
  }
  return out;
}

export class AdjustmentInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdjustmentInputError";
  }
}

/**
 * Money for refunding `quantity` more units of each selected line. Units already
 * refunded are taken first in unit order, so a line refunded in two halves sums
 * to exactly what refunding it at once would. Throws on an unknown/voided line
 * or more units than are left.
 */
export function lineRefundAmounts(
  order: Order,
  selections: readonly { line_id: string; quantity: number }[],
  alreadyRefunded: Map<string, number>,
): { line_id: string; quantity: number; amount_cents: number }[] {
  const shares = unitShares(order);
  const seen = new Set<string>();
  return selections.map((sel) => {
    if (seen.has(sel.line_id)) throw new AdjustmentInputError("A line is listed twice.");
    seen.add(sel.line_id);
    const units = shares.get(sel.line_id);
    if (!units) throw new AdjustmentInputError("That item is not on the order (or was voided).");
    if (!Number.isSafeInteger(sel.quantity) || sel.quantity <= 0) {
      throw new AdjustmentInputError("Quantity must be a positive whole number.");
    }
    const done = alreadyRefunded.get(sel.line_id) ?? 0;
    if (done + sel.quantity > units.length) {
      throw new AdjustmentInputError(
        `Only ${Math.max(0, units.length - done)} of that item can still be refunded.`,
      );
    }
    const amount = units.slice(done, done + sel.quantity).reduce((a, b) => a + b, 0);
    return { line_id: sel.line_id, quantity: sel.quantity, amount_cents: amount };
  });
}

/** Refund preference: card first (money goes straight back), then cash, then crypto. */
function railRank(rail: Payment["rail"]): number {
  if (rail === "stripe_terminal" || rail === "stripe_online") return 0;
  if (rail === "cash") return 1;
  return 2;
}

export interface PlannedRefund {
  payment: Payment;
  baseCents: number;
  tipCents: number;
}

/**
 * Spread a refund over the order's tenders. Base money comes off tenders' base,
 * tip money off tenders' tip, each capped at what is left on that tender (so the
 * order can never be refunded past what was captured). `onlyPaymentId` limits
 * it to one tender; `preferPaymentId` tries that one first. External tenders
 * (money taken outside POS) cannot be refunded here and are skipped. Returns
 * null when the tenders cannot cover it.
 */
export function planRefundAllocation(
  payments: readonly Payment[],
  baseCents: number,
  tipCents: number,
  opts: { onlyPaymentId?: string | null; preferPaymentId?: string | null } = {},
): PlannedRefund[] | null {
  const candidates = payments
    .filter((p) => p.rail !== "external")
    .filter((p) => !opts.onlyPaymentId || p.id === opts.onlyPaymentId)
    .map((p) => ({ p, left: refundableParts(p) }))
    .filter(({ left }) => left.baseCents > 0 || left.tipCents > 0)
    .sort(
      (a, b) =>
        Number(b.p.id === opts.preferPaymentId) - Number(a.p.id === opts.preferPaymentId) ||
        railRank(a.p.rail) - railRank(b.p.rail) ||
        b.p.created_at.localeCompare(a.p.created_at) ||
        a.p.id.localeCompare(b.p.id),
    );
  let base = baseCents;
  let tip = tipCents;
  const out: PlannedRefund[] = [];
  for (const { p, left } of candidates) {
    const b = Math.min(base, left.baseCents);
    const t = Math.min(tip, left.tipCents);
    if (b + t === 0) continue;
    out.push({ payment: p, baseCents: b, tipCents: t });
    base -= b;
    tip -= t;
    if (base === 0 && tip === 0) break;
  }
  return base === 0 && tip === 0 ? out : null;
}

/** Most that can still be refunded on the order (base and tip). */
export function refundableTotals(payments: readonly Payment[]): {
  baseCents: number;
  tipCents: number;
} {
  let baseCents = 0;
  let tipCents = 0;
  for (const p of payments) {
    if (p.rail === "external") continue;
    const left = refundableParts(p);
    baseCents += left.baseCents;
    tipCents += left.tipCents;
  }
  return { baseCents, tipCents };
}

// ---------------------------------------------------------------------------
// Voids, comps and discounts (before payment): new lines + totals
// ---------------------------------------------------------------------------

export interface VoidSelection {
  line_id: string;
  /** Units to void; the whole line when omitted or >= its quantity. */
  quantity?: number;
}

export interface PlannedVoid {
  items: OrderItem[];
  voidLineIds: string[];
  splits: { line_id: string; new_line_id: string; keep_quantity: number; void_quantity: number }[];
  /** List price of the voided units (unit price x units). */
  voidedCents: number;
  /** Whether any voided unit had already been sent to the kitchen. */
  fired: boolean;
}

/**
 * Void whole lines or some units of a line. A partial void keeps the line with
 * fewer units and adds a voided copy (`newLineId()`) carrying the voided units,
 * so the kitchen and the audit trail see exactly what was taken off.
 */
export function planLineVoid(
  order: Order,
  selections: readonly VoidSelection[],
  newLineId: () => string,
): PlannedVoid {
  const byId = new Map(order.items.map((i) => [i.id, i]));
  const items = order.items.map((i) => ({ ...i }));
  const voidLineIds: string[] = [];
  const splits: PlannedVoid["splits"] = [];
  let voidedCents = 0;
  let fired = false;
  const seen = new Set<string>();
  for (const sel of selections) {
    if (seen.has(sel.line_id)) throw new AdjustmentInputError("A line is listed twice.");
    seen.add(sel.line_id);
    const line = byId.get(sel.line_id);
    if (!line || line.voided) {
      throw new AdjustmentInputError("That item is not on the order (or was already voided).");
    }
    const qty = sel.quantity ?? line.quantity;
    if (!Number.isSafeInteger(qty) || qty <= 0) {
      throw new AdjustmentInputError("Quantity must be a positive whole number.");
    }
    if (qty > line.quantity) {
      throw new AdjustmentInputError(`Only ${line.quantity} of that item are on the order.`);
    }
    if (line.fired_at) fired = true;
    voidedCents += line.unit_price_cents * qty;
    const idx = items.findIndex((i) => i.id === line.id);
    if (qty === line.quantity) {
      voidLineIds.push(line.id);
      items[idx] = { ...line, voided: true, line_total_cents: 0 };
    } else {
      const keep = line.quantity - qty;
      const newId = newLineId();
      splits.push({ line_id: line.id, new_line_id: newId, keep_quantity: keep, void_quantity: qty });
      items[idx] = { ...line, quantity: keep, line_total_cents: line.unit_price_cents * keep };
      items.splice(idx + 1, 0, {
        ...line,
        id: newId,
        quantity: qty,
        voided: true,
        line_total_cents: 0,
      });
    }
  }
  return { items, voidLineIds, splits, voidedCents, fired };
}

/**
 * Re-derive comps and percent discounts after the lines changed: a comp of a
 * voided line is dropped, a comp never exceeds its (remaining) line, a percent
 * discount is re-taken on the subtotal net of comps, and a fixed discount never
 * exceeds what is left. Σ result <= subtotal.
 */
export function normalizeAdjustments(
  items: readonly OrderItem[],
  adjustments: readonly OrderAdjustment[],
): OrderAdjustment[] {
  const live = new Map(items.filter((i) => !i.voided).map((i) => [i.id, i]));
  const subtotal = [...live.values()].reduce((n, i) => n + i.unit_price_cents * i.quantity, 0);
  const out: OrderAdjustment[] = [];
  const compOnLine = new Map<string, number>();
  for (const a of adjustments) {
    if (a.type !== "comp") continue;
    const ids = (a.line_ids ?? []).filter((id) => live.has(id));
    if (ids.length === 0) continue;
    // Room = what is left of the line(s) after earlier comps, so units can be
    // comped one at a time; the comp's own amount (unit x its units) caps it.
    let room = 0;
    let own = 0;
    for (const id of ids) {
      const line = live.get(id)!;
      const units = a.quantity ? Math.min(a.quantity, line.quantity) : line.quantity;
      own += line.unit_price_cents * units;
      room += Math.max(0, line.unit_price_cents * line.quantity - (compOnLine.get(id) ?? 0));
    }
    const amount = Math.min(a.amount_cents, own, room);
    if (amount <= 0) continue;
    const parts = allocateCents(amount, ids.map(() => 1));
    ids.forEach((id, i) => compOnLine.set(id, (compOnLine.get(id) ?? 0) + parts[i]!));
    out.push({ ...a, line_ids: ids, amount_cents: amount });
  }
  const comps = out.reduce((n, a) => n + a.amount_cents, 0);
  let left = Math.max(0, subtotal - comps);
  const discountBase = left;
  for (const a of adjustments) {
    if (a.type !== "discount") continue;
    const wanted =
      a.percent_bps !== null && a.percent_bps !== undefined
        ? roundHalfUp((discountBase * a.percent_bps) / 10_000)
        : a.amount_cents;
    const amount = Math.min(wanted, left);
    if (amount <= 0) continue;
    left -= amount;
    out.push({ ...a, amount_cents: amount });
  }
  return out;
}

/**
 * Totals for an order whose lines/adjustments changed. Tax follows the order's
 * own rate: the location rate when it reproduces the order's current tax,
 * otherwise the order's effective rate (tax scaled with the taxable base), so an
 * edit never re-taxes an order at a rate it was not sold at.
 */
export function recomputeTotals(
  order: Order,
  items: readonly OrderItem[],
  adjustments: readonly OrderAdjustment[],
  locationTaxRateBps: number,
): OrderTotals {
  const discount = adjustments.reduce((n, a) => n + a.amount_cents, 0);
  const fees = order.core_ext?.fees ?? [];
  const taxExempt = order.core_ext?.tax_exempt === true;
  const base = {
    items: [...items],
    discountCents: discount,
    fees,
    taxExempt,
    tipCents: order.totals.tip_cents ?? 0,
  };
  const old = order.totals;
  const reproduces =
    roundHalfUp((old.taxable_cents * locationTaxRateBps) / 10_000) === old.tax_cents;
  if (taxExempt || reproduces || old.taxable_cents <= 0) {
    return computeOrderTotals({ ...base, taxRateBps: taxExempt ? 0 : locationTaxRateBps });
  }
  const untaxed = computeOrderTotals({ ...base, taxRateBps: 0 });
  const tax = roundHalfUp((old.tax_cents * untaxed.taxable_cents) / old.taxable_cents);
  return { ...untaxed, tax_cents: tax, total_cents: untaxed.total_cents + tax };
}

/** Food money already covered by tenders (settled base net of refunds, plus pending). */
export function coveredBaseCents(payments: readonly Payment[], currency: string): number {
  const cur = currency.toUpperCase();
  return payments
    .filter((p) => p.currency.toUpperCase() === cur)
    .filter((p) => ["pending", "authorized", "captured"].includes(p.status))
    .reduce((n, p) => {
      const left = refundableParts(p);
      return n + (p.status === "pending" ? p.amount_cents : left.baseCents);
    }, 0);
}

/** The comps/discounts on an order (a legacy discount_cents becomes one discount). */
export function currentAdjustments(order: Order): OrderAdjustment[] {
  if (order.adjustments?.length) return order.adjustments;
  if (order.totals.discount_cents > 0) {
    return [
      {
        id: "adj_discount",
        type: "discount",
        source: "pos.manual",
        label: "Discount",
        percent_bps: null,
        amount_cents: order.totals.discount_cents,
        line_ids: null,
        reason_code: "manager_discretion",
        reason_text: null,
        staff_id: order.staff_id ?? null,
        approved_by: null,
        created_at: order.created_at,
      },
    ];
  }
  return [];
}

