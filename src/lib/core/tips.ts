/**
 * Normalised tip facts (`TipFact`: rows of `GET /v1/tips`, payloads of
 * `tip.recorded` / `tip.adjusted`), derived from the order and its tenders.
 *
 * The contract rule (TipFactSchema), with no double counting:
 *   - if ANY captured tender on the order carries a tip, tender tips are the
 *     truth: one `card` / `cash_on_tender` fact per tipped tender, and the
 *     order-level `totals.tip_cents` is ignored;
 *   - otherwise a PAID order's `totals.tip_cents` is ONE `online` fact.
 * Adjustments (refunds) are separate signed facts and never rewrite an earlier
 * fact. Refunds come off the tip FIRST, exactly as `netSettledBaseCents` and the
 * payments service count them (base survives until the tip is gone):
 *   - tender tip: a refund's tip part is min(running, tip) - min(prev running, tip);
 *   - online tip (no tender tip): the part of the running refund total BEYOND the
 *     base, capped at the tip.
 *
 * Every id is deterministic from the order / tender / cumulative refunded tip,
 * so the same state always yields the same facts: the list, the outbox
 * hydrator and replays agree, and a consumer dedupes on `id`.
 */
import type { TipFact } from "@openpizza/core";
import type { Payment } from "@/lib/db";
import { tenderMethod, toContractRefunds } from "./mappers";

/** The order fields the builder needs (a contract `Order` satisfies it). */
export interface TipOrderInput {
  id: string;
  tenant_id: string;
  location_id: string;
  business_date: string;
  currency: string;
  totals: { tip_cents: number };
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
export const onlineTipAdjustmentId = (orderId: string, cumTipRefunded: number) =>
  `tipadj_online_${orderId}_c${cumTipRefunded}`;

export function tipFactsForOrder(order: TipOrderInput, payments: Payment[]): TipFact[] {
  const live = payments.filter(isLive).sort(byCreated);
  if (live.length === 0) return [];
  const base = {
    tenant_id: order.tenant_id,
    location_id: order.location_id,
    order_id: order.id,
    business_date: order.business_date,
    currency: order.currency,
    processing_fee_cents: 0,
  };
  const facts: TipFact[] = [];
  const tipped = live.filter((p) => p.tip_cents > 0);

  if (tipped.length > 0) {
    for (const p of tipped) {
      const factId = tenderTipFactId(p.id);
      facts.push({
        ...base,
        id: factId,
        payment_id: p.id,
        kind: tenderMethod(p) === "cash" ? "cash_on_tender" : "card",
        amount_cents: p.tip_cents,
        staff_id: p.staff_id ?? null,
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
            kind: "adjustment",
            amount_cents: -(cum - prev),
            staff_id: p.staff_id ?? null,
            adjusts: factId,
            occurred_at: r.at,
          });
          prev = cum;
        }
      }
    }
    return facts;
  }

  const tip = Math.max(0, order.totals.tip_cents);
  if (tip === 0) return [];
  const factId = onlineTipFactId(order.id);
  facts.push({
    ...base,
    id: factId,
    payment_id: null,
    kind: "online",
    amount_cents: tip,
    staff_id: null,
    occurred_at: new Date(live[0]!.created_at).toISOString(),
  });
  const baseCents = live.reduce((n, p) => n + p.amount_cents, 0);
  const refunds = live
    .flatMap((p) => toContractRefunds(p).map((r) => ({ r, p })))
    .sort((a, b) => a.r.at.localeCompare(b.r.at) || a.r.id.localeCompare(b.r.id));
  let run = 0;
  let prev = 0;
  for (const { r, p } of refunds) {
    run += r.amount_cents;
    const cum = Math.max(0, Math.min(run - baseCents, tip));
    if (cum > prev) {
      facts.push({
        ...base,
        id: onlineTipAdjustmentId(order.id, cum),
        payment_id: p.id,
        kind: "adjustment",
        amount_cents: -(cum - prev),
        staff_id: null,
        adjusts: factId,
        occurred_at: r.at,
      });
      prev = cum;
    }
  }
  return facts;
}

/** Stable list order: oldest first, id as the tiebreak. */
export function sortTipFacts(facts: TipFact[]): TipFact[] {
  return [...facts].sort(
    (a, b) => a.occurred_at.localeCompare(b.occurred_at) || a.id.localeCompare(b.id),
  );
}
