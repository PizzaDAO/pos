/**
 * Uber Eats adapter (Order API for POS integrations).
 *
 * DOCS STATUS: partly public. From developer.uber.com/docs/eats (as understood;
 * not exercised against a live store because we have no partner access):
 *  - Webhook `orders.notification` carries {event_id, event_type, event_time,
 *    meta:{resource_id, status}, resource_href}, NOT the order. It is signed with
 *    HMAC-SHA256 (hex) of the raw body using the app's client secret, in
 *    `X-Uber-Signature`.
 *  - The order is fetched with GET resource_href using an OAuth2
 *    client-credentials token (scope `eats.order`).
 *  - Accept: POST /v1/delivery/order/{id}/accept_pos_order; deny:
 *    POST /v1/delivery/order/{id}/deny_pos_order; ready:
 *    POST /v1/delivery/order/{id}/ready.
 * UNVERIFIED: the exact order JSON field names below, the money unit of
 * `amount` (treated as minor units), the ready endpoint, and the menu endpoint.
 */
import {
  fetchClientToken,
  int,
  parseJson,
  str,
  verifyBodyHmac,
} from "../crypto";
import { getProviderConfig } from "../env";
import { MarketplaceError } from "../types";
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
/** `{amount, currency_code}` money -> cents (UNVERIFIED unit: minor units). */
const money = (v: unknown): number => int(obj(v).amount);

const AUTH_URL = "https://auth.uber.com/oauth/v2/token";

async function bearer(
  ctx: MarketplaceCallContext,
): Promise<{ token: string; base: string } | null> {
  const cfg = getProviderConfig("ubereats");
  if (!cfg?.clientId || !cfg.clientSecret) return null;
  const token = await fetchClientToken(
    ctx.fetch,
    AUTH_URL,
    cfg.clientId,
    cfg.clientSecret,
    "eats.order",
  );
  return { token, base: cfg.baseUrl };
}

export function mapUberOrder(o: Obj): NormalizedOrder {
  const cart = obj(o.cart);
  const charges = obj(obj(o.payment).charges);
  const eater = obj(o.eater);
  const lines = arr(cart.items).map((it) => {
    const price = obj(it.price);
    const modifiers = arr(it.selected_modifier_groups).flatMap((g) =>
      arr(g.selected_items).map((m) => ({
        name: str(m.title) ?? "Modifier",
        priceCents: money(obj(obj(m.price).unit_price)),
      })),
    );
    return {
      externalItemId: str(it.id) ?? str(it.title) ?? "unknown",
      name: str(it.title) ?? "Item",
      quantity: Math.max(1, int(it.quantity, 1)),
      unitPriceCents: money(price.unit_price),
      modifiers,
      notes: str(it.special_instructions),
    };
  });
  const subtotal =
    int(money(charges.sub_total)) ||
    lines.reduce(
      (n, l) =>
        n +
        (l.unitPriceCents + l.modifiers.reduce((a, m) => a + m.priceCents, 0)) *
          l.quantity,
      0,
    );
  const type = String(o.type ?? "").toUpperCase();
  return {
    provider: "ubereats",
    externalId: str(o.id) ?? "",
    displayId: str(o.display_id),
    storeId: str(obj(o.store).id),
    currency: str(obj(charges.total).currency_code) ?? "USD",
    lines,
    subtotalCents: subtotal,
    taxCents: money(charges.tax),
    tipCents: money(charges.tip),
    totalCents: charges.total ? money(charges.total) : null,
    fulfillment:
      type === "PICK_UP" || type === "DINE_IN" ? "pickup" : "delivery",
    scheduledFor: null,
    placedAt: str(o.placed_at),
    customerName: str(eater.first_name),
    customerPhone: str(eater.phone),
    notes: str(cart.special_instructions),
  };
}

export const uberEatsAdapter: MarketplaceAdapter = {
  key: "ubereats",
  docs: "partly_public",

  verifyWebhook(req, secret) {
    return verifyBodyHmac(req.rawBody, req.headers["x-uber-signature"], secret);
  },

  parseWebhook(rawBody): ParsedWebhook {
    const j = parseJson(rawBody);
    if (!j) return { kind: "ignore", reason: "not a JSON object" };
    const meta = obj(j.meta);
    const externalId = str(meta.resource_id);
    const type = str(j.event_type);
    if (type === "orders.notification" && externalId) {
      return { kind: "order_ref", externalId, href: str(j.resource_href) };
    }
    if (type === "orders.cancel" && externalId) {
      return { kind: "cancel", externalId, reason: str(meta.status) };
    }
    return { kind: "ignore", reason: `event ${type ?? "?"}` };
  },

  async fetchOrder(ref, ctx) {
    const auth = await bearer(ctx);
    if (!auth)
      throw new MarketplaceError(
        "not_configured",
        "Uber Eats credentials are not set.",
      );
    const url =
      ref.href ??
      `${auth.base}/v2/eats/order/${encodeURIComponent(ref.externalId)}`;
    const res = await ctx.fetch(url, {
      headers: { authorization: `Bearer ${auth.token}` },
    });
    if (!res.ok)
      throw new Error(`Uber Eats order fetch failed (${res.status})`);
    const order = mapUberOrder(obj(await res.json()));
    return { ...order, externalId: order.externalId || ref.externalId };
  },

  async respond(action, order, ctx): Promise<ProviderCallResult> {
    const auth = await bearer(ctx);
    if (!auth)
      return {
        outcome: "skipped",
        detail: "Uber Eats credentials are not set.",
      };
    const id = encodeURIComponent(order.externalId);
    const path =
      action === "accept"
        ? `/v1/delivery/order/${id}/accept_pos_order`
        : action === "reject"
          ? `/v1/delivery/order/${id}/deny_pos_order`
          : `/v1/delivery/order/${id}/ready`;
    const body =
      action === "accept"
        ? { reason: "accepted" }
        : action === "reject"
          ? {
              reason: {
                explanation:
                  order.reason ?? "Restaurant cannot fulfil this order",
                code: "OTHER",
              },
            }
          : {};
    const res = await ctx.fetch(`${auth.base}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${auth.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    return res.ok
      ? { outcome: "sent" }
      : {
          outcome: "failed",
          detail: `Uber Eats ${action} returned ${res.status}`,
        };
  },

  async syncMenu(): Promise<ProviderCallResult> {
    // STUB: Uber's menu/item-availability endpoints are not wired.
    return {
      outcome: "skipped",
      detail: "menu sync is not implemented for Uber Eats",
    };
  },
};
