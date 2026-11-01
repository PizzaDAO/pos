/**
 * Normalised tip facts (`TipFact`: rows of `GET /v1/tips`, payloads of
 * `tip.recorded` / `tip.adjusted`), derived from the order and its tenders.
 *
 * The contract rule (TipFactSchema), with no double counting:
 *   - if ANY captured tender on the order carries a tip, tender tips are the
 *     truth: one `card` / `cash_on_tender` fact per tipped tender, and the
 *     order-level `totals.tip_cents` is ignored;
 *   - otherwise an order with at least one settled (captured or refunded) tender
 *     has its `totals.tip_cents` as ONE `online` fact.
 * Held, canceled and unpaid-checkout orders have no facts (MockCore's rule), with
 * one exception: a voided order with a refunded tender keeps them, so a tip that
 * was recorded (and maybe paid out) is reversed by its refund. The list and the
 * events apply this to CURRENT state, so they agree.
 *
 * Adjustments (refunds) are separate signed facts and never rewrite an earlier
 * fact. They are dated by WHEN THE REFUND HAPPENED, in the location's zone: a
 * refund after a period closed lands in the open period, not in the order's.
 *   - tender tip: refunds come off the tip FIRST (as `netSettledBaseCents` and
 *     the payments service count them), so a refund's tip part is
 *     min(running, tip) - min(prev running, tip); id carries the cumulative part.
 *   - online tip: POS caps a tender's refunds at amount + tip and the tender
 *     tip is 0 here, so a partial refund can never reach the tip (the tip was not
 *     collected on a tender). Only when EVERY settled tender is fully refunded is
 *     the order reversed, and then the online tip is reversed once, in full:
 *     the fact and its adjustment net to zero.
 *
 * `processing_fee_cents` is always 0: POS holds no card-processing fee data.
 * Every id is deterministic, so the same state yields the same facts: the list,
 * the outbox hydrator and replays agree, and consumers dedupe on `id`.
 */
import { businessDate, type TipFact } from "@openpizza/core";
import type { Payment } from "@/lib/db";
import { tenderMethod, toContractRefunds } from "./mappers";

/** What the builder needs about an order (POS status, not the contract axes). */
export interface TipOrderInput {
  id: string;
  tenant_id: string;
  location_id: string;
  /** Order business date (location-local date of created_at). */
  business_date: string;
  currency: string;
  staff_id: string | null;
  /** POS order status. */
  status: string;
  tip_cents: number;
  /** The location's IANA zone (dates adjustments by when the refund happened). */
  timezone: string;
}

/**
 * Held and unpaid-checkout orders carry no tip facts. A VOIDED order carries none
 * either, unless a tender of it was refunded: then its facts stay, so the tip
 * recorded (and perhaps paid out) and the refund that reversed it net to zero in
 * the refund's period (see {@link tipFactsForOrder}).
 */
export function isTipOrderStatus(status: string): boolean {
  return !["draft", "voided", "abandoned", "awaiting_payment"].includes(status);
}

/** Settled money: captured, or captured then (partly/fully) refunded. */
function isLive(p: Payment): boolean {
  return p.status === "captured" || p.status === "refunded";
}

const byCreated = (a: Payment, b: Payment) =>
  a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id);

export const tenderTipFactId = (paymentId: string) => `tip_${paymentId}`;
export const onlineTipFactId = (orderId: string) => `tip_online_${orderId}`;
export const tenderTipAdjustmentId = (paymentId: string, cumTipRefunded: number) =>
  `tipadj_${paymentId}_c${cumTipRefunded}`;
export const onlineTipReversalId = (orderId: string) => `tipadj_online_${orderId}_full`;

export function tipFactsForOrder(order: TipOrderInput, payments: Payment[]): TipFact[] {
  const live = payments.filter(isLive).sort(byCreated);
  if (live.length === 0) return [];
  if (
    !isTipOrderStatus(order.status) &&
    !(order.status === "voided" && live.some((p) => p.refunded_cents > 0))
  )
    return [];
  const base = {
    tenant_id: order.tenant_id,
    location_id: order.location_id,
    order_id: order.id,
    currency: order.currency,
    processing_fee_cents: 0,
  };
  const adjustmentDate = (at: string) => businessDate(at, order.timezone);
  const facts: TipFact[] = [];
  const tipped = live.filter((p) => p.tip_cents > 0);

  if (tipped.length > 0) {
    for (const p of tipped) {
      const factId = tenderTipFactId(p.id);
      const staff = p.staff_id ?? order.staff_id ?? null;
      facts.push({
        ...base,
        id: factId,
        payment_id: p.id,
        business_date: order.business_date,
        kind: tenderMethod(p) === "cash" ? "cash_on_tender" : "card",
        amount_cents: p.tip_cents,
        staff_id: staff,
        occurred_at: new Date(p.created_at).toISOString(),
      });
      let prev = 0;
      let run = 0;
      for (const r of toContractRefunds(p)) {
        run += r.amount_cents;
        const cum = Math.min(run, p.tip_cents);
        if (cum > prev) {
          facts.push({
            ...base,
            id: tenderTipAdjustmentId(p.id, cum),
            payment_id: p.id,
            business_date: adjustmentDate(r.at),
            kind: "adjustment",
            amount_cents: -(cum - prev),
            staff_id: staff,
            adjusts: factId,
            occurred_at: r.at,
          });
          prev = cum;
        }
      }
    }
    return facts;
  }

  const tip = Math.max(0, order.tip_cents);
  if (tip === 0) return [];
  const factId = onlineTipFactId(order.id);
  facts.push({
    ...base,
    id: factId,
    payment_id: null,
    business_date: order.business_date,
    kind: "online",
    amount_cents: tip,
    staff_id: order.staff_id ?? null,
    occurred_at: new Date(live[0]!.created_at).toISOString(),
  });
  // Fully reversed order: every settled tender refunded in full.
  if (live.every((p) => p.status === "refunded" || p.refunded_cents >= p.amount_cents + p.tip_cents)) {
    let last: { at: string; paymentId: string } | null = null;
    for (const p of live) {
      for (const r of toContractRefunds(p)) {
        if (!last || r.at > last.at) last = { at: r.at, paymentId: p.id };
      }
    }
    const at = last?.at ?? new Date(live[live.length - 1]!.created_at).toISOString();
    facts.push({
      ...base,
      id: onlineTipReversalId(order.id),
      payment_id: last?.paymentId ?? live[0]!.id,
      business_date: adjustmentDate(at),
      kind: "adjustment",
      amount_cents: -tip,
      staff_id: order.staff_id ?? null,
      adjusts: factId,
      occurred_at: at,
    });
  }
  return facts;
}

/** Stable list order: business date, then when it happened, then id. */
export function sortTipFacts(facts: TipFact[]): TipFact[] {
  return [...facts].sort(
    (a, b) =>
      a.business_date.localeCompare(b.business_date) ||
      a.occurred_at.localeCompare(b.occurred_at) ||
      a.id.localeCompare(b.id),
  );
}
