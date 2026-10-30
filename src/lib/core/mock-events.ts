/**
 * Mock-driver event emission.
 *
 * In Postgres the outbox is written by triggers in the same transaction as the
 * change. The in-memory mock driver has no triggers, so this decorator wraps
 * its mutating methods and appends the SAME outbox rows (same event types,
 * subjects, POS-vocabulary `changes`) to the in-memory outbox. The inner mock
 * methods call each other through their own `this`, so nothing is emitted
 * twice. Selected only for the zero-env mock driver (see `getPosDriver`).
 */
import type {
  Customer,
  DeliveryRecord,
  Order,
  OrderStatus,
  Payment,
  PosDriver,
  Shift,
  Staff,
} from "@/lib/db";
// Direct module (not the barrel): @/lib/db/client imports this file.
import { NOT_LIVE_ORDER_STATUSES } from "@/lib/db/menu-types";
import { memoryOutbox, type MemoryOutbox } from "./outbox";

/**
 * Statuses that are NOT live: an order in one of these is not on the KDS and,
 * unless it was live before, the hub has never heard of it. The first time an
 * order is in a live status it is "announced" (`order.placed`, once).
 * Mirrors `orders.core_announced` + public.core_trg_orders():
 *  - never announced -> live: `order.placed` (a hold released/paid, a checkout
 *    paid, an ABANDONED checkout whose late payment is accepted);
 *  - never announced -> not live: nothing (a canceled hold, an abandoned
 *    checkout, a draft refunded);
 *  - announced: `order.status_changed` (+ aliases), `order.updated`.
 */
const NOT_LIVE: ReadonlySet<OrderStatus> = new Set<OrderStatus>(NOT_LIVE_ORDER_STATUSES);
/** No `order.updated` while an order sits in one of these (same as SQL). */
const NO_UPDATES: ReadonlySet<OrderStatus> = new Set<OrderStatus>([
  "draft",
  "awaiting_payment",
  "abandoned",
]);
/**
 * Checkout bookkeeping inside `fulfillment`: changing only these is not an
 * order change for the hub (same key list as public.core_trg_orders()).
 */
const BOOKKEEPING_KEYS = [
  "paid_at",
  "finalized_at",
  "late_payment",
  "recovery_attempts",
  "recovery_next_at",
  "foreign_alerted_at",
  "checkout_mode",
] as const;

function stableJson(v: unknown): string {
  if (v === undefined || v === null) return "null";
  if (typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`)
    .join(",")}}`;
}

function contentFulfillment(f: Order["fulfillment"]): string {
  if (!f) return "null";
  const copy: Record<string, unknown> = { ...f };
  for (const k of BOOKKEEPING_KEYS) delete copy[k];
  return stableJson(copy);
}

/**
 * Which orders have been announced (the mock's `orders.core_announced`). An
 * order in a live status is always announced; the set remembers the ones that
 * were live once and have since left it (voided, refunded).
 */
export class AnnouncedOrders {
  private ids = new Set<string>();
  has(o: Pick<Order, "id" | "status">): boolean {
    return !NOT_LIVE.has(o.status) || this.ids.has(o.id);
  }
  /** Record `o` after a write; `fresh` = a newly created row (forget a reused id). */
  note(o: Pick<Order, "id" | "status">, fresh = false): void {
    if (fresh) this.ids.delete(o.id);
    if (!NOT_LIVE.has(o.status)) this.ids.add(o.id);
  }
}

function orderEvents(
  box: MemoryOutbox,
  announced: AnnouncedOrders,
  order: Order,
  before: Order | null,
): void {
  const base = {
    tenant_id: order.tenant_id,
    location_id: order.location_id,
    subject_type: "order",
    subject_id: order.id,
    subject_version: order.version ?? 1,
    row_snapshot: { id: order.id, status: order.status },
  };
  if (!before) {
    announced.note(order, true);
    if (announced.has(order)) {
      box.append({ ...base, event_type: "order.placed", changes: null });
    }
    return;
  }
  const wasAnnounced = announced.has(before);
  announced.note(before);
  announced.note(order);
  if (before.status !== order.status) {
    const changes = { status: [before.status, order.status] as [unknown, unknown] };
    if (!wasAnnounced) {
      // Never announced: the first live status announces it (once); a
      // canceled/abandoned/refunded one was never on the hub, so nothing.
      if (announced.has(order)) {
        box.append({ ...base, event_type: "order.placed", changes });
      }
      return;
    }
    box.append({ ...base, event_type: "order.status_changed", changes });
    const alias: Partial<Record<OrderStatus, string>> = {
      ready: "order.ready",
      completed: "order.completed",
      voided: "order.canceled",
    };
    const a = alias[order.status];
    if (a) box.append({ ...base, event_type: a, changes });
    return;
  }
  if (
    wasAnnounced &&
    !NO_UPDATES.has(order.status) &&
    (stableJson(order.totals) !== stableJson(before.totals) ||
      (order.notes ?? null) !== (before.notes ?? null) ||
      contentFulfillment(order.fulfillment) !== contentFulfillment(before.fulfillment) ||
      order.discount_cents !== before.discount_cents ||
      (order.customer_id ?? null) !== (before.customer_id ?? null))
  ) {
    box.append({ ...base, event_type: "order.updated", changes: null });
  }
}

function paymentType(status: string): string | null {
  switch (status) {
    case "authorized":
      return "payment.authorized";
    case "captured":
      return "payment.captured";
    case "failed":
      return "payment.failed";
    case "refunded":
      return "payment.refunded";
    default:
      return null;
  }
}

/**
 * Same rules as public.core_trg_payments(): nothing for an order the hub has not
 * seen (its later order.placed is hydrated with the tenders); a released refund
 * reservation (refunded_cents goes down) retracts the unclaimed
 * payment.refunded row recording THAT reservation (its refunded_cents
 * transition moved by exactly the released amount), or, when no such row is
 * unclaimed, emits a correction for the restored status.
 */
/** How far a row's recorded refunded_cents transition moved (null if none). */
function refundDelta(
  changes: Record<string, [unknown, unknown]> | null,
): number | null {
  const t = changes?.refunded_cents;
  if (!t || typeof t[0] !== "number" || typeof t[1] !== "number") return null;
  return t[1] - t[0];
}

function paymentEvents(
  box: MemoryOutbox,
  orderAnnounced: boolean,
  after: Payment,
  before: Payment | null,
): void {
  if (!orderAnnounced) return;
  let type: string | null = null;
  let changes: Record<string, [unknown, unknown]> | null = null;
  if (before && after.refunded_cents < before.refunded_cents) {
    const released = before.refunded_cents - after.refunded_cents;
    const open = [...box.rows]
      .reverse()
      .find(
        (r) =>
          r.tenant_id === after.tenant_id &&
          r.subject_type === "payment" &&
          r.subject_id === after.id &&
          r.event_type === "payment.refunded" &&
          r.status === "pending" &&
          r.attempts === 0 &&
          refundDelta(r.changes) === released,
      );
    if (open) {
      open.status = "dead";
      open.last_error = "retracted: refund released";
      return;
    }
    changes = { refunded_cents: [before.refunded_cents, after.refunded_cents] };
    if (before.status !== after.status) changes.status = [before.status, after.status];
    type =
      after.status === "authorized" || after.status === "captured"
        ? paymentType(after.status)
        : null;
  } else if (!before) {
    type = paymentType(after.status);
  } else if (before.status !== after.status) {
    changes = { status: [before.status, after.status] };
    if (before.refunded_cents !== after.refunded_cents) {
      changes.refunded_cents = [before.refunded_cents, after.refunded_cents];
    }
    type = paymentType(after.status);
  } else if (after.refunded_cents > before.refunded_cents) {
    changes = { refunded_cents: [before.refunded_cents, after.refunded_cents] };
    type = "payment.refunded";
  }
  if (!type) return;
  box.append({
    tenant_id: after.tenant_id,
    location_id: after.location_id,
    event_type: type,
    subject_type: "payment",
    subject_id: after.id,
    changes,
    row_snapshot: { id: after.id, status: after.status },
  });
}

export function withOutbox(
  inner: PosDriver,
  box: MemoryOutbox = memoryOutbox,
): PosDriver {
  const announced = new AnnouncedOrders();
  const orderAnnounced = async (orderId: string): Promise<boolean> => {
    const o = await inner.getOrder(orderId);
    if (!o) return false;
    announced.note(o);
    return announced.has(o);
  };
  const emitMenuUpdated = (tenantId: string, itemId: string | null) => {
    // Coalesce into a pending row that has NOT been claimed yet; once a worker
    // has claimed it (attempts > 0) further edits get their own row.
    const open = box.rows.find(
      (r) =>
        r.tenant_id === tenantId &&
        r.event_type === "menu.updated" &&
        r.subject_type === "menu" &&
        r.subject_id === tenantId &&
        r.status === "pending" &&
        r.attempts === 0,
    );
    if (open) {
      const ids = new Set((open.row_snapshot?.changed_item_ids as string[] | undefined) ?? []);
      if (itemId) ids.add(itemId);
      open.row_snapshot = { changed_item_ids: [...ids] };
      return;
    }
    box.append({
      tenant_id: tenantId,
      location_id: null,
      event_type: "menu.updated",
      subject_type: "menu",
      subject_id: tenantId,
      row_snapshot: { changed_item_ids: itemId ? [itemId] : [] },
    });
  };

  const wrapped: PosDriver = {
    ...inner,

    async createOrder(input) {
      const before = await inner.getOrder(input.id);
      const order = await inner.createOrder(input);
      if (!before) orderEvents(box, announced, order, null);
      return order;
    },

    async updateOrderStatus(id, status) {
      const before = await inner.getOrder(id);
      const order = await inner.updateOrderStatus(id, status);
      if (order && before) orderEvents(box, announced, order, before);
      return order;
    },

    async upsertPayment(payment) {
      const before = await inner.getPayment(payment.id);
      const after = await inner.upsertPayment(payment);
      paymentEvents(box, await orderAnnounced(after.order_id), after, before);
      return after;
    },

    // Main's compare-and-set status moves (online checkout lifecycle,
    // settlement) bypass updateOrderStatus.
    async transitionOrderStatus(id, from, to, patch) {
      const before = await inner.getOrder(id);
      const order = await inner.transitionOrderStatus(id, from, to, patch);
      if (order && before) orderEvents(box, announced, order, before);
      return order;
    },

    // Fulfillment merges: requotes are content (order.updated); checkout
    // bookkeeping (paid_at, finalized_at, late_payment, ...) is not.
    async mergeOrderFulfillment(id, patch) {
      const before = await inner.getOrder(id);
      const order = await inner.mergeOrderFulfillment(id, patch);
      if (order && before) orderEvents(box, announced, order, before);
      return order;
    },

    // Refunds move refunded_cents / status through the atomic reservation
    // (and its release when the rail call fails).
    async reservePaymentRefund(paymentId, amountCents, refundId) {
      const before = await inner.getPayment(paymentId);
      const res = await inner.reservePaymentRefund(paymentId, amountCents, refundId);
      if (res.ok && before) {
        paymentEvents(box, await orderAnnounced(res.payment.order_id), res.payment, before);
      }
      return res;
    },

    async releasePaymentRefund(paymentId, amountCents, refundId) {
      const before = await inner.getPayment(paymentId);
      await inner.releasePaymentRefund(paymentId, amountCents, refundId);
      const after = await inner.getPayment(paymentId);
      if (before && after) {
        paymentEvents(box, await orderAnnounced(after.order_id), after, before);
      }
    },

    async upsertOverride(input) {
      const prior = (await inner.listOverrides(input.tenant_id, input.location_id)).find(
        (o) => o.target_type === input.target_type && o.target_id === input.target_id,
      );
      const result = await inner.upsertOverride(input);
      const was = prior?.available !== false;
      const now = result.available !== false;
      if (was !== now) {
        box.append({
          tenant_id: input.tenant_id,
          location_id: input.location_id,
          event_type: now ? "menu.item.available" : "menu.item.unavailable",
          subject_type: "menu_item",
          subject_id: input.target_id,
          changes: { available: [was, now] },
          row_snapshot: {
            target_type: input.target_type,
            target_id: input.target_id,
            location_id: input.location_id,
          },
        });
      }
      if ((prior?.price_cents ?? null) !== (result.price_cents ?? null)) {
        box.append({
          tenant_id: input.tenant_id,
          location_id: input.location_id,
          event_type: "menu.updated",
          subject_type: "menu",
          subject_id: input.location_id,
          row_snapshot: {
            target_type: input.target_type,
            target_id: input.target_id,
          },
        });
      }
      return result;
    },

    async clearOverride(tenantId, locationId, targetType, targetId) {
      const prior = (await inner.listOverrides(tenantId, locationId)).find(
        (o) => o.target_type === targetType && o.target_id === targetId,
      );
      await inner.clearOverride(tenantId, locationId, targetType, targetId);
      if (prior?.available === false) {
        box.append({
          tenant_id: tenantId,
          location_id: locationId,
          event_type: "menu.item.available",
          subject_type: "menu_item",
          subject_id: targetId,
          changes: { available: [false, true] },
          row_snapshot: { target_type: targetType, target_id: targetId, location_id: locationId },
        });
      }
    },

    async upsertCustomer(customer: Customer) {
      const known =
        (await inner.getCustomer(customer.id)) ??
        (await inner.getCustomerByEmail(customer.tenant_id, customer.email));
      const result = await inner.upsertCustomer(customer);
      box.append({
        tenant_id: result.tenant_id,
        location_id: null,
        event_type: known ? "customer.updated" : "customer.created",
        subject_type: "customer",
        subject_id: result.id,
        row_snapshot: { id: result.id },
      });
      return result;
    },

    async upsertStaff(staff: Staff) {
      const before = staff.id
        ? (await inner.listStaff(staff.tenant_id)).find((s) => s.id === staff.id)
        : undefined;
      const result = await inner.upsertStaff(staff);
      const type = !before
        ? "staff.created"
        : before.active && !result.active
          ? "staff.deactivated"
          : "staff.updated";
      box.append({
        tenant_id: result.tenant_id,
        location_id: null,
        event_type: type,
        subject_type: "staff",
        subject_id: result.id,
        row_snapshot: { id: result.id },
      });
      return result;
    },

    async openShift(input) {
      const shift: Shift = await inner.openShift(input);
      box.append({
        tenant_id: shift.tenant_id,
        location_id: shift.location_id,
        event_type: "drawer_session.opened",
        subject_type: "drawer_session",
        subject_id: shift.id,
        row_snapshot: { id: shift.id },
      });
      return shift;
    },

    async closeShift(input) {
      const before = await inner.getShift(input.shiftId);
      const shift = await inner.closeShift(input);
      if (shift && before?.status === "open" && shift.status === "closed") {
        box.append({
          tenant_id: shift.tenant_id,
          location_id: shift.location_id,
          event_type: "drawer_session.closed",
          subject_type: "drawer_session",
          subject_id: shift.id,
          changes: { status: ["open", "closed"] },
          row_snapshot: { id: shift.id },
        });
      }
      return shift;
    },

    async closeBusinessDay(tenantId, locationId, businessDate) {
      const existing = await inner.getBusinessDayClose(tenantId, locationId, businessDate);
      const close = await inner.closeBusinessDay(tenantId, locationId, businessDate);
      if (!existing) {
        box.append({
          tenant_id: tenantId,
          location_id: locationId,
          event_type: "business_day.closed",
          subject_type: "business_day",
          subject_id: close.id,
          row_snapshot: { location_id: locationId, business_date: businessDate },
        });
      }
      return close;
    },

    async upsertDelivery(delivery: DeliveryRecord) {
      const before = await inner.getDelivery(delivery.id);
      const result = await inner.upsertDelivery(delivery);
      if (!before || before.status !== result.status) {
        box.append({
          tenant_id: result.tenant_id,
          location_id: result.location_id,
          event_type: "delivery.status_changed",
          subject_type: "delivery",
          subject_id: result.id,
          changes: before ? { status: [before.status, result.status] } : null,
          row_snapshot: { id: result.id },
        });
      }
      return result;
    },

    // -- menu structure -> thin menu.updated (debounced) -----------------------
    async upsertItem(input) {
      const r = await inner.upsertItem(input);
      emitMenuUpdated(r.tenant_id, r.id);
      return r;
    },
    async deleteItem(id) {
      const tenant = await inner.getMenuEntityTenant("item", id);
      await inner.deleteItem(id);
      if (tenant) emitMenuUpdated(tenant, id);
    },
    async upsertCategory(input) {
      const r = await inner.upsertCategory(input);
      emitMenuUpdated(r.tenant_id, null);
      return r;
    },
    async deleteCategory(id) {
      const tenant = await inner.getMenuEntityTenant("category", id);
      await inner.deleteCategory(id);
      if (tenant) emitMenuUpdated(tenant, null);
    },
    async upsertSize(input) {
      const r = await inner.upsertSize(input);
      const tenant = await inner.getMenuEntityTenant("item", r.item_id);
      if (tenant) emitMenuUpdated(tenant, r.item_id);
      return r;
    },
    async deleteSize(id) {
      const tenant = await inner.getMenuEntityTenant("size", id);
      await inner.deleteSize(id);
      if (tenant) emitMenuUpdated(tenant, null);
    },
    async upsertModifierGroup(input) {
      const r = await inner.upsertModifierGroup(input);
      emitMenuUpdated(r.tenant_id, null);
      return r;
    },
    async deleteModifierGroup(id) {
      const tenant = await inner.getMenuEntityTenant("modifierGroup", id);
      await inner.deleteModifierGroup(id);
      if (tenant) emitMenuUpdated(tenant, null);
    },
    async upsertModifier(input) {
      const r = await inner.upsertModifier(input);
      const tenant = await inner.getMenuEntityTenant("modifier", r.id);
      if (tenant) emitMenuUpdated(tenant, null);
      return r;
    },
    async deleteModifier(id) {
      const tenant = await inner.getMenuEntityTenant("modifier", id);
      await inner.deleteModifier(id);
      if (tenant) emitMenuUpdated(tenant, null);
    },
  };
  return wrapped;
}
