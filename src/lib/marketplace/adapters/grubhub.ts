/**
 * Grubhub adapter (Grubhub Partner / Orders API).
 *
 * DOCS STATUS: UNVERIFIED. Grubhub's partner API docs are not public, so this is
 * a MODEL. Assumptions to confirm with partner access:
 *  - inbound order webhook signed HMAC-SHA256 (hex) over the raw body in
 *    `X-Grubhub-Signature`;
 *  - order JSON: {order_id, order_number, merchant_id, order_type (DELIVERY |
 *    PICKUP), customer{first_name,last_name,phone}, items[]{id,name,quantity,
 *    price,options[]}, subtotal, tax, tip, total, requested_time};
 *  - confirm / reject / ready are POSTs under /orders/{id}/ with an OAuth bearer.
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

export function mapGrubhubOrder(o: Obj): NormalizedOrder {
  const cust = obj(o.customer);
  const lines = arr(o.items).map((it) => ({
    externalItemId: str(it.id) ?? str(it.name) ?? "unknown",
    name: str(it.name) ?? "Item",
    quantity: Math.max(1, int(it.quantity, 1)),
    unitPriceCents: int(it.price),
    modifiers: arr(it.options).map((m) => ({
      name: str(m.name) ?? "Option",
      priceCents: int(m.price),
    })),
    notes: str(it.special_instructions),
  }));
  const subtotal =
    int(o.subtotal) ||
    lines.reduce(
      (n, l) =>
        n +
        (l.unitPriceCents + l.modifiers.reduce((a, m) => a + m.priceCents, 0)) *
          l.quantity,
      0,
    );
  const name = [str(cust.first_name), str(cust.last_name)]
    .filter(Boolean)
    .join(" ");
  return {
    provider: "grubhub",
    externalId: str(o.order_id) ?? "",
    displayId: str(o.order_number),
    storeId: str(o.merchant_id),
    currency: str(o.currency) ?? "USD",
    lines,
    subtotalCents: subtotal,
    taxCents: int(o.tax),
    tipCents: int(o.tip),
    totalCents: typeof o.total === "number" ? int(o.total) : null,
    fulfillment:
      String(o.order_type ?? "").toUpperCase() === "PICKUP"
        ? "pickup"
        : "delivery",
    scheduledFor: str(o.requested_time),
    placedAt: str(o.created_at),
    customerName: name || null,
    customerPhone: str(cust.phone),
    notes: str(o.special_instructions),
  };
}

async function bearer(ctx: MarketplaceCallContext) {
  const cfg = getProviderConfig("grubhub");
  if (!cfg?.clientId || !cfg.clientSecret) return null;
  const token = await fetchClientToken(
    ctx.fetch,
    `${cfg.baseUrl}/auth/token`,
    cfg.clientId,
    cfg.clientSecret,
  );
  return { token, base: cfg.baseUrl };
}

export const grubhubAdapter: MarketplaceAdapter = {
  key: "grubhub",
  docs: "unverified",

  verifyWebhook(req, secret) {
    return verifyBodyHmac(
      req.rawBody,
      req.headers["x-grubhub-signature"],
      secret,
    );
  },

  parseWebhook(rawBody): ParsedWebhook {
    const j = parseJson(rawBody);
    if (!j) return { kind: "ignore", reason: "not a JSON object" };
    const type = str(j.event_type) ?? "order.created";
    const id = str(j.order_id);
    if (!id) return { kind: "ignore", reason: "no order_id" };
    if (type.includes("cancel"))
      return { kind: "cancel", externalId: id, reason: str(j.reason) };
    if (!type.includes("order"))
      return { kind: "ignore", reason: `event ${type}` };
    return { kind: "order", order: mapGrubhubOrder(j) };
  },

  async respond(action, order, ctx): Promise<ProviderCallResult> {
    const auth = await bearer(ctx);
    if (!auth)
      return { outcome: "skipped", detail: "Grubhub credentials are not set." };
    const verb = action === "accept" ? "confirm" : action;
    const res = await ctx.fetch(
      `${auth.base}/orders/${encodeURIComponent(order.externalId)}/${verb}`,
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
          detail: `Grubhub ${action} returned ${res.status}`,
        };
  },

  async syncMenu(): Promise<ProviderCallResult> {
    return {
      outcome: "skipped",
      detail: "menu sync is not implemented for Grubhub",
    };
  },
};
