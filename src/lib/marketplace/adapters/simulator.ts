/**
 * Simulator adapter: realistic fake marketplace orders for demos and tests.
 *
 * It speaks its own simple JSON shape (the same one {@link buildSimulatedOrder}
 * emits), signed with HMAC-SHA256 in `x-simulator-signature`, so the whole
 * pipeline (verify -> parse -> map -> accept -> ready) runs end to end with no
 * provider, no keys and no network. Callbacks never leave the process.
 */
import { verifyBodyHmac, hmacSha256Hex, parseJson, str, int } from "../crypto";
import type {
  MarketplaceAdapter,
  NormalizedOrder,
  ParsedWebhook,
  ProviderCallResult,
} from "../types";

export const SIMULATOR_SIGNATURE_HEADER = "x-simulator-signature";

const SAMPLE_MENU: { id: string; name: string; cents: number }[] = [
  { id: "sim-margherita", name: "Margherita Pizza", cents: 1800 },
  { id: "sim-pepperoni", name: "Pepperoni Pizza", cents: 2000 },
  { id: "sim-garlic-knots", name: "Garlic Knots", cents: 700 },
  { id: "sim-caesar", name: "Caesar Salad", cents: 1100 },
  { id: "sim-soda", name: "Soda", cents: 300 },
];
const SAMPLE_NAMES = [
  "Alex R.",
  "Jordan P.",
  "Sam W.",
  "Riley T.",
  "Morgan K.",
];

/** Deterministic-enough demo order. `seed` makes it reproducible in tests. */
export function buildSimulatedOrder(
  seed = Date.now(),
  opts: { storeId?: string | null; externalId?: string } = {},
): Record<string, unknown> {
  const pick = (n: number, salt: number) => Math.abs(seed + salt * 7919) % n;
  const lineCount = 1 + pick(3, 1);
  const lines = Array.from({ length: lineCount }, (_, i) => {
    const m = SAMPLE_MENU[pick(SAMPLE_MENU.length, i + 2)]!;
    return {
      item_id: m.id,
      name: m.name,
      quantity: 1 + pick(2, i + 9),
      unit_price_cents: m.cents,
      modifiers:
        m.id.includes("pizza") && pick(2, i) === 0
          ? [{ name: "Extra cheese", price_cents: 200 }]
          : [],
      notes: null,
    };
  });
  const subtotal = lines.reduce(
    (n, l) =>
      n +
      (l.unit_price_cents +
        l.modifiers.reduce((a, m) => a + m.price_cents, 0)) *
        l.quantity,
    0,
  );
  const tax = Math.round(subtotal * 0.0825);
  const tip = Math.round(subtotal * 0.15);
  return {
    event: "order.created",
    order_id: opts.externalId ?? `SIM-${seed}`,
    display_id: String(1000 + (seed % 9000)),
    store_id: opts.storeId ?? null,
    currency: "USD",
    fulfillment: pick(2, 5) === 0 ? "pickup" : "delivery",
    placed_at: new Date(seed).toISOString(),
    customer: { name: SAMPLE_NAMES[pick(SAMPLE_NAMES.length, 6)], phone: null },
    lines,
    subtotal_cents: subtotal,
    tax_cents: tax,
    tip_cents: tip,
    total_cents: subtotal + tax + tip,
    notes: null,
  };
}

/** Body + signature header for a simulated delivery (what a demo "provider" would POST). */
export function signSimulatedWebhook(
  payload: Record<string, unknown>,
  secret: string,
): { rawBody: string; headers: Record<string, string> } {
  const rawBody = JSON.stringify(payload);
  return {
    rawBody,
    headers: { [SIMULATOR_SIGNATURE_HEADER]: hmacSha256Hex(secret, rawBody) },
  };
}

export const simulatorAdapter: MarketplaceAdapter = {
  key: "simulator",
  docs: "public", // our own format

  verifyWebhook(req, secret) {
    return verifyBodyHmac(
      req.rawBody,
      req.headers[SIMULATOR_SIGNATURE_HEADER],
      secret,
    );
  },

  parseWebhook(rawBody): ParsedWebhook {
    const j = parseJson(rawBody);
    if (!j) return { kind: "ignore", reason: "not a JSON object" };
    const externalId = str(j.order_id);
    if (!externalId) return { kind: "ignore", reason: "no order_id" };
    if (j.event === "order.cancelled") {
      const t =
        typeof j.event_time === "number" ? new Date(j.event_time * 1000) : null;
      return {
        kind: "cancel",
        externalId,
        reason: str(j.reason),
        eventTime: t,
        storeId: str(j.store_id),
      };
    }
    if (j.event !== "order.created")
      return { kind: "ignore", reason: `event ${String(j.event)}` };
    const rawLines = Array.isArray(j.lines)
      ? (j.lines as Record<string, unknown>[])
      : [];
    const customer = (j.customer ?? {}) as Record<string, unknown>;
    const order: NormalizedOrder = {
      provider: "simulator",
      externalId,
      displayId: str(j.display_id),
      storeId: str(j.store_id),
      currency: str(j.currency) ?? "USD",
      lines: rawLines.map((l) => ({
        externalItemId: str(l.item_id) ?? str(l.name) ?? "unknown",
        name: str(l.name) ?? "Item",
        quantity: Math.max(1, int(l.quantity, 1)),
        unitPriceCents: int(l.unit_price_cents),
        modifiers: (Array.isArray(l.modifiers)
          ? (l.modifiers as Record<string, unknown>[])
          : []
        ).map((m) => ({
          name: str(m.name) ?? "Modifier",
          priceCents: int(m.price_cents),
        })),
        notes: str(l.notes),
      })),
      subtotalCents: int(j.subtotal_cents),
      taxCents: int(j.tax_cents),
      tipCents: int(j.tip_cents),
      totalCents: typeof j.total_cents === "number" ? int(j.total_cents) : null,
      fulfillment: j.fulfillment === "pickup" ? "pickup" : "delivery",
      scheduledFor: str(j.scheduled_for),
      placedAt: str(j.placed_at),
      customerName: str(customer.name),
      customerPhone: str(customer.phone),
      notes: str(j.notes),
    };
    return { kind: "order", order };
  },

  async respond(action): Promise<ProviderCallResult> {
    return { outcome: "sent", detail: `simulated ${action}` };
  },

  async syncMenu(items): Promise<ProviderCallResult> {
    return {
      outcome: "sent",
      detail: `simulated menu sync (${items.length} items)`,
    };
  },
};
