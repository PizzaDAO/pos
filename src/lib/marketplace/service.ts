/**
 * Marketplace inbox service: webhook -> verified -> routed -> mapped ->
 * idempotent POS order, plus the accept / reject / ready callbacks.
 *
 * Lifecycle (status + `fulfillment.marketplace.acceptance`):
 *   ingest   status `placed`, acceptance `pending`  (terminal list only; the
 *            kitchen board hides it until accepted)
 *   accept   provider callback FIRST (a failed callback leaves the order pending
 *            and flagged "accept failed at provider", retryable); then ONE
 *            compare-and-set writes status `paid` + acceptance `accepted`
 *   reject   one compare-and-set to `voided` + acceptance `rejected`, then callback
 *   ready    kitchen bump to `ready` -> provider "ready" callback, once
 *   cancel   provider cancel: CAS void only while `placed`/`paid`; past that the
 *            order is flagged (`cancel_requested`), never voided under the cook
 *
 * Routing: the signature is verified with the provider's env secret BEFORE the
 * body is parsed; the tenant/location is then found by the provider's STORE ID
 * in the signed payload (never from the URL). A real provider's payload must
 * name a store id.
 *
 * Payment: the marketplace collects it. These orders carry NO tender; the balance
 * rule returns 0 for channel `marketplace`, every tender path refuses them
 * (marketplace/guard), and with no cash tender they never reach the drawer.
 *
 * Inert by default: ingest requires the location's marketplace settings to be
 * enabled, and callbacks only go out when {@link canCallProvider}.
 */
import { getPosDriver } from "@/lib/db";
import type {
  MarketplaceOrderMeta,
  MarketplaceProviderKey,
  Order,
  OrderFulfillment,
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

/** A provider callback that has not answered in this long is a failure. */
export const PROVIDER_TIMEOUT_MS = 5000;
/** Cancel events older than this are rejected (replay window, where the provider gives a time). */
export const CANCEL_REPLAY_WINDOW_MS = 60 * 60 * 1000;

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

/** The accept callback failed at the provider: still pending, retryable. */
export function isAcceptFailed(
  meta: MarketplaceOrderMeta | null | undefined,
): boolean {
  return (
    meta?.acceptance === "pending" &&
    meta.last_callback?.action === "accept" &&
    meta.last_callback.outcome === "failed"
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
  status: "created" | "duplicate" | "ignored" | "cancelled" | "cancel_flagged";
  orderId?: string;
  accepted?: boolean;
  reason?: string;
}

export interface IngestInput {
  provider: MarketplaceProviderKey;
  rawBody: string;
  /** Lower-cased header names. */
  headers: Record<string, string>;
  /**
   * Trusted internal callers only (the admin simulator button): skip store-id
   * routing. The public webhook route NEVER sets this.
   */
  location?: { tenantId: string; locationId: string };
  fetch?: typeof fetch;
  now?: Date;
}

/** `fetch` with a hard timeout, so a slow provider can never hang the caller. */
function withTimeout(
  f: typeof fetch | undefined,
  ms = PROVIDER_TIMEOUT_MS,
): typeof fetch {
  const base = f ?? fetch;
  return ((input: RequestInfo | URL, init?: RequestInit) =>
    base(input, { ...init, signal: AbortSignal.timeout(ms) })) as typeof fetch;
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
    fetch: withTimeout(f),
  };
}

/** Webhook entry point. Throws {@link MarketplaceError}; routes map it to a status. */
export async function ingestMarketplaceWebhook(
  input: IngestInput,
): Promise<IngestResult> {
  const { provider } = input;
  const driver = getPosDriver();
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

  if (parsed.kind === "cancel" && parsed.eventTime) {
    const age = Math.abs(
      (input.now ?? new Date()).getTime() - parsed.eventTime.getTime(),
    );
    if (age > CANCEL_REPLAY_WINDOW_MS) {
      throw new MarketplaceError(
        "bad_signature",
        "Stale webhook (outside the replay window).",
      );
    }
  }

  // Which provider store is this about? Order references (Uber Eats) and cancels
  // without a store id are resolved by fetching the order (needs API credentials).
  let normalized: NormalizedOrder | null = null;
  let storeId: string | null = null;
  if (parsed.kind === "order") {
    normalized = parsed.order;
    storeId = normalized.storeId;
  } else if (parsed.kind === "cancel") {
    storeId = parsed.storeId ?? null;
  }
  if (
    (parsed.kind === "order_ref" || (parsed.kind === "cancel" && !storeId)) &&
    adapter.fetchOrder &&
    canCallProvider(provider)
  ) {
    const fetched = await adapter.fetchOrder(
      {
        externalId: parsed.externalId,
        href: parsed.kind === "order_ref" ? parsed.href : null,
      },
      {
        tenantId: "",
        locationId: "",
        storeId: null,
        fetch: withTimeout(input.fetch),
      },
    );
    if (parsed.kind === "order_ref") normalized = fetched;
    storeId = fetched.storeId;
  } else if (parsed.kind === "order_ref") {
    throw new MarketplaceError(
      "not_configured",
      `${provider} API credentials are needed to fetch the order.`,
    );
  }

  // A real provider's payload must name its store: it is the tenant binding.
  if (provider !== "simulator" && !storeId) {
    throw new MarketplaceError("bad_payload", "Payload names no store id.");
  }

  let tenantId: string;
  let locationId: string;
  if (input.location) {
    ({ tenantId, locationId } = input.location);
  } else {
    const hits = storeId
      ? await driver.findMarketplaceLocations(provider, storeId)
      : [];
    // Unknown store, or one registered twice: indistinguishable from "disabled".
    if (hits.length !== 1)
      throw new MarketplaceError("disabled", "Not available.");
    tenantId = hits[0]!.tenant_id;
    locationId = hits[0]!.location_id;
  }

  const settings = await driver.getStoreSettings(tenantId, locationId);
  if (!isProviderEnabled(settings, provider)) {
    throw new MarketplaceError("disabled", "Not available.");
  }
  const wantStore = settings.marketplace?.providers[provider]?.store_id ?? null;
  if (provider !== "simulator" && (!wantStore || wantStore !== storeId)) {
    throw new MarketplaceError("disabled", "Not available.");
  }
  if (wantStore && storeId && wantStore !== storeId) {
    return { status: "ignored", reason: "order is for a different store" };
  }

  if (parsed.kind === "cancel") {
    return cancelOrder(
      tenantId,
      locationId,
      provider,
      parsed.externalId,
      parsed.reason,
    );
  }

  if (!normalized || !normalized.externalId) {
    throw new MarketplaceError("bad_payload", "Order has no id.");
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

/** Provider cancel: compare-and-set; never voids an order the kitchen has started. */
async function cancelOrder(
  tenantId: string,
  locationId: string,
  provider: MarketplaceProviderKey,
  externalId: string,
  reason: string | null,
): Promise<IngestResult> {
  const driver = getPosDriver();
  const id = marketplaceOrderId(tenantId, locationId, provider, externalId);
  const existing = await driver.getOrder(id);
  if (!existing || !marketplaceMeta(existing))
    return { status: "ignored", reason: "unknown order" };
  if (existing.status === "voided") return { status: "cancelled", orderId: id };
  const meta = marketplaceMeta(existing)!;
  const voided = await driver.transitionOrderStatus(
    id,
    ["placed", "paid"],
    "voided",
    {
      fulfillment: {
        ...(existing.fulfillment as OrderFulfillment),
        marketplace: {
          ...meta,
          acceptance: "rejected",
          rejected_reason: reason ?? "cancelled by provider",
        },
      },
    },
  );
  if (voided) return { status: "cancelled", orderId: id };
  // Already cooking / ready / done: flag loudly for staff instead.
  const fresh = (await driver.getOrder(id)) ?? existing;
  const freshMeta = marketplaceMeta(fresh) ?? meta;
  if (!freshMeta.cancel_requested) {
    await driver.mergeOrderFulfillment(id, {
      marketplace: {
        ...freshMeta,
        cancel_requested: { at: new Date().toISOString(), reason },
      },
    });
  }
  return { status: "cancel_flagged", orderId: id };
}

/**
 * Record a callback outcome. Re-reads the order and changes ONLY the callback
 * keys, so a stale copy can never overwrite an acceptance written meanwhile.
 */
async function recordCallback(
  orderId: string,
  action: MarketplaceAction,
  result: ProviderCallResult,
): Promise<Order | null> {
  const driver = getPosDriver();
  const fresh = await driver.getOrder(orderId);
  const meta = fresh ? marketplaceMeta(fresh) : null;
  if (!fresh || !meta) return fresh;
  const at = new Date().toISOString();
  const next: MarketplaceOrderMeta = {
    ...meta,
    ...(action === "ready" && result.outcome === "sent" && !meta.ready_sent_at
      ? { ready_sent_at: at }
      : {}),
    last_callback: {
      action,
      at,
      outcome: result.outcome,
      ...(result.detail ? { detail: result.detail } : {}),
    },
  };
  return (
    (await driver.mergeOrderFulfillment(orderId, { marketplace: next })) ??
    fresh
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
  /** The provider refused / timed out on accept: the order stays pending, retry. */
  acceptFailed?: boolean;
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
    // Once is enough: a recall + re-bump must not tell the provider twice.
    if (meta.ready_sent_at)
      return { order, acceptance: "accepted", changed: false, callback: null };
    const callback = await sendCallback(
      order,
      "ready",
      null,
      settings,
      opts.fetch,
    );
    const updated =
      (await recordCallback(order.id, "ready", callback)) ?? order;
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

  const now = new Date().toISOString();
  let callback: ProviderCallResult | null = null;
  if (action === "accept") {
    // Tell the provider first: if it refuses (or times out) the order must NOT
    // reach the kitchen. It stays pending, flagged, and can be retried.
    callback = await sendCallback(order, "accept", null, settings, opts.fetch);
    if (callback.outcome === "failed") {
      const updated =
        (await recordCallback(order.id, "accept", callback)) ?? order;
      return {
        order: updated,
        acceptance: "pending",
        changed: false,
        callback,
        acceptFailed: true,
      };
    }
  }

  const nextMeta: MarketplaceOrderMeta =
    action === "accept"
      ? {
          ...meta,
          acceptance: "accepted",
          accepted_at: now,
          last_callback: {
            action: "accept",
            at: now,
            outcome: callback!.outcome,
            ...(callback!.detail ? { detail: callback!.detail } : {}),
          },
        }
      : {
          ...meta,
          acceptance: "rejected",
          rejected_reason: opts.reason ?? "rejected by restaurant",
        };

  // ONE compare-and-set writes the status AND the acceptance together, so two
  // taps / two tablets cannot both win and the two can never disagree.
  const moved = await driver.transitionOrderStatus(
    order.id,
    ["placed"],
    action === "accept" ? "paid" : "voided",
    {
      fulfillment: {
        ...(order.fulfillment as OrderFulfillment),
        marketplace: nextMeta,
      },
    },
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
  if (action === "reject") {
    callback = await sendCallback(
      moved,
      "reject",
      opts.reason ?? null,
      settings,
      opts.fetch,
    );
    const updated =
      (await recordCallback(moved.id, "reject", callback)) ?? moved;
    return { order: updated, acceptance: target, changed: true, callback };
  }
  return { order: moved, acceptance: target, changed: true, callback };
}

/** Best-effort "ready" callback after a kitchen bump (never throws, sent at most once). */
export async function notifyMarketplaceReady(order: Order): Promise<void> {
  const meta = marketplaceMeta(order);
  if (
    !isMarketplaceOrder(order) ||
    meta?.acceptance !== "accepted" ||
    meta.ready_sent_at
  )
    return;
  try {
    await respondToMarketplaceOrder(order.id, "ready");
  } catch {
    // Kitchen flow must not fail because a provider callback did.
  }
}
