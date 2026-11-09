/**
 * Marketplace inbox service: webhook -> verified -> mapped -> idempotent POS
 * order, plus the accept / reject / ready callbacks.
 *
 * Lifecycle (status + `fulfillment.marketplace.acceptance`):
 *   ingest   status `placed`, acceptance `pending`  (terminal list only; the
 *            kitchen board hides it until accepted)
 *   accept   status `paid`, acceptance `accepted`   (kitchen board "New")
 *   reject   status `voided`, acceptance `rejected`
 *   ready    kitchen bump to `ready` -> provider "ready" callback
 *
 * Payment: the marketplace collects it. These orders carry NO tender; the balance
 * rule (payments/service `orderBalanceFromPayments`) returns 0 for channel
 * `marketplace`, and because no cash tender exists they never reach the drawer.
 *
 * Inert by default: ingest requires the location's marketplace settings to be
 * enabled, and callbacks only go out when {@link canCallProvider}.
 */
import { getPosDriver } from "@/lib/db";
import type {
  MarketplaceOrderMeta,
  MarketplaceProviderKey,
  Order,
  StoreSettings,
} from "@/lib/db";
import { getAdapter } from "./adapters";
import { canCallProvider, getProviderConfig } from "./env";
import { mapToCreateOrderInput, marketplaceOrderId } from "./mapping";
import {
  MarketplaceError,
  type MarketplaceAction,
  type NormalizedOrder,
  type ProviderCallResult,
} from "./types";

export function isMarketplaceOrder(order: Pick<Order, "channel">): boolean {
  return order.channel === "marketplace";
}

export function marketplaceMeta(order: Order): MarketplaceOrderMeta | null {
  return order.fulfillment?.marketplace ?? null;
}

/** True while an ingested order still needs the cashier to accept or reject it. */
export function isPendingAcceptance(order: Order): boolean {
  return (
    isMarketplaceOrder(order) &&
    marketplaceMeta(order)?.acceptance === "pending"
  );
}

/** Location enablement: master switch AND the provider's own switch. Off by default. */
export function isProviderEnabled(
  settings: Pick<StoreSettings, "marketplace">,
  provider: MarketplaceProviderKey,
): boolean {
  const m = settings.marketplace;
  return !!m?.enabled && !!m.providers[provider]?.enabled;
}

export interface IngestResult {
  status: "created" | "duplicate" | "ignored" | "cancelled";
  orderId?: string;
  accepted?: boolean;
  reason?: string;
}

export interface IngestInput {
  provider: MarketplaceProviderKey;
  tenantId: string;
  locationId: string;
  rawBody: string;
  /** Lower-cased header names. */
  headers: Record<string, string>;
  fetch?: typeof fetch;
  now?: Date;
}

function callCtx(
  settings: StoreSettings,
  provider: MarketplaceProviderKey,
  o: Order,
  f?: typeof fetch,
) {
  return {
    tenantId: o.tenant_id,
    locationId: o.location_id,
    storeId: settings.marketplace?.providers[provider]?.store_id ?? null,
    fetch: f ?? fetch,
  };
}

/** Webhook entry point. Throws {@link MarketplaceError}; routes map it to a status. */
export async function ingestMarketplaceWebhook(
  input: IngestInput,
): Promise<IngestResult> {
  const { provider, tenantId, locationId } = input;
  const driver = getPosDriver();
  const settings = await driver.getStoreSettings(tenantId, locationId);
  if (!isProviderEnabled(settings, provider)) {
    throw new MarketplaceError(
      "disabled",
      `${provider} is not enabled for this location.`,
    );
  }
  const config = getProviderConfig(provider);
  if (!config) {
    throw new MarketplaceError(
      "not_configured",
      `${provider} credentials are not configured.`,
    );
  }
  const adapter = getAdapter(provider);
  // Verify BEFORE parsing or touching the DB with anything the sender supplied.
  if (
    !adapter.verifyWebhook(
      { rawBody: input.rawBody, headers: input.headers, now: input.now },
      config.webhookSecret,
    )
  ) {
    throw new MarketplaceError("bad_signature", "Invalid webhook signature.");
  }

  const parsed = adapter.parseWebhook(input.rawBody);
  if (parsed.kind === "ignore")
    return { status: "ignored", reason: parsed.reason };

  if (parsed.kind === "cancel") {
    const id = marketplaceOrderId(
      tenantId,
      locationId,
      provider,
      parsed.externalId,
    );
    const existing = await driver.getOrder(id);
    if (!existing) return { status: "ignored", reason: "unknown order" };
    if (existing.status === "voided")
      return { status: "cancelled", orderId: id };
    await driver.updateOrderStatus(id, "voided");
    const meta = marketplaceMeta(existing);
    if (meta) {
      await driver.mergeOrderFulfillment(id, {
        marketplace: {
          ...meta,
          acceptance: "rejected",
          rejected_reason: parsed.reason ?? "cancelled by provider",
        },
      });
    }
    return { status: "cancelled", orderId: id };
  }

  let normalized: NormalizedOrder;
  if (parsed.kind === "order_ref") {
    if (!adapter.fetchOrder || !canCallProvider(provider)) {
      throw new MarketplaceError(
        "not_configured",
        `${provider} API credentials are needed to fetch the order.`,
      );
    }
    normalized = await adapter.fetchOrder(parsed, {
      tenantId,
      locationId,
      storeId: settings.marketplace?.providers[provider]?.store_id ?? null,
      fetch: input.fetch ?? fetch,
    });
  } else {
    normalized = parsed.order;
  }
  if (!normalized.externalId)
    throw new MarketplaceError("bad_payload", "Order has no id.");

  // A validly signed order for ANOTHER store must not land in this location.
  const wantStore = settings.marketplace?.providers[provider]?.store_id;
  if (wantStore && normalized.storeId && normalized.storeId !== wantStore) {
    return { status: "ignored", reason: "order is for a different store" };
  }

  const create = mapToCreateOrderInput(normalized, {
    tenantId,
    locationId,
    now: input.now,
  });
  const existing = await driver.getOrder(create.id);
  if (existing) return { status: "duplicate", orderId: existing.id };

  let order: Order;
  try {
    order = await driver.createOrder(create);
  } catch (err) {
    // Concurrent delivery of the same order lost the insert race (unique index):
    // treat it as the duplicate it is.
    const raced = await driver.getOrder(create.id);
    if (!raced) throw err;
    return { status: "duplicate", orderId: raced.id };
  }

  if (settings.marketplace?.auto_accept) {
    const accepted = await respondToMarketplaceOrder(order.id, "accept", {
      fetch: input.fetch,
      settings,
    });
    return {
      status: "created",
      orderId: order.id,
      accepted: accepted.acceptance === "accepted",
    };
  }
  return { status: "created", orderId: order.id, accepted: false };
}

async function recordCallback(
  order: Order,
  action: MarketplaceAction,
  result: ProviderCallResult,
  patch: Partial<MarketplaceOrderMeta> = {},
): Promise<Order> {
  const meta = marketplaceMeta(order)!;
  const next: MarketplaceOrderMeta = {
    ...meta,
    ...patch,
    last_callback: {
      action,
      at: new Date().toISOString(),
      outcome: result.outcome,
      ...(result.detail ? { detail: result.detail } : {}),
    },
  };
  return (
    (await getPosDriver().mergeOrderFulfillment(order.id, {
      marketplace: next,
    })) ?? order
  );
}

async function sendCallback(
  order: Order,
  action: MarketplaceAction,
  reason: string | null,
  settings: StoreSettings,
  f?: typeof fetch,
): Promise<ProviderCallResult> {
  const meta = marketplaceMeta(order)!;
  const adapter = getAdapter(meta.provider);
  // The simulator answers in-process; a real provider only when fully configured.
  if (meta.provider !== "simulator" && !canCallProvider(meta.provider)) {
    return {
      outcome: "skipped",
      detail: "provider API credentials are not configured",
    };
  }
  try {
    return await adapter.respond(
      action,
      { externalId: meta.external_id, reason },
      callCtx(settings, meta.provider, order, f),
    );
  } catch (err) {
    return {
      outcome: "failed",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface RespondResult {
  order: Order;
  acceptance: MarketplaceOrderMeta["acceptance"];
  changed: boolean;
  callback: ProviderCallResult | null;
}

/**
 * Accept / reject a pending order, or tell the provider it is ready. Idempotent:
 * repeating an accept on an accepted order (or a reject on a rejected one) is a
 * no-op; a conflicting transition is `invalid_state`.
 */
export async function respondToMarketplaceOrder(
  orderId: string,
  action: MarketplaceAction,
  opts: {
    reason?: string | null;
    fetch?: typeof fetch;
    settings?: StoreSettings;
  } = {},
): Promise<RespondResult> {
  const driver = getPosDriver();
  const order = await driver.getOrder(orderId);
  if (!order || !isMarketplaceOrder(order) || !marketplaceMeta(order)) {
    throw new MarketplaceError("not_found", "Marketplace order not found.");
  }
  const meta = marketplaceMeta(order)!;
  const settings =
    opts.settings ??
    (await driver.getStoreSettings(order.tenant_id, order.location_id));

  if (action === "ready") {
    if (meta.acceptance !== "accepted") {
      throw new MarketplaceError(
        "invalid_state",
        "Only an accepted order can be marked ready.",
      );
    }
    const callback = await sendCallback(
      order,
      "ready",
      null,
      settings,
      opts.fetch,
    );
    const updated = await recordCallback(order, "ready", callback);
    return { order: updated, acceptance: "accepted", changed: false, callback };
  }

  const target = action === "accept" ? "accepted" : "rejected";
  if (meta.acceptance === target) {
    return { order, acceptance: target, changed: false, callback: null };
  }
  if (meta.acceptance !== "pending") {
    throw new MarketplaceError(
      "invalid_state",
      `Order is already ${meta.acceptance}.`,
    );
  }

  // Compare-and-set so two taps / two tablets cannot both win.
  const moved = await driver.transitionOrderStatus(
    order.id,
    ["placed"],
    action === "accept" ? "paid" : "voided",
  );
  if (!moved) {
    const fresh = await driver.getOrder(order.id);
    if (fresh && marketplaceMeta(fresh)?.acceptance === target) {
      return {
        order: fresh,
        acceptance: target,
        changed: false,
        callback: null,
      };
    }
    throw new MarketplaceError(
      "invalid_state",
      "Order changed; refresh and try again.",
    );
  }
  const callback = await sendCallback(
    moved,
    action,
    opts.reason ?? null,
    settings,
    opts.fetch,
  );
  const now = new Date().toISOString();
  const updated = await recordCallback(
    moved,
    action,
    callback,
    action === "accept"
      ? { acceptance: "accepted", accepted_at: now }
      : {
          acceptance: "rejected",
          rejected_reason: opts.reason ?? "rejected by restaurant",
        },
  );
  return { order: updated, acceptance: target, changed: true, callback };
}

/** Best-effort "ready" callback after a kitchen bump (never throws). */
export async function notifyMarketplaceReady(order: Order): Promise<void> {
  if (
    !isMarketplaceOrder(order) ||
    marketplaceMeta(order)?.acceptance !== "accepted"
  )
    return;
  try {
    await respondToMarketplaceOrder(order.id, "ready");
  } catch {
    // Kitchen flow must not fail because a provider callback did.
  }
}
