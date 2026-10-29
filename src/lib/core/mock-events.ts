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
import { memoryOutbox, type MemoryOutbox } from "./outbox";

function orderEvents(
  box: MemoryOutbox,
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
    if (order.status !== "draft" && order.status !== "voided") {
      box.append({ ...base, event_type: "order.placed", changes: null });
    }
    return;
  }
  if (before.status !== order.status) {
    const changes = { status: [before.status, order.status] as [unknown, unknown] };
    if (before.status === "draft") {
      // Leaving a hold: announce the order as placed (once). A hold that is
      // canceled was never announced, so nothing is emitted.
      if (order.status !== "voided") {
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

function paymentEvents(box: MemoryOutbox, after: Payment, before: Payment | null): void {
  let type: string | null = null;
  let changes: Record<string, [unknown, unknown]> | null = null;
  if (!before) {
    type = paymentType(after.status);
  } else if (before.status !== after.status) {
    changes = { status: [before.status, after.status] };
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
      if (!before) orderEvents(box, order, null);
      return order;
    },

    async updateOrderStatus(id, status) {
      const before = await inner.getOrder(id);
      const order = await inner.updateOrderStatus(id, status);
      if (order && before) orderEvents(box, order, before);
      return order;
    },

    async upsertPayment(payment) {
      const before = await inner.getPayment(payment.id);
      const after = await inner.upsertPayment(payment);
      paymentEvents(box, after, before);
      return after;
    },

    async reserveTender(payment) {
      const before = await inner.getPayment(payment.id);
      const res = await inner.reserveTender(payment);
      if (res.ok && !before) paymentEvents(box, res.payment, null);
      return res;
    },

    async finalizeRefund(id, status) {
      const refund = await inner.getRefund(id);
      const before = refund ? await inner.getPayment(refund.payment_id) : null;
      const after = await inner.finalizeRefund(id, status);
      if (after && before) paymentEvents(box, after, before);
      return after;
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
