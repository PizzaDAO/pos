/**
 * Refunds, voids, comps and discounts (server-side orchestration).
 *
 * REFUNDS (`refundOrder`): an amount, or chosen line items with quantities,
 * across the order's tenders. Base (food) and tip money are kept apart: a tip
 * refund is asked for explicitly, recorded separately on the tender
 * (`tip_refunded_cents`) and flagged on the ledger row; who absorbs it (tip
 * pool clawback) is NOT decided here, it is only recorded.
 *  - Never more than was captured: each tender's base and tip are capped
 *    atomically in the driver (`reservePaymentRefund`).
 *  - Two tills at once: item quantities are reserved atomically per order
 *    (`beginOrderRefund`, under the order row lock); money per tender.
 *  - Idempotent and resumable: the client request id is the ledger row id, and
 *    every per-tender refund id is derived from it (`<request>_<tender>_<n>`),
 *    so a retry after a crash or lost response never refunds twice (the same
 *    Stripe idempotency key, the same reservation id) and finishes what is left.
 *  - Card money goes back through Stripe; cash is recorded as a cash-out
 *    (`payout`) on the open drawer; crypto rails only record the refund.
 *
 * VOIDS / COMPS / DISCOUNTS (before payment): computed from the order, then
 * applied with a compare-and-set on the order version (`applyOrderEdit`); a
 * concurrent edit makes it stale and it is recomputed. If tenders already cover
 * more than the new amount due, the edit is refused (`use_refund`): after
 * payment, a void is a refund. Voiding a whole PAID order refunds it in full.
 *
 * Every action needs a reason, is checked against the location's approval
 * thresholds (manager PIN above them) and is audit-logged with the staff ids.
 */
import { NextResponse } from "next/server";
import {
  getPosDriver,
  KDS_ACTIVE_STATUSES,
  type Order,
  type Payment,
  type Staff,
} from "@/lib/db";
import type {
  AdjustmentKind,
  AdjustmentRecord,
  OrderAdjustment,
  RefundAllocation,
} from "@/lib/db/adjustment-types";
import { captureError } from "@/lib/observability";
import { recordAudit } from "@/lib/security/audit";
import { publicTender } from "@/lib/payments/public";
import {
  cancelOpenTender,
  getOrderBalance,
  isManualRefundRail,
  refundPayment,
  RefundExceedsError,
} from "@/lib/payments/service";
import { isFullyRefunded, liveTenders } from "@/lib/payments/refund-state";
import {
  AdjustmentInputError,
  currentAdjustments,
  lineRefundAmounts,
  normalizeAdjustments,
  planLineVoid,
  planRefundAllocation,
  recomputeTotals,
  refundableTotals,
  refundedQuantities,
  type VoidSelection,
} from "./math";
import { reasonSummary } from "./reasons";
import type { ApprovalOutcome, TillActor } from "./authorize";

/** Enforces the approval policy for an amount (bound to the request by the route). */
export type Authorize = (
  kind: AdjustmentKind,
  amountCents: number,
  opts?: { fired?: boolean },
) => Promise<ApprovalOutcome>;

export interface ActionInput {
  orderId: string;
  /** Client-minted request id (idempotency key, ledger row id). */
  requestId: string;
  reason: { code: string; text: string | null };
  actor: TillActor;
  authorize: Authorize;
}

export type ActionResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; res: NextResponse };

function fail(status: number, error: string, code?: string, extra: Record<string, unknown> = {}) {
  return {
    ok: false as const,
    res: NextResponse.json({ error, ...(code ? { code } : {}), ...extra }, { status }),
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

/** What the till gets back after any action: the fresh order + tenders + ledger. */
async function snapshot(orderId: string): Promise<Record<string, unknown>> {
  const driver = getPosDriver();
  const order = await driver.getOrder(orderId);
  const payments = await driver.listPaymentsForOrder(orderId);
  const adjustments = await driver.listOrderAdjustments(orderId);
  return {
    order,
    payments: payments.map(publicTender),
    balanceCents: order ? await getOrderBalance(order) : 0,
    orderStatus: order?.status,
    adjustments,
  };
}

function actorLabel(actor: TillActor): string {
  return actor.staff ? `${actor.staff.name} (${actor.staff.id})` : actor.user.email;
}

function auditDetail(
  actor: TillActor,
  approver: { id: string; name: string } | null,
  text: string,
): string {
  const who = `by ${actorLabel(actor)}`;
  const ok = approver ? `, approved by ${approver.name} (${approver.id})` : "";
  return `${text} ${who}${ok}.`;
}

function baseRecord(
  input: ActionInput,
  order: Order,
  kind: AdjustmentKind,
  approver: Staff | null,
): AdjustmentRecord {
  const at = nowIso();
  return {
    id: input.requestId,
    tenant_id: order.tenant_id,
    location_id: order.location_id,
    order_id: order.id,
    kind,
    status: "completed",
    amount_cents: 0,
    tip_cents: 0,
    lines: [],
    allocations: [],
    reason_code: input.reason.code,
    reason_text: input.reason.text,
    staff_id: input.actor.staff?.id ?? null,
    actor_user_id: input.actor.user.id,
    approved_by: approver?.id ?? null,
    meta: null,
    created_at: at,
    updated_at: at,
  };
}

// ---------------------------------------------------------------------------
// Refunds
// ---------------------------------------------------------------------------

export interface RefundInput extends ActionInput {
  /** Item refund: lines + units (amount derived from the order). */
  lines?: { line_id: string; quantity: number }[];
  /** Amount refund: base (food) cents. */
  amountCents?: number;
  /** Tip to refund on top (kept separate, flagged). */
  tipCents?: number;
  /** Refund only this tender. */
  paymentId?: string | null;
}

/** Per-tender refund ids of one request: `<request>_<8 hex of tender>_<n>`. */
function tenderRefundIdPrefix(requestId: string, paymentId: string): string {
  return `${requestId}_${paymentId.replace(/[^0-9a-zA-Z]/g, "").slice(0, 8)}_`;
}

function entriesOfRequest(p: Payment, requestId: string) {
  const prefix = tenderRefundIdPrefix(requestId, p.id);
  return (p.refunds ?? []).filter(
    (r) => typeof r.request_id === "string" && r.request_id.startsWith(prefix) &&
      /^\d+$/.test(r.request_id.slice(prefix.length)),
  );
}

/** What this request has already moved, per tender (from the tenders themselves). */
function moneyDone(
  payments: Payment[],
  requestId: string,
): { base: number; tip: number; byPayment: Map<string, RefundAllocation> } {
  let base = 0;
  let tip = 0;
  const byPayment = new Map<string, RefundAllocation>();
  for (const p of payments) {
    for (const e of entriesOfRequest(p, requestId)) {
      const t = typeof e.tip_cents === "number" ? e.tip_cents : 0;
      const b = e.amount_cents - t;
      base += b;
      tip += t;
      const a = byPayment.get(p.id) ?? {
        payment_id: p.id,
        rail: p.rail,
        base_cents: 0,
        tip_cents: 0,
        processor_ref: null,
        manual: isManualRefundRail(p.rail),
      };
      a.base_cents += b;
      a.tip_cents += t;
      a.processor_ref = e.processor_ref ?? a.processor_ref;
      byPayment.set(p.id, a);
    }
  }
  return { base, tip, byPayment };
}

/** Record a cash refund as a cash-out on the open drawer (the staff's, else any). */
async function drawerCashOut(input: {
  order: Order;
  staffId: string | null;
  amountCents: number;
  note: string;
}): Promise<{ eventId: string | null; note: string | null }> {
  const driver = getPosDriver();
  try {
    let shift = input.staffId
      ? await driver.getOpenShift(input.order.tenant_id, input.order.location_id, input.staffId)
      : null;
    if (!shift) {
      shift =
        (await driver.listShifts(input.order.tenant_id, input.order.location_id)).find(
          (s) => s.status === "open",
        ) ?? null;
    }
    if (!shift) return { eventId: null, note: "No open drawer: the cash-out was not recorded." };
    const ev = await driver.addShiftCashEvent({
      id: "",
      shift_id: shift.id,
      tenant_id: shift.tenant_id,
      location_id: shift.location_id,
      type: "payout",
      amount_cents: -Math.abs(input.amountCents),
      order_id: input.order.id,
      note: input.note.slice(0, 200),
      created_at: "",
    });
    return { eventId: ev.id, note: null };
  } catch (err) {
    // The money already went back to the customer: never fail the refund over
    // the drawer row. Alert so the drawer can be corrected by hand.
    captureError(err, { scope: "refund-drawer", orderId: input.order.id });
    return { eventId: null, note: "The drawer cash-out could not be recorded." };
  }
}

/**
 * Move the money of a refund record (resumable: what the tenders already show
 * for this request is not moved again). Returns the final record.
 */
async function executeRefund(
  record: AdjustmentRecord,
  order: Order,
  summary: string,
): Promise<{ record: AdjustmentRecord; error: string | null; manual: boolean }> {
  const driver = getPosDriver();
  const only = typeof record.meta?.only_payment_id === "string" ? record.meta.only_payment_id : null;
  const targetTotal = record.amount_cents + record.tip_cents;
  const drawer = new Map<string, { eventId: string | null; note: string | null }>();
  for (const a of record.allocations) {
    if (a.drawer_event_id || a.drawer_note) {
      drawer.set(a.payment_id, { eventId: a.drawer_event_id ?? null, note: a.drawer_note ?? null });
    }
  }
  let error: string | null = null;
  let manual = false;

  for (let attempt = 0; attempt < 4 && !error; attempt++) {
    const payments = await driver.listPaymentsForOrder(order.id);
    const done = moneyDone(payments, record.id);
    const remTotal = targetTotal - done.base - done.tip;
    if (remTotal <= 0) break;
    let remBase = Math.max(0, record.amount_cents - done.base);
    let remTip = Math.max(0, record.tip_cents - done.tip);
    // A card refund recorded with an adjusted split (see refundPayment) can
    // leave base/tip off by the same amount; the total is what must match.
    let excess = remBase + remTip - remTotal;
    const cutTip = Math.min(excess, remTip);
    remTip -= cutTip;
    excess -= cutTip;
    remBase -= Math.min(excess, remBase);
    const plan = planRefundAllocation(payments, remBase, remTip, { onlyPaymentId: only });
    if (!plan) {
      error = "The tenders no longer have that much left to refund.";
      break;
    }
    let replan = false;
    for (const step of plan) {
      const n = entriesOfRequest(step.payment, record.id).length;
      const refundId = `${tenderRefundIdPrefix(record.id, step.payment.id)}${n}`;
      try {
        const r = await refundPayment({
          paymentId: step.payment.id,
          amountCents: step.baseCents + step.tipCents,
          tipCents: step.tipCents,
          reason: summary,
          refundId,
          metadata: { adjustment_id: record.id },
        });
        if (r?.manualRefund) manual = true;
        if (r && !r.replayed && step.payment.rail === "cash") {
          // Cash went back over the counter: take it out of the drawer.
          const ev = await drawerCashOut({
            order,
            staffId: record.staff_id,
            amountCents: r.refundedNowCents ?? step.baseCents + step.tipCents,
            note: `Refund order ${order.order_number}: ${summary}`,
          });
          const prev = drawer.get(step.payment.id);
          drawer.set(step.payment.id, {
            eventId: prev?.eventId ?? ev.eventId,
            note: ev.note ?? prev?.note ?? null,
          });
        }
      } catch (err) {
        if (err instanceof RefundExceedsError) {
          // A concurrent refund took this tender's room: re-plan the rest.
          replan = true;
          break;
        }
        captureError(err, { scope: "refund-order", orderId: order.id, paymentId: step.payment.id });
        error = err instanceof Error ? err.message : "Refund failed.";
        break;
      }
    }
    if (!replan && !error) continue; // loop once more to confirm everything landed
  }

  const payments = await driver.listPaymentsForOrder(order.id);
  const done = moneyDone(payments, record.id);
  const movedTotal = done.base + done.tip;
  const status: AdjustmentRecord["status"] =
    movedTotal >= targetTotal ? "completed" : movedTotal > 0 ? "partial" : "failed";
  if (status !== "completed" && !error) error = "Only part of the refund could be made.";
  const allocations = [...done.byPayment.values()].map((a) => {
    const d = drawer.get(a.payment_id);
    return d ? { ...a, drawer_event_id: d.eventId, drawer_note: d.note } : a;
  });
  const finished =
    (await driver.finishOrderAdjustment(order.id, record.id, {
      status,
      allocations,
      meta: error ? { error } : undefined,
    })) ?? { ...record, status, allocations };
  return { record: finished, error, manual };
}

export async function refundOrder(input: RefundInput): Promise<ActionResult> {
  const driver = getPosDriver();
  const order = await driver.getOrder(input.orderId);
  if (!order) return fail(404, "Order not found.");
  const records = await driver.listOrderAdjustments(order.id);
  const summary = reasonSummary("refund", input.reason.code, input.reason.text);

  let record = records.find((r) => r.id === input.requestId) ?? null;
  let approver: { id: string; name: string } | null = null;
  if (record && record.kind !== "refund") {
    return fail(409, "That request id was already used for another action.", "request_conflict");
  }
  if (record && record.status === "completed") {
    // Idempotent replay of a finished request: nothing moves again.
    return { ok: true, body: { ...(await snapshot(order.id)), record, replayed: true } };
  }
  if (record && record.status === "failed" && record.lines.length > 0) {
    // A failed item refund gave its units back: another till may have taken
    // them since, so it cannot be resumed under the same id.
    return fail(409, "That refund failed: start a new one.", "refund_failed");
  }
  // pending (crashed / lost response), partial or failed (an amount refund):
  // resume. What the tenders already show for this request is not moved again.

  if (!record) {
    const payments = await driver.listPaymentsForOrder(order.id);
    let lines: AdjustmentRecord["lines"] = [];
    let base: number;
    try {
      if (input.lines?.length) {
        lines = lineRefundAmounts(order, input.lines, refundedQuantities(records));
        base = lines.reduce((n, l) => n + l.amount_cents, 0);
      } else {
        base = input.amountCents ?? 0;
      }
    } catch (err) {
      if (err instanceof AdjustmentInputError) return fail(422, err.message);
      throw err;
    }
    const tip = input.tipCents ?? 0;
    if (base + tip <= 0) return fail(422, "Nothing to refund.");
    const left = refundableTotals(
      payments.filter((p) => !input.paymentId || p.id === input.paymentId),
    );
    if (!planRefundAllocation(payments, base, tip, { onlyPaymentId: input.paymentId })) {
      return fail(409, "That is more than is left to refund on this order.", "refund_exceeds", {
        refundableBaseCents: left.baseCents,
        refundableTipCents: left.tipCents,
      });
    }
    const auth = await input.authorize("refund", base + tip);
    if (!auth.ok) return auth;
    approver = auth.approver;
    const begun = await driver.beginOrderRefund({
      ...baseRecord(input, order, "refund", auth.approver),
      status: "pending",
      amount_cents: base,
      tip_cents: tip,
      lines,
      meta: {
        ...(input.paymentId ? { only_payment_id: input.paymentId } : {}),
        ...(tip > 0 ? { tip_refund: true } : {}),
      },
    });
    if (begun.outcome === "not_found") return fail(404, "Order not found.");
    if (begun.outcome === "exceeds") {
      return fail(
        409,
        `Only ${begun.available} of that item can still be refunded (another refund just took it).`,
        "refund_exceeds",
        { lineId: begun.line_id, available: begun.available },
      );
    }
    record = begun.record;
    if (begun.outcome === "duplicate" && record.status === "completed") {
      return { ok: true, body: { ...(await snapshot(order.id)), record, replayed: true } };
    }
  }

  const { record: finished, error, manual } = await executeRefund(record, order, summary);

  const after = await driver.getOrder(order.id);
  const paymentsAfter = await driver.listPaymentsForOrder(order.id);
  const moved = finished.allocations.reduce((n, a) => n + a.base_cents + a.tip_cents, 0);
  const tipMoved = finished.allocations.reduce((n, a) => n + a.tip_cents, 0);
  if (moved > 0) {
    const fully = isFullyRefunded(after, paymentsAfter);
    const lineText = finished.lines.length
      ? ` for ${finished.lines.map((l) => `${l.quantity}x line ${l.line_id}`).join(", ")}`
      : "";
    await recordAudit({
      actor: { id: input.actor.user.id, label: input.actor.user.email },
      action: fully ? "payment_void" : "payment_refund",
      tenantId: order.tenant_id,
      detail: auditDetail(
        input.actor,
        approver ?? (finished.approved_by ? { id: finished.approved_by, name: "manager" } : null),
        `${manual ? "Recorded a MANUAL refund of" : "Refunded"} ${moved}¢ on order ${order.id}${lineText}` +
          `${tipMoved > 0 ? ` (TIP REFUND ${tipMoved}¢)` : ""} -- ${summary} [${finished.id}, ${finished.status}]`,
      ),
    });
  }

  const drawerNotes = finished.allocations
    .map((a) => a.drawer_note)
    .filter((n): n is string => !!n);
  return {
    ok: true,
    body: {
      ...(await snapshot(order.id)),
      record: finished,
      manualRefund: manual,
      note: manual
        ? "Refund recorded, but no money was sent for the crypto part. Return it to the customer manually from your wallet / Coinbase account."
        : drawerNotes[0],
      ...(error ? { error, partial: finished.status === "partial" } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Voids, comps, discounts (order edits)
// ---------------------------------------------------------------------------

/** Has any money been taken on the order that is still held (not refunded)? */
function holdsMoney(payments: Payment[]): boolean {
  return payments.some(
    (p) =>
      (p.status === "captured" || p.status === "authorized") &&
      p.amount_cents + p.tip_cents > p.refunded_cents,
  );
}

/**
 * Compute-then-compare-and-set loop shared by voids/comps/discounts. `compute`
 * derives the write from a fresh order; the approval is asked once (for the
 * first computation) and a retry may not grow past what was approved.
 */
async function editLoop(
  input: ActionInput,
  kind: AdjustmentKind,
  compute: (order: Order, taxRateBps: number) =>
    | { ok: false; status: number; error: string; code?: string }
    | {
        ok: true;
        amountCents: number;
        fired: boolean;
        write: Omit<import("@/lib/db").OrderEditWrite, "record" | "expectVersion" | "orderId" | "tenantId">;
        record: Partial<AdjustmentRecord>;
        audit: string;
      },
): Promise<ActionResult> {
  const driver = getPosDriver();
  let approved: { amount: number; approver: Staff | null } | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const order = await driver.getOrder(input.orderId);
    if (!order) return fail(404, "Order not found.");
    const prior = (await driver.listOrderAdjustments(order.id)).find((r) => r.id === input.requestId);
    if (prior) {
      return { ok: true, body: { ...(await snapshot(order.id)), record: prior, replayed: true } };
    }
    const settings = await driver.getStoreSettings(order.tenant_id, order.location_id);
    let c;
    try {
      c = compute(order, settings.tax_rate_bps);
    } catch (err) {
      if (err instanceof AdjustmentInputError) return fail(422, err.message);
      throw err;
    }
    if (!c.ok) return fail(c.status, c.error, c.code);
    if (!approved) {
      const auth = await input.authorize(kind, c.amountCents, { fired: c.fired });
      if (!auth.ok) return auth;
      approved = { amount: c.amountCents, approver: auth.approver };
    } else if (c.amountCents > approved.amount && !approved.approver) {
      const auth = await input.authorize(kind, c.amountCents, { fired: c.fired });
      if (!auth.ok) return fail(409, "The order changed meanwhile: try again.", "order_changed");
    }
    const record: AdjustmentRecord = {
      ...baseRecord(input, order, kind, approved.approver),
      ...c.record,
      amount_cents: c.amountCents,
    };
    const approverId = approved.approver?.id ?? null;
    const res = await driver.applyOrderEdit({
      ...c.write,
      // The comp/discount this request adds carries its approver too.
      adjustments: c.write.adjustments.map((a) =>
        a.id === input.requestId ? { ...a, approved_by: approverId } : a,
      ),
      orderId: order.id,
      tenantId: order.tenant_id,
      expectVersion: order.version ?? 1,
      record,
    });
    if (res.outcome === "stale") continue;
    if (res.outcome === "not_found") return fail(404, "Order not found.");
    if (res.outcome === "duplicate") {
      return { ok: true, body: { ...(await snapshot(order.id)), record: res.record, replayed: true } };
    }
    if (res.outcome === "invalid_state") {
      if (res.reason === "paid_exceeds" || res.reason === "captured") {
        return fail(
          409,
          "This order is already paid: refund the item instead.",
          "use_refund",
        );
      }
      if (res.reason === "in_flight") {
        return fail(409, "A payment is still in progress on this order.", "payment_in_flight");
      }
      return fail(409, `This order can't be changed (${res.reason}).`, "invalid_state");
    }
    await recordAudit({
      actor: { id: input.actor.user.id, label: input.actor.user.email },
      action:
        kind === "void_order"
          ? "order_void"
          : kind === "void_line"
            ? "order_line_void"
            : kind === "comp"
              ? "order_comp"
              : "order_discount",
      tenantId: order.tenant_id,
      detail: auditDetail(
        input.actor,
        approved.approver ? { id: approved.approver.id, name: approved.approver.name } : null,
        `${c.audit} on order ${order.id} -- ${reasonSummary(kind, input.reason.code, input.reason.text)} [${record.id}]`,
      ),
    });
    return { ok: true, body: { ...(await snapshot(order.id)), record: res.record } };
  }
  return fail(409, "The order kept changing: try again.", "order_changed");
}

/** Void lines (or some units of a line) on an UNPAID order. */
export async function voidLines(
  input: ActionInput & { selections: VoidSelection[]; newLineId: () => string },
): Promise<ActionResult> {
  const driver = getPosDriver();
  const first = await driver.getOrder(input.orderId);
  if (!first) return fail(404, "Order not found.");
  if (holdsMoney(await driver.listPaymentsForOrder(first.id))) {
    return fail(409, "This order is already paid: refund the item instead.", "use_refund");
  }
  return editLoop(input, "void_line", (order, taxRate) => {
    const plan = planLineVoid(order, input.selections, input.newLineId);
    if (!plan.items.some((i) => !i.voided)) {
      return {
        ok: false,
        status: 422,
        error: "That would void every item: void the whole order instead.",
        code: "void_whole_order",
      };
    }
    const adjustments = normalizeAdjustments(plan.items, currentAdjustments(order));
    const totals = recomputeTotals(order, plan.items, adjustments, taxRate);
    return {
      ok: true,
      amountCents: plan.voidedCents,
      fired: plan.fired,
      write: {
        voidLineIds: plan.voidLineIds,
        splits: plan.splits,
        totals,
        discountCents: totals.discount_cents,
        adjustments,
        voidOrder: false,
      },
      record: {
        kind: "void_line",
        lines: input.selections.map((s) => {
          const line = order.items.find((i) => i.id === s.line_id)!;
          const qty = s.quantity ?? line.quantity;
          return { line_id: s.line_id, quantity: qty, amount_cents: line.unit_price_cents * qty };
        }),
        meta: {
          fired: plan.fired,
          ...(plan.splits.length ? { split_line_ids: plan.splits.map((x) => x.new_line_id) } : {}),
        },
      },
      audit: `Voided ${plan.voidedCents}¢ of items${plan.fired ? " (already sent to the kitchen)" : ""}`,
    };
  });
}

/**
 * Void a whole order. Unpaid: open tenders are canceled (strictly: a payment
 * still confirming blocks it) and the order is voided. Paid: void after payment
 * is the refund flow, so everything still held is refunded (base and tip) and
 * the order ends `refunded`.
 */
export async function voidOrder(input: ActionInput): Promise<ActionResult> {
  const driver = getPosDriver();
  const order = await driver.getOrder(input.orderId);
  if (!order) return fail(404, "Order not found.");
  if (order.status === "voided") {
    return { ok: true, body: { ...(await snapshot(order.id)), replayed: true } };
  }
  const payments = await driver.listPaymentsForOrder(order.id);
  if (holdsMoney(payments)) {
    const left = refundableTotals(payments);
    const result = await refundOrder({
      ...input,
      amountCents: left.baseCents,
      tipCents: left.tipCents,
    });
    // Still in the kitchen: the sale is off, so the order ends `voided` (the
    // kitchen screen shows STOP) rather than `refunded` (a refund after hand-off).
    if (
      result.ok &&
      (result.body.record as AdjustmentRecord | undefined)?.status === "completed" &&
      (KDS_ACTIVE_STATUSES as readonly string[]).includes(order.status)
    ) {
      await driver.transitionOrderStatus(order.id, ["refunded"], "voided");
      return { ok: true, body: { ...result.body, ...(await snapshot(order.id)) } };
    }
    return result;
  }
  for (const p of liveTenders(payments)) {
    if (p.status !== "requires_action" && p.status !== "pending") continue;
    if (p.rail === "external") continue; // a pending external promise is voided with the order
    const outcome = await cancelOpenTender(p);
    if (outcome !== "canceled") {
      return fail(
        409,
        outcome === "settled"
          ? "A payment just went through on this order: refund it instead."
          : "A payment is still in progress on this order.",
        outcome === "settled" ? "use_refund" : "payment_in_flight",
      );
    }
  }
  return editLoop(input, "void_order", (o) => {
    const live = o.items.filter((i) => !i.voided);
    return {
      ok: true,
      amountCents: o.totals.total_cents,
      fired: live.some((i) => !!i.fired_at),
      write: {
        voidLineIds: [],
        splits: [],
        totals: o.totals,
        discountCents: o.discount_cents,
        adjustments: currentAdjustments(o),
        voidOrder: true,
      },
      record: {
        kind: "void_order",
        lines: live.map((i) => ({
          line_id: i.id,
          quantity: i.quantity,
          amount_cents: i.line_total_cents,
        })),
        meta: { fired: live.some((i) => !!i.fired_at) },
      },
      audit: `Voided the whole order (${o.totals.total_cents}¢)`,
    };
  });
}

export interface CompInput extends ActionInput {
  /** comp: one line (+ units); discount: the whole order. */
  type: "comp" | "discount";
  lineId?: string;
  quantity?: number;
  /** discount: a fixed amount ... */
  amountCents?: number;
  /** ... or a percentage (basis points, 1..10000). */
  percentBps?: number;
  /** Remove an applied comp/discount instead (no approval needed: it raises the price). */
  removeId?: string;
}

/** Comp a line or discount the order (before payment), or remove one. */
export async function compOrDiscount(input: CompInput): Promise<ActionResult> {
  const kind: AdjustmentKind = input.type;
  return editLoop(input, kind, (order, taxRate) => {
    const existing = currentAdjustments(order);
    let next: OrderAdjustment[];
    let newAdj: OrderAdjustment | null = null;
    if (input.removeId) {
      if (!existing.some((a) => a.id === input.removeId)) {
        return { ok: false, status: 404, error: "That comp/discount is not on the order." };
      }
      next = existing.filter((a) => a.id !== input.removeId);
    } else if (input.type === "comp") {
      const line = order.items.find((i) => i.id === input.lineId && !i.voided);
      if (!line) return { ok: false, status: 422, error: "That item is not on the order." };
      const qty = input.quantity ?? line.quantity;
      if (!Number.isSafeInteger(qty) || qty <= 0 || qty > line.quantity) {
        return { ok: false, status: 422, error: `Comp 1 to ${line.quantity} of that item.` };
      }
      newAdj = {
        id: input.requestId,
        type: "comp",
        source: "pos.manual",
        label: `Comp: ${qty > 1 ? `${qty}x ` : ""}${line.item_name}`,
        percent_bps: null,
        amount_cents: line.unit_price_cents * qty,
        line_ids: [line.id],
        quantity: qty,
        reason_code: input.reason.code,
        reason_text: input.reason.text,
        staff_id: input.actor.staff?.id ?? null,
        approved_by: null,
        created_at: nowIso(),
      };
      next = [...existing, newAdj];
    } else {
      const pct = input.percentBps;
      const amt = input.amountCents;
      if ((pct === undefined) === (amt === undefined)) {
        return { ok: false, status: 422, error: "Give a discount amount or a percentage." };
      }
      newAdj = {
        id: input.requestId,
        type: "discount",
        source: "pos.manual",
        label: pct !== undefined ? `Discount ${(pct / 100).toFixed(pct % 100 ? 2 : 0)}%` : "Discount",
        percent_bps: pct ?? null,
        amount_cents: amt ?? 0,
        line_ids: null,
        reason_code: input.reason.code,
        reason_text: input.reason.text,
        staff_id: input.actor.staff?.id ?? null,
        approved_by: null,
        created_at: nowIso(),
      };
      next = [...existing, newAdj];
    }
    const adjustments = normalizeAdjustments(order.items, next);
    const applied = newAdj ? adjustments.find((a) => a.id === newAdj!.id) : null;
    if (newAdj && !applied) {
      return { ok: false, status: 422, error: "Nothing left to discount on this order." };
    }
    const totals = recomputeTotals(order, order.items, adjustments, taxRate);
    const amount = applied?.amount_cents ?? 0;
    return {
      ok: true,
      // Removing a comp/discount raises the price: no approval needed.
      amountCents: amount,
      fired: false,
      write: {
        voidLineIds: [],
        splits: [],
        totals,
        discountCents: totals.discount_cents,
        adjustments,
        voidOrder: false,
      },
      record: {
        kind,
        lines:
          applied?.type === "comp" && applied.line_ids?.length
            ? [{ line_id: applied.line_ids[0]!, quantity: applied.quantity ?? 1, amount_cents: amount }]
            : [],
        meta: input.removeId
          ? { removed_adjustment_id: input.removeId }
          : { ...(applied?.percent_bps ? { percent_bps: applied.percent_bps } : {}) },
      },
      audit: input.removeId
        ? `Removed comp/discount ${input.removeId}`
        : applied?.type === "comp"
          ? `Comped ${amount}¢ (${applied.label})`
          : `Discounted ${amount}¢${applied?.percent_bps ? ` (${applied.percent_bps / 100}%)` : ""}`,
    };
  });
}
