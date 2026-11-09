/**
 * DoorDash Marketplace adapter ("Order API": orders placed on DoorDash by
 * consumers, sent to the restaurant POS). NOT DoorDash Drive (delivery-out; see
 * src/lib/delivery/providers/doordash-drive.ts, untouched).
 *
 * DOCS STATUS: UNVERIFIED. The Marketplace/Order API docs sit behind the partner
 * portal (developer.doordash.com requires an approved integration), so this is a
 * MODEL, not an implementation checked against DoorDash. Assumptions to confirm
 * once we have partner access:
 *  - inbound order webhook is signed HMAC-SHA256 (hex) over the raw body in
 *    `X-DoorDash-Signature` (DoorDash may instead use Basic auth or a JWT);
 *  - order JSON shape: {id, store:{merchant_supplied_id}, consumer, categories
 *    [].items[]{merchant_supplied_id,name,quantity,price,options[]}, subtotal,
 *    tax, tip, is_pickup, delivery_short_code};
 *  - confirm/reject/ready are PATCH/POST calls under
 *    /marketplace/api/v1/orders/{id}/... with an OAuth/JWT bearer.
 */
import {
  fetchClientToken,
  int,
  parseJson,
  str,
  verifyBodyHmac,
} from "../crypto";
import { getProviderConfig } from "../env";
import type {
  MarketplaceAdapter,
  MarketplaceCallContext,
  NormalizedOrder,
  ParsedWebhook,
  ProviderCallResult,
} from "../types";

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" ? (v as Obj) : {});
const arr = (v: unknown): Obj[] => (Array.isArray(v) ? (v as Obj[]) : []);

export function mapDoorDashOrder(o: Obj): NormalizedOrder {
  const consumer = obj(o.consumer);
  const lines = arr(o.categories).flatMap((c) =>
    arr(c.items).map((it) => ({
      externalItemId:
        str(it.merchant_supplied_id) ?? str(it.id) ?? str(it.name) ?? "unknown",
      name: str(it.name) ?? "Item",
      quantity: Math.max(1, int(it.quantity, 1)),
      unitPriceCents: int(it.price),
      modifiers: arr(it.options).map((m) => ({
        name: str(m.name) ?? "Option",
        priceCents: int(m.price),
      })),
      notes: str(it.special_instructions),
    })),
  );
  const subtotal =
    int(o.subtotal) ||
    lines.reduce(
      (n, l) =>
        n +
        (l.unitPriceCents + l.modifiers.reduce((a, m) => a + m.priceCents, 0)) *
          l.quantity,
      0,
    );
  const name = [str(consumer.first_name), str(consumer.last_name)]
    .filter(Boolean)
    .join(" ");
  return {
    provider: "doordash",
    externalId: str(o.id) ?? "",
    displayId: str(o.delivery_short_code),
    storeId: str(obj(o.store).merchant_supplied_id),
    currency: str(o.currency) ?? "USD",
    lines,
    subtotalCents: subtotal,
    taxCents: int(o.tax),
    tipCents: int(o.tip),
    totalCents: typeof o.total === "number" ? int(o.total) : null,
    fulfillment: o.is_pickup === true ? "pickup" : "delivery",
    scheduledFor: str(o.scheduled_for) ?? null,
    placedAt: str(o.created_at),
    customerName: name || null,
    customerPhone: str(consumer.phone_number),
    notes: str(o.special_instructions),
  };
}

async function bearer(ctx: MarketplaceCallContext) {
  const cfg = getProviderConfig("doordash");
  if (!cfg?.clientId || !cfg.clientSecret) return null;
  // UNVERIFIED token endpoint.
  const token = await fetchClientToken(
    ctx.fetch,
    `${cfg.baseUrl}/marketplace/api/v1/token`,
    cfg.clientId,
    cfg.clientSecret,
  );
  return { token, base: cfg.baseUrl };
}

export const doorDashAdapter: MarketplaceAdapter = {
  key: "doordash",
  docs: "unverified",

  verifyWebhook(req, secret) {
    return verifyBodyHmac(
      req.rawBody,
      req.headers["x-doordash-signature"],
      secret,
    );
  },

  parseWebhook(rawBody): ParsedWebhook {
    const j = parseJson(rawBody);
    if (!j) return { kind: "ignore", reason: "not a JSON object" };
    const type = str(j.event_type) ?? str(j.type) ?? "order.created";
    const id = str(j.id) ?? str(obj(j.order).id);
    if (!id) return { kind: "ignore", reason: "no order id" };
    if (type.includes("cancel"))
      return { kind: "cancel", externalId: id, reason: str(j.reason) };
    if (!type.includes("order"))
      return { kind: "ignore", reason: `event ${type}` };
    return {
      kind: "order",
      order: mapDoorDashOrder(j.order ? obj(j.order) : j),
    };
  },

  async respond(action, order, ctx): Promise<ProviderCallResult> {
    const auth = await bearer(ctx);
    if (!auth)
      return {
        outcome: "skipped",
        detail: "DoorDash credentials are not set.",
      };
    const id = encodeURIComponent(order.externalId);
    const res = await ctx.fetch(
      `${auth.base}/marketplace/api/v1/orders/${id}/${action}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${auth.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(
          action === "reject"
            ? { reason: order.reason ?? "unable_to_fulfil" }
            : {},
        ),
      },
    );
    return res.ok
      ? { outcome: "sent" }
      : {
          outcome: "failed",
          detail: `DoorDash ${action} returned ${res.status}`,
        };
  },

  async syncMenu(): Promise<ProviderCallResult> {
    return {
      outcome: "skipped",
      detail: "menu sync is not implemented for DoorDash",
    };
  },
};
