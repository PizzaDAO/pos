/** Pure mapping: a provider order -> a POS order (channel `marketplace`, already paid). */
import { uuidv5 } from "@openpizza/core";
import type {
  CreateOrderInput,
  MarketplaceOrderMeta,
  OrderFulfillment,
  OrderItem,
} from "@/lib/db";
import type { NormalizedOrder } from "./types";

/** Minutes a marketplace order is promised in when the provider gave no time. */
export const DEFAULT_PREP_MINUTES = 20;

/**
 * Deterministic order id for (tenant, location, provider, external id). Ingest
 * uses it as the POS order id, so a replayed webhook maps to the SAME row:
 * createOrder is already idempotent on id, and the DB unique index on
 * (location, provider, external id) backs it up.
 */
export function marketplaceOrderId(
  tenantId: string,
  locationId: string,
  provider: string,
  externalId: string,
): string {
  return uuidv5(
    `marketplace:${tenantId}:${locationId}:${provider}:${externalId}`,
  );
}

export function mapLines(order: NormalizedOrder): OrderItem[] {
  return order.lines.map((l, i) => {
    const modTotal = l.modifiers.reduce((n, m) => n + m.priceCents, 0);
    const unit = l.unitPriceCents + modTotal;
    return {
      id: uuidv5(`marketplace-line:${order.provider}:${order.externalId}:${i}`),
      item_id: uuidv5(`marketplace-item:${order.provider}:${l.externalItemId}`),
      item_name: l.name,
      size_id: null,
      size_name: null,
      base_price_cents: l.unitPriceCents,
      quantity: l.quantity,
      modifiers: l.modifiers.map((m, j) => ({
        group_id: uuidv5(`marketplace-modgroup:${order.provider}:${m.name}`),
        group_name: "Options",
        modifier_id: uuidv5(
          `marketplace-mod:${order.provider}:${l.externalItemId}:${j}:${m.name}`,
        ),
        modifier_name: m.name,
        price_cents: m.priceCents,
        placement: "whole" as const,
      })),
      notes: l.notes,
      voided: false,
      unit_price_cents: unit,
      line_total_cents: unit * l.quantity,
    };
  });
}

export function mapToCreateOrderInput(
  order: NormalizedOrder,
  ctx: { tenantId: string; locationId: string; now?: Date },
): CreateOrderInput {
  const items = mapLines(order);
  const subtotal = items.reduce((n, i) => n + i.line_total_cents, 0);
  const tax = order.taxCents;
  const tip = order.tipCents;
  const placed = order.placedAt
    ? new Date(order.placedAt)
    : (ctx.now ?? new Date());
  const promised = order.scheduledFor
    ? order.scheduledFor
    : new Date(placed.getTime() + DEFAULT_PREP_MINUTES * 60_000).toISOString();
  const meta: MarketplaceOrderMeta = {
    provider: order.provider,
    external_id: order.externalId,
    display_id: order.displayId,
    acceptance: "pending",
    customer_name: order.customerName,
    customer_phone: order.customerPhone,
  };
  const fulfillment: OrderFulfillment = {
    type: order.fulfillment,
    scheduled_for: order.scheduledFor ?? "asap",
    promised_at: promised,
    marketplace: meta,
  };
  const noteParts = [
    order.displayId ? `#${order.displayId}` : null,
    order.customerName,
    order.notes,
  ].filter(Boolean);
  return {
    id: marketplaceOrderId(
      ctx.tenantId,
      ctx.locationId,
      order.provider,
      order.externalId,
    ),
    tenant_id: ctx.tenantId,
    location_id: ctx.locationId,
    channel: "marketplace",
    currency: order.currency,
    items,
    discount_cents: 0,
    totals: {
      subtotal_cents: subtotal,
      discount_cents: 0,
      taxable_cents: subtotal,
      tax_cents: tax,
      tip_cents: tip,
      total_cents: subtotal + tax + tip,
    },
    notes: noteParts.length ? noteParts.join(" · ") : null,
    // Held until accepted: `placed` stays off the kitchen board (see kds/board).
    status: "placed",
    fulfillment,
    source: {
      type: "marketplace",
      channel: "marketplace",
      module: order.provider,
      external_ref: order.externalId,
    },
  };
}
