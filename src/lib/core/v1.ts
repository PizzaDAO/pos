/**
 * Open Pizza `/v1` API served by POS at `/api/v1/*`.
 *
 * One router for every operation in `V1_ROUTES` (method + path + required scopes
 * come from the contract package, so POS cannot drift from it). Pipeline per
 * request: authenticate bearer JWT -> tenant from claims -> scope check ->
 * handler -> contract-shaped JSON (or RFC 9457 problem+json). Handlers read via
 * the `PosDriver` and map rows with `./mappers`; they never trust a tenant id
 * from the client, and ids outside the token's tenant answer NOT_FOUND.
 *
 * Implemented: tenant, capabilities, entitlements, locations, menu (+86),
 * quotes (stored; create/get, and `orders.create{quote_id}` re-prices them),
 * orders (list/get/create held/cancel/release/extend hold), payments (read, plus
 * hosted payment sessions, the payments account and `recordExternal`), customers
 * (read + `upsert`), staff (read, `verifyPin`, `setPin`), drawer sessions,
 * deliveries (read), sales.
 * Declared but unsupported by POS answer 501 CAPABILITY_UNSUPPORTED:
 * orders.updateStatus, deliveries.updateStatus, events.list (events go out by
 * webhook).
 * `staff.verifyPin` is a HUB_ROUTES operation: it is added to the route table by
 * hand (EXTRA_ROUTES).
 *
 * Payment sessions are the ONLY /v1 path that can reach Stripe. They are gated on
 * the server (`assertSessionChargeAllowed` in payment-sessions.ts): simulated
 * mode or a positively identified Stripe TEST key only; live keys answer 501
 * unless the tenant is explicitly allow-listed.
 */
import {
  AvailabilityUpdateSchema,
  CustomerUpsertInputSchema,
  EVENT_TYPES,
  ExternalTenderInputSchema,
  HUB_ROUTES,
  OrderCancelInputSchema,
  OrderCreateInputSchema,
  OrderHoldExtendInputSchema,
  OrderListQuerySchema,
  PROBLEM_CONTENT_TYPE,
  PaymentSessionCreateInputSchema,
  ProblemError,
  QuoteRequestSchema,
  SalesSummaryQuerySchema,
  StaffPinSetInputSchema,
  StaffPinVerifyInputSchema,
  V1_ROUTES,
  checkTenderAmounts,
  extendedHoldExpiry,
  hasScopes,
  holdCapSeconds,
  isProblemError,
  priceCart,
  problem,
  requireLocation,
  requireScopes,
  uuidv5,
  type Capabilities,
  type Entitlements,
  type Order as CoreOrder,
  type Principal,
  type Problem,
  type QuoteRequest,
  type V1Operation,
} from "@openpizza/core";
import type { ZodError } from "zod";
import {
  getPosDriver,
  type CreateOrderInput,
  type Payment,
  type PosDriver,
  type OrderFulfillment,
} from "@/lib/db";
import type { StoredQuote } from "@/lib/db/payment-types";
import { deploymentCheckoutMode } from "@/lib/payments/env";
import { isGuid, isIsoTimestamp } from "@/lib/db/paging";
import { cancelDeliveryForOrder } from "@/lib/delivery/service";
import { captureError } from "@/lib/observability";
import {
  cancelOpenOnlineIntents,
  orderDueCents,
  settleOrderAfterExternalTender,
} from "@/lib/payments/service";
import { priceOrder } from "@/lib/order-pricing";
import { RepriceError, maxTipCents } from "@/lib/reprice";
import { getPlan } from "@/lib/saas/plans";
import { canUseOnlineOrdering, resolveEntitlements } from "@/lib/saas/entitlements";
import { authenticateV1, isSimulatedV1, type AuthDeps } from "./auth";
import {
  NO_STATS,
  tenantCountry,
  loadCustomer,
  loadDelivery,
  loadDrawerSessions,
  loadLocation,
  loadLocations,
  loadMenu,
  loadOrder,
  loadOrdersPage,
  loadPayment,
  loadStaffList,
  loadTenantOrders,
  mapOrder,
  type LocationBundle,
} from "./loaders";
import {
  toContractCustomer,
  toContractPayment,
  toContractStaff,
  toContractTenant,
} from "./mappers";
import { phoneKey } from "@/lib/db/customer-identity";
import type { CustomerConsent } from "@/lib/db";
import { hashPin, verifyPin } from "@/lib/auth/pin";
import { tenderFingerprint } from "@/lib/db/payment-types";
import { netSettledBaseCents } from "./money";
import {
  createPaymentSession,
  getPaymentsAccount,
  loadPaymentSession,
  toContractSession,
} from "./payment-sessions";
import { buildDailySales, buildSalesSummary, isSalesRow } from "./sales";

export interface V1Deps {
  auth?: AuthDeps;
  driver?: PosDriver;
  now?: () => Date;
  /** Pre-authenticated principal (tests / internal callers). */
  principal?: Principal;
}

/** Narrow kiosk scope: record captured card-terminal tenders only. */
export const TERMINAL_PAYMENT_SCOPE = "payments.terminal:write";

interface Ctx {
  /**
   * True when the caller holds `payments.terminal:write` but NOT the route's
   * `payments:write` (a kiosk): the recordExternal handler then allows only a
   * captured `collection: "terminal"` tender.
   */
  terminalOnly?: boolean;
  req: Request;
  url: URL;
  params: Record<string, string>;
  principal: Principal;
  driver: PosDriver;
  now: () => Date;
  requestId: string;
}

interface Reply {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

type Handler = (ctx: Ctx) => Promise<Reply>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function zodProblem(err: ZodError, detail = "Request is invalid."): ProblemError {
  return ProblemError.of("VALIDATION_FAILED", {
    detail,
    errors: err.issues.map((i) =>
      problem("VALIDATION_FAILED", {
        path: i.path.map(String).join("."),
        detail: i.message,
      }),
    ),
  });
}

const MAX_BODY_BYTES = 256_000;

/** Read the JSON body, aborting as soon as the byte budget is exceeded. */
async function readBody(req: Request): Promise<unknown> {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) {
    throw ProblemError.of("VALIDATION_FAILED", { detail: "Body too large.", status: 413 });
  }
  let text = "";
  if (req.body) {
    const reader = req.body.getReader();
    const decoder = new TextDecoder();
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw ProblemError.of("VALIDATION_FAILED", { detail: "Body too large.", status: 413 });
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  }
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw ProblemError.of("VALIDATION_FAILED", { detail: "Body is not valid JSON." });
  }
}

/**
 * Custom fee / gratuity lines (core 0.3.x `fees`) are priced by `priceCart` but
 * POS order creation cannot store them, so accepting them would quote one total
 * and charge another. Refuse until POS supports them.
 */
function rejectFees(fees: unknown[] | undefined): void {
  if (fees && fees.length > 0) {
    throw ProblemError.of("VALIDATION_FAILED", {
      detail:
        "POS does not support custom fee lines (`fees`) yet; remove them from the request.",
      path: "fees",
    });
  }
}

function notFound(what: string): ProblemError {
  return ProblemError.of("NOT_FOUND", { detail: `${what} not found.` });
}

function unsupported(op: string, detail?: string): ProblemError {
  return ProblemError.of("CAPABILITY_UNSUPPORTED", {
    detail: detail ?? `${op} is not supported by Open Pizza POS.`,
  });
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

function encodeCursor(ts: string, id: string): string {
  return Buffer.from(JSON.stringify([ts, id])).toString("base64url");
}

function decodeCursor(c: string): [string, string] {
  try {
    const v = JSON.parse(Buffer.from(c, "base64url").toString("utf8"));
    if (Array.isArray(v) && isIsoTimestamp(v[0]) && isGuid(v[1])) {
      return [v[0], v[1]];
    }
  } catch {
    /* fallthrough */
  }
  throw ProblemError.of("VALIDATION_FAILED", { detail: "Invalid cursor." });
}

export { netSettledBaseCents };

/**
 * Keyset pagination over items sorted by (created_at, id) ascending, with the
 * contract's `updated_since` / `created_since` filters.
 */
export function pageItems<T extends { id: string; created_at: string; updated_at?: string }>(
  items: T[],
  q: URLSearchParams,
): { data: T[]; next_cursor: string | null } {
  const limitRaw = q.get("limit");
  const limit = limitRaw ? Number(limitRaw) : DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw ProblemError.of("VALIDATION_FAILED", {
      detail: `limit must be an integer 1..${MAX_LIMIT}.`,
    });
  }
  let rows = [...items].sort(
    (a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id),
  );
  const updatedSince = q.get("updated_since");
  if (updatedSince) {
    rows = rows.filter((r) => (r.updated_at ?? r.created_at) >= updatedSince);
  }
  const createdSince = q.get("created_since");
  if (createdSince) rows = rows.filter((r) => r.created_at >= createdSince);
  const cursor = q.get("cursor");
  if (cursor) {
    const [ts, id] = decodeCursor(cursor);
    rows = rows.filter(
      (r) => r.created_at > ts || (r.created_at === ts && r.id > id),
    );
  }
  const data = rows.slice(0, limit);
  const last = data[data.length - 1];
  return {
    data,
    next_cursor: rows.length > limit && last ? encodeCursor(last.created_at, last.id) : null,
  };
}

function allowedLocation(p: Principal, locationId: string): boolean {
  return !p.location_ids || p.location_ids.includes(locationId);
}

function scopedLocationIds(p: Principal): string[] | null {
  return p.location_ids;
}

/** Suspended / cancelled tenants may not write through /v1. */
async function requireActiveTenant(ctx: Ctx): Promise<void> {
  const tenant = await ctx.driver.getTenant(ctx.principal.tenant_id);
  if (!tenant || tenant.status !== "active") {
    throw ProblemError.of("FORBIDDEN", { detail: "This tenant is not active; writes are disabled." });
  }
}

/**
 * A "terminal" principal may take counter orders directly and bypass nothing
 * else. Everyone else (agents, kiosks, guests, integrations) places held orders
 * and is subject to plan gating and store hours.
 */
function isTerminal(p: Principal): boolean {
  return hasLiteralScope(p, "orders:place_direct");
}

/**
 * Powerful, order-money scopes (`orders:discount`, `orders:place_direct`,
 * `orders:release_unpaid`) must be granted by NAME: `*`, `orders:*` and
 * `*:write` do not imply them.
 */
export const LITERAL_SCOPES = [
  "customers:verify",
  "orders:discount",
  "orders:place_direct",
  "orders:release_unpaid",
] as const;

function hasLiteralScope(p: Pick<Principal, "scopes">, scope: (typeof LITERAL_SCOPES)[number]): boolean {
  return p.scopes.includes(scope);
}

async function ownedLocation(ctx: Ctx, locationId: string): Promise<LocationBundle> {
  const b = await loadLocation(ctx.principal.tenant_id, locationId, ctx.driver);
  if (!b) throw notFound("Location");
  // A token limited to other locations must not learn this one exists.
  if (!allowedLocation(ctx.principal, locationId)) throw notFound("Location");
  return b;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/** Event types POS actually emits (the outbox triggers + mock-events); nothing else is advertised. */
const POS_EMITTED_EVENTS: readonly string[] = [
  "order.placed",
  "order.updated",
  "order.status_changed",
  "order.ready",
  "order.completed",
  "order.canceled",
  "payment.authorized",
  "payment.captured",
  "payment.failed",
  "payment.refunded",
  "menu.updated",
  "menu.item.unavailable",
  "menu.item.available",
  "location.updated",
  "customer.created",
  "customer.updated",
  "staff.created",
  "staff.updated",
  "staff.deactivated",
  "drawer_session.opened",
  "drawer_session.closed",
  "business_day.closed",
  "delivery.status_changed",
];
const POS_EVENTS = EVENT_TYPES.filter((t) => POS_EMITTED_EVENTS.includes(t));

const handlers: Partial<Record<V1Operation | ExtraOperation, Handler>> = {
  "tenant.get": async (ctx) => {
    const tenant = await ctx.driver.getTenant(ctx.principal.tenant_id);
    if (!tenant) throw notFound("Tenant");
    const first = (await loadLocations(tenant.id, ctx.driver))[0];
    return {
      body: toContractTenant(
        tenant,
        first
          ? { timezone: first.location.timezone, currency: first.settings.currency }
          : null,
      ),
    };
  },

  "capabilities.get": async () => {
    const caps: Capabilities = {
      source: "openpizza_pos",
      features: {
        "orders.write": true,
        "orders.cancel": true,
        "orders.hold": true,
        quotes: true,
        "menu.write": false,
        "menu.availability.write": true,
        "menu.half_placement": true,
        "customers.write": true,
        "payments.external_tender": true,
        "deliveries.write": false,
        "sales.summary": true,
        drawer_sessions: true,
        webhooks: true,
      },
      events: [...POS_EVENTS],
      payment_modes: ["prepaid", "pay_at_counter"],
      notes: [
        "Delivery orders cannot be created through /v1 yet; use pickup/dine_in.",
        "Quotes are stored for 10 minutes: POST /orders accepts quote_id (no lines) and re-prices it; send quote_hash to detect price changes.",
        "Payment sessions are Stripe Checkout (card only) on the tenant's connected account; sessions expire no sooner than 31 minutes (Stripe's minimum) and the hold is extended to cover them.",
        "Order status transitions are driven by the KDS/terminal, not /v1.",
      ],
    };
    return { body: caps };
  },

  "entitlements.get": async (ctx) => {
    const tenantId = ctx.principal.tenant_id;
    const [sub, settings] = await Promise.all([
      ctx.driver.getSubscription(tenantId),
      ctx.driver.getTenantSettings(tenantId),
    ]);
    const ent = resolveEntitlements(sub);
    const lim = (n: number) => (Number.isFinite(n) ? n : null);
    const plan = getPlan(ent.tier);
    const body: Entitlements = {
      tenant_id: tenantId,
      modules: {
        pos: {
          status: !ent.active ? "suspended" : sub?.status === "trialing" ? "trial" : "enabled",
          source: "plan",
          plan_ref: plan.stripe_price_id ?? ent.tier,
          limits: {},
          config: { inventory_owner: settings.inventory_owner },
          enabled_at: sub ? new Date(sub.created_at).toISOString() : null,
          trial_ends_at: null,
        },
      },
      pos: {
        tier: ent.tier,
        max_locations: lim(ent.entitlements.max_locations),
        online_ordering: ent.entitlements.online_ordering,
        advanced_reports: ent.entitlements.advanced_reports,
        delivery: ent.entitlements.delivery,
        max_staff: lim(ent.entitlements.max_staff),
      },
      as_of: ctx.now().toISOString(),
    };
    return { body };
  },

  "locations.list": async (ctx) => {
    const ids = scopedLocationIds(ctx.principal);
    const all = (await loadLocations(ctx.principal.tenant_id, ctx.driver))
      .filter((b) => !ids || ids.includes(b.location.id))
      .map((b) => b.contract);
    return { body: pageItems(all, ctx.url.searchParams) };
  },

  "locations.get": async (ctx) => ({
    body: (await ownedLocation(ctx, ctx.params.location_id!)).contract,
  }),

  "menu.get": async (ctx) => {
    const bundle = await ownedLocation(ctx, ctx.params.location_id!);
    const menu = await loadMenu(bundle, ctx.driver);
    const etag = `"${menu.version}"`;
    if (ctx.req.headers.get("if-none-match") === etag) {
      return { status: 304, headers: { etag } };
    }
    return { body: menu, headers: { etag } };
  },

  "menu.setAvailability": async (ctx) => {
    await requireActiveTenant(ctx);
    const bundle = await ownedLocation(ctx, ctx.params.location_id!);
    const parsed = AvailabilityUpdateSchema.safeParse(await readBody(ctx.req));
    if (!parsed.success) throw zodProblem(parsed.error);
    const u = parsed.data;
    const kind = u.target_type === "item" ? "item" : u.target_type === "size" ? "size" : "modifier";
    // The service-role driver bypasses RLS: the tenant check IS the boundary.
    const owner = await ctx.driver.getMenuEntityTenant(kind, u.target_id);
    if (owner !== ctx.principal.tenant_id) {
      throw ProblemError.of("ITEM_NOT_FOUND", {
        detail: `${u.target_type} ${u.target_id} is not on this tenant's menu.`,
        path: "target_id",
      });
    }
    await ctx.driver.upsertOverride({
      tenant_id: ctx.principal.tenant_id,
      location_id: bundle.location.id,
      target_type: u.target_type,
      target_id: u.target_id,
      // true clears the 86 flag back to "inherit" (price override is untouched).
      available: u.available ? null : false,
    });
    return {
      body: {
        location_id: bundle.location.id,
        target_type: u.target_type,
        target_id: u.target_id,
        availability: u.available
          ? { available: true }
          : { available: false, reason: u.reason ?? "86" },
      },
    };
  },

  "quotes.create": async (ctx) => {
    const parsed = QuoteRequestSchema.safeParse(await readBody(ctx.req));
    if (!parsed.success) throw zodProblem(parsed.error);
    rejectFees(parsed.data.fees);
    const bundle = await ownedLocation(ctx, parsed.data.location_id);
    const menu = await loadMenu(bundle, ctx.driver);
    const quote = priceCart({
      menu,
      location: bundle.contract,
      request: parsed.data,
      now: ctx.now(),
      // In-store terminals bypass hours; everything else is gated.
      checkHours: true,
    });
    // Persist a VALID quote so `quotes.get` and `orders.create{quote_id}` can
    // reload and re-price it. Only the request is kept; money is always re-derived.
    if (quote.valid) {
      await ctx.driver.saveQuote({
        id: quote.id,
        tenant_id: ctx.principal.tenant_id,
        location_id: bundle.location.id,
        request: parsed.data as unknown as Record<string, unknown>,
        quote_hash: quote.quote_hash,
        expires_at: quote.expires_at,
        created_at: quote.created_at,
      });
    }
    return { body: quote };
  },

  // Reload the stored request and RE-PRICE it now: the returned quote has the
  // original id, but live prices, availability and expiry (an expired quote is
  // 409 QUOTE_EXPIRED; a foreign or unknown id is 404 QUOTE_NOT_FOUND).
  "quotes.get": async (ctx) => {
    const stored = await loadStoredQuote(ctx, ctx.params.quote_id!);
    const bundle = await ownedLocation(ctx, stored.location_id);
    const menu = await loadMenu(bundle, ctx.driver);
    const quote = priceCart({
      menu,
      location: bundle.contract,
      request: stored.request as unknown as QuoteRequest,
      now: ctx.now(),
      checkHours: true,
      quoteId: stored.id,
    });
    // Same id, live prices; the validity window stays the original one.
    return {
      body: { ...quote, created_at: stored.created_at, expires_at: stored.expires_at },
    };
  },

  "orders.list": async (ctx) => {
    const q = ctx.url.searchParams;
    const raw: Record<string, unknown> = {};
    for (const [k, v] of q.entries()) {
      if (k === "limit") raw[k] = Number(v);
      else if (["fulfillment_status", "payment_status", "channel"].includes(k)) {
        raw[k] = v.split(",").filter(Boolean);
      } else raw[k] = v;
    }
    const parsed = OrderListQuerySchema.safeParse(raw);
    if (!parsed.success) throw zodProblem(parsed.error);
    const f = parsed.data;
    if (f.location_id) await ownedLocation(ctx, f.location_id);
    const ids = f.location_id ? [f.location_id] : scopedLocationIds(ctx.principal);
    const limit = f.limit ?? DEFAULT_LIMIT;
    const cursor = f.cursor ? decodeCursor(f.cursor) : null;
    // business_date is location-local: pad the UTC created_at range by a day.
    const padDay = (d: string, days: number) =>
      new Date(new Date(`${d}T00:00:00Z`).getTime() + days * 86_400_000).toISOString();
    const { rows, resume } = await loadOrdersPage(ctx.principal.tenant_id, {
      locationIds: ids,
      limit,
      after: cursor ? { created_at: cursor[0], id: cursor[1] } : undefined,
      createdFrom: f.created_since ?? (f.business_date_from ? padDay(f.business_date_from, -1) : undefined),
      createdTo: f.business_date_to ? padDay(f.business_date_to, 2) : undefined,
      updatedSince: f.updated_since,
      driver: ctx.driver,
      filter: (o) =>
        (!f.fulfillment_status || f.fulfillment_status.includes(o.fulfillment_status)) &&
        (!f.payment_status || f.payment_status.includes(o.payment_status)) &&
        (!f.channel || f.channel.includes(o.channel)) &&
        (!f.customer_id || o.customer_id === f.customer_id) &&
        (!f.business_date_from || o.business_date >= f.business_date_from) &&
        (!f.business_date_to || o.business_date <= f.business_date_to),
    });
    const data = rows.slice(0, limit);
    const last = data[data.length - 1];
    // More rows than a page => resume after the last returned row. Otherwise, if the
    // bounded scan stopped early, resume from where it stopped (never report "done"
    // for a scan that was merely cut short).
    const next_cursor =
      rows.length > limit && last
        ? encodeCursor(last.created_at, last.id)
        : resume
          ? encodeCursor(resume.created_at, resume.id)
          : null;
    return { body: { data, next_cursor } };
  },

  "orders.get": async (ctx) => {
    const order = await loadOrder(ctx.principal.tenant_id, ctx.params.order_id!, ctx.driver);
    if (!order || !allowedLocation(ctx.principal, order.location_id)) throw notFound("Order");
    return { body: order };
  },

  "orders.create": createOrder,

  "orders.cancel": async (ctx) => {
    await requireActiveTenant(ctx);
    const order = await ownedOrder(ctx, ctx.params.order_id!);
    const parsed = OrderCancelInputSchema.safeParse(await readBody(ctx.req));
    if (!parsed.success) throw zodProblem(parsed.error);
    if (order.status === "voided") {
      return { body: await mapOrderFor(ctx, order.id) };
    }
    if (order.status !== "draft" && order.status !== "placed" && order.status !== "paid") {
      throw ProblemError.of("CANCEL_NOT_ALLOWED", {
        detail: `Order is ${order.status}; it can no longer be canceled here.`,
      });
    }
    // Same order of steps as main's storefront cancel
    // (src/app/api/shop/orders/cancel/route.ts): close any open card intent
    // first so it cannot be confirmed after the void. If one turns out to have
    // succeeded, that syncs the tender, so re-check before canceling.
    try {
      await cancelOpenOnlineIntents(order.id);
    } catch (err) {
      captureError(err, { scope: "v1.orders.cancel.intents", orderId: order.id });
      throw ProblemError.of("UPSTREAM_UNAVAILABLE", {
        detail: "Could not close the order's open card payment; try again.",
      });
    }
    const tenders = await ctx.driver.listPaymentsForOrder(order.id);
    if (tenders.some((p) => p.status === "authorized")) {
      throw ProblemError.of("CANCEL_NOT_ALLOWED", {
        detail: "Order has payments in flight; wait for them to settle or void them first.",
      });
    }
    if (
      tenders.some(
        (p) => p.status === "captured" && p.amount_cents + p.tip_cents > p.refunded_cents,
      )
    ) {
      throw ProblemError.of("CANCEL_NOT_ALLOWED", {
        detail: "Order has captured payments; refund them first.",
      });
    }
    // Tender check + status transition happen atomically under a row lock
    // (core_cancel_order): a payment cannot slip in between the two.
    const res = await ctx.driver.cancelOrder(order.id, ctx.principal.tenant_id, {
      nowMs: ctx.now().getTime(),
    });
    if (res.ok) {
      // A voided order must not keep a courier on the way. A provider error
      // does not undo the cancel (the order IS voided); it is surfaced.
      try {
        await cancelDeliveryForOrder(order.id);
      } catch (err) {
        captureError(err, { scope: "v1.orders.cancel.delivery", orderId: order.id });
      }
    }
    if (!res.ok) {
      if (res.reason === "not_found") throw notFound("Order");
      throw ProblemError.of("CANCEL_NOT_ALLOWED", {
        detail:
          res.reason === "in_flight"
            ? "Order has payments in flight; wait for them to settle or void them first."
            : res.reason === "captured"
              ? "Order has captured payments; refund them first."
              : `Order is ${res.order.status}; it can no longer be canceled here.`,
      });
    }
    return { body: await mapOrderFor(ctx, order.id) };
  },

  "orders.release": async (ctx) => {
    await requireActiveTenant(ctx);
    const order = await ownedOrder(ctx, ctx.params.order_id!);
    if (order.status !== "draft") {
      if (order.status === "voided") {
        throw ProblemError.of("INVALID_TRANSITION", { detail: "Order was canceled." });
      }
      // Already released: idempotent.
      return { body: await mapOrderFor(ctx, order.id) };
    }
    const expires = order.hold?.expires_at;
    if (expires && new Date(expires).getTime() <= ctx.now().getTime()) {
      // Void it the same way cancel does: close any open card session/intent on
      // the provider FIRST (an open Checkout link must not outlive the order),
      // then void atomically against the tender state.
      try {
        await cancelOpenOnlineIntents(order.id);
      } catch (err) {
        captureError(err, { scope: "v1.orders.release.intents", orderId: order.id });
        throw ProblemError.of("UPSTREAM_UNAVAILABLE", {
          status: 503,
          detail: "The hold expired but its open card payment could not be closed; try again.",
        });
      }
      const voided = await ctx.driver.cancelOrder(order.id, ctx.principal.tenant_id, {
        nowMs: ctx.now().getTime(),
      });
      if (!voided.ok) {
        // Paid or in flight meanwhile: the order is not simply expired.
        const now = await ctx.driver.getOrder(order.id);
        if (now && now.status !== "draft") return { body: await mapOrderFor(ctx, order.id) };
        // Captured money on an expired hold is NOT retryable (it needs a refund or
        // a manual accept), so it must not carry the retryable `tender_in_progress`
        // reason that pizza-mcp retries on.
        const captured = voided.reason === "captured";
        throw ProblemError.of("CONFLICT", {
          detail: captured
            ? "The hold expired but the order holds captured payment; refund it or accept the order."
            : "The hold expired but a payment is in flight; retry shortly.",
          details: { reason: captured ? "captured_money" : "tender_in_progress" },
        });
      }
      throw ProblemError.of("INVALID_TRANSITION", {
        detail: "The hold expired and the order was canceled.",
      });
    }
    // Any hold (whatever its reason) is only released once fully paid, unless
    // the caller holds the explicit scope (e.g. a terminal taking cash).
    if (!hasLiteralScope(ctx.principal, "orders:release_unpaid")) {
      const payments = await ctx.driver.listPaymentsForOrder(order.id);
      // Like main's settlement (settledCents vs orderDueCents): only the BASE
      // amount of settled tenders in the order's currency pays for the order —
      // a terminal tender's tip is not part of the order total, so it can't
      // cover unpaid food. Refunds are netted off the base once they exceed
      // the tip (refunded_cents spans amount + tip).
      const due = orderDueCents(order);
      const covered = netSettledBaseCents(payments, order.currency);
      if (covered < due) {
        throw ProblemError.of("PAYMENT_REQUIRED", {
          detail: "The order is not fully paid; it cannot be released yet.",
          details: { amount_due_cents: due - covered },
        });
      }
    }
    const res = await ctx.driver.casOrderStatus(order.id, ["draft"], "placed");
    if (!res.ok && res.reason === "conflict" && res.order.status === "voided") {
      throw ProblemError.of("INVALID_TRANSITION", { detail: "Order was canceled." });
    }
    return { body: await mapOrderFor(ctx, order.id) };
  },

  /**
   * POST /orders/{id}/hold/extend (0.3.1): move a held order's `expires_at` to
   * now + ttl, clamped to created_at + `holdCapSeconds(reason)`. The hub has
   * already checked that the caller created the hold. Refuses (409) when the
   * order is not held (released, canceled, ...), the hold already expired
   * (extending never revives it), it is at its cap, or it is settled.
   *
   * Concurrency: the write is a compare-and-set on (status = draft, hold
   * expiry = the value the new expiry was computed from), so it loses cleanly
   * to a concurrent release / cancel / expiry / extension (re-read, re-decide)
   * and can never resurrect a voided order or extend one that was placed.
   * Idempotency: the last Idempotency-Key + ttl live on the hold; a replay of
   * the same pair returns the current order without extending again, the same
   * key with another ttl is IDEMPOTENCY_CONFLICT.
   */
  "orders.extendHold": async (ctx) => {
    await requireActiveTenant(ctx);
    const parsed = OrderHoldExtendInputSchema.safeParse(await readBody(ctx.req));
    if (!parsed.success) throw zodProblem(parsed.error);
    const ttl = parsed.data.ttl_seconds;
    const key = ctx.req.headers.get("idempotency-key");
    for (let attempt = 0; attempt < 3; attempt++) {
      const order = await ownedOrder(ctx, ctx.params.order_id!);
      const hold = order.status === "draft" ? (order.hold ?? null) : null;
      if (key && hold?.extend_key === key) {
        if (hold.extend_ttl_seconds !== ttl) {
          throw ProblemError.of("IDEMPOTENCY_CONFLICT", {
            detail: "Idempotency-Key was used with a different request.",
          });
        }
        return {
          body: await mapOrderFor(ctx, order.id),
          headers: { "idempotent-replayed": "true" },
        };
      }
      const next = extendedHoldExpiry(
        {
          fulfillment_status: hold ? "held" : order.status,
          hold: hold ? { reason: hold.reason, expires_at: hold.expires_at } : null,
          created_at: order.created_at,
        } as Parameters<typeof extendedHoldExpiry>[0],
        ttl,
        ctx.now(),
      );
      if ("error" in next) {
        throw next.error === "not_held"
          ? ProblemError.of("INVALID_TRANSITION", {
              detail: "The order is not held.",
              details: { reason: "not_held" },
            })
          : ProblemError.of("CONFLICT", {
              detail:
                next.error === "expired"
                  ? "The hold already expired."
                  : "The hold is at its maximum lifetime.",
              details: { reason: next.error },
            });
      }
      // A fully paid order is released by settlement, not kept on hold.
      const due = orderDueCents(order);
      if (
        due > 0 &&
        netSettledBaseCents(await ctx.driver.listPaymentsForOrder(order.id), order.currency) >=
          due
      ) {
        throw ProblemError.of("INVALID_TRANSITION", {
          detail: "The order is already paid in full.",
          details: { reason: "settled" },
        });
      }
      const res = await ctx.driver.extendOrderHold(
        order.id,
        ctx.principal.tenant_id,
        { expires_at: hold!.expires_at },
        {
          ...hold!,
          expires_at: next.expires_at,
          extend_key: key,
          extend_ttl_seconds: ttl,
        },
      );
      if (res.ok) return { body: await mapOrderFor(ctx, order.id) };
      if (res.reason === "not_found") throw notFound("Order");
      // Lost a race (release / cancel / expiry / another extension): re-decide.
    }
    throw ProblemError.of("CONFLICT", {
      detail: "The order changed while extending its hold; retry.",
      details: { reason: "concurrent_update" },
    });
  },

  "payments.listForOrder": async (ctx) => {
    const order = await ownedOrder(ctx, ctx.params.order_id!);
    const payments = await ctx.driver.listPaymentsForOrder(order.id);
    return { body: { data: payments.map(toContractPayment) } };
  },

  "payments.get": async (ctx) => {
    const p = await loadPayment(ctx.principal.tenant_id, ctx.params.payment_id!, ctx.driver);
    if (!p || !allowedLocation(ctx.principal, p.location_id)) throw notFound("Payment");
    return { body: p };
  },

  // Hosted pay link (Stripe Checkout on the connected account). The safety gate
  // (`assertSessionChargeAllowed`) runs inside, before any tender or Stripe call.
  "payments.createSession": async (ctx) => {
    await requireActiveTenant(ctx);
    const order = await ownedOrder(ctx, ctx.params.order_id!);
    const parsed = PaymentSessionCreateInputSchema.safeParse(await readBody(ctx.req));
    if (!parsed.success) throw zodProblem(parsed.error);
    const key = ctx.req.headers.get("idempotency-key");
    if (!key) {
      throw ProblemError.of("VALIDATION_FAILED", {
        detail: "The Idempotency-Key header is required.",
      });
    }
    const { row, replayed } = await createPaymentSession({
      driver: ctx.driver,
      tenantId: ctx.principal.tenant_id,
      order,
      input: parsed.data,
      idempotencyKey: key,
      now: ctx.now(),
      baseUrl: ctx.url.origin,
    });
    return {
      status: replayed ? 200 : 201,
      body: toContractSession(row),
      headers: replayed ? { "idempotent-replayed": "true" } : undefined,
    };
  },

  "payments.getSession": async (ctx) => {
    const row = await ctx.driver.getPaymentSession(ctx.params.session_id!);
    if (!row || row.tenant_id !== ctx.principal.tenant_id) throw notFound("Payment session");
    // Tenant AND location scope, through the order.
    await ownedOrder(ctx, row.order_id);
    return { body: toContractSession(await loadPaymentSession(ctx.driver, row, ctx.now())) };
  },

  "payments.account": async (ctx) => {
    const tenantId = ctx.principal.tenant_id;
    const first = (await loadLocations(tenantId, ctx.driver))[0];
    return {
      body: await getPaymentsAccount(
        ctx.driver,
        tenantId,
        first?.settings.currency ?? "USD",
      ),
    };
  },

  "customers.list": async (ctx) => {
    const tenantId = ctx.principal.tenant_id;
    const q = ctx.url.searchParams;
    const limit = Number(q.get("limit") ?? DEFAULT_LIMIT);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      throw ProblemError.of("VALIDATION_FAILED", { detail: `limit must be an integer 1..${MAX_LIMIT}.` });
    }
    const cursor = q.get("cursor") ? decodeCursor(q.get("cursor")!) : null;
    const rows = await ctx.driver.listCustomers(tenantId, {
      after: cursor ? { created_at: cursor[0], id: cursor[1] } : undefined,
      limit: limit + 1,
    });
    const data = rows.slice(0, limit);
    // Stats only for the page being returned (aggregate, not a full scan).
    const stats = await ctx.driver.customerOrderStats(tenantId, data.map((c) => c.id));
    const country = await tenantCountry(tenantId, ctx.driver);
    const last = data[data.length - 1];
    return {
      body: {
        data: data.map((c) => toContractCustomer(c, stats.get(c.id) ?? NO_STATS, country)),
        next_cursor: rows.length > limit && last ? encodeCursor(last.created_at, last.id) : null,
      },
    };
  },

  "customers.lookup": async (ctx) => {
    const email = ctx.url.searchParams.get("email")?.trim().toLowerCase();
    const phone = ctx.url.searchParams.get("phone");
    if (!email && !phone) {
      throw ProblemError.of("VALIDATION_FAILED", { detail: "email or phone is required." });
    }
    const tenantId = ctx.principal.tenant_id;
    let found = email ? await ctx.driver.getCustomerByEmail(tenantId, email) : null;
    if (!found && phone) {
      // Keyset-page through ALL customers (no silent 1000-row truncation).
      let after: { created_at: string; id: string } | undefined;
      for (let guard = 0; guard < 400 && !found; guard++) {
        const batch = await ctx.driver.listCustomers(tenantId, { after, limit: 500 });
        const key = phoneKey(phone);
        found = key ? (batch.find((c) => phoneKey(c.phone) === key) ?? null) : null;
        if (batch.length < 500) break;
        const lastRow = batch[batch.length - 1]!;
        after = { created_at: lastRow.created_at, id: lastRow.id };
      }
    }
    if (!found) throw notFound("Customer");
    return { body: await loadCustomer(tenantId, found.id, ctx.driver) };
  },

  "customers.get": async (ctx) => {
    const c = await loadCustomer(ctx.principal.tenant_id, ctx.params.customer_id!, ctx.driver);
    if (!c) throw notFound("Customer");
    return { body: c };
  },

  /**
   * POST /customers (0.3.0): upsert by email, else by phone, within the token's
   * tenant. The atomic rules live in the driver (`upsertCustomerIdentity`): email
   * wins, two customers are never merged, blanks are filled but never
   * overwritten, `verified` is never touched (the hub's OTP flow vouches for the
   * contact itself), consent changes only with an `at`. Naturally idempotent:
   * repeating the request changes nothing.
   */
  "customers.upsert": async (ctx) => {
    await requireActiveTenant(ctx);
    const raw = await readBody(ctx.req);
    const parsed = CustomerUpsertInputSchema.safeParse(raw);
    if (!parsed.success) throw zodProblem(parsed.error);
    const i = parsed.data;
    // OTP mode: `verified_contact` names the ONE contact a one-time code reached.
    // It is the only way to create or resolve a VERIFIED identity, so it needs the
    // literal `customers:verify` scope (`*` and `customers:*` do not grant it).
    const vcRaw = (raw as { verified_contact?: unknown } | null)?.verified_contact;
    let verifiedContact: "email" | "phone" | undefined;
    if (vcRaw !== undefined && vcRaw !== null) {
      if (vcRaw !== "email" && vcRaw !== "phone") {
        throw ProblemError.of("VALIDATION_FAILED", {
          detail: "`verified_contact` must be \"email\" or \"phone\".",
          path: "verified_contact",
        });
      }
      requireHubSigned(ctx);
      if (!hasLiteralScope(ctx.principal, "customers:verify")) {
        throw ProblemError.of("INSUFFICIENT_SCOPE", {
          detail: "missing scope(s): customers:verify (must be granted explicitly)",
          details: { missing: ["customers:verify"], granted: ctx.principal.scopes },
        });
      }
      if (!(vcRaw === "email" ? i.email : i.phone)) {
        throw ProblemError.of("VALIDATION_FAILED", {
          detail: `\`verified_contact\` is ${vcRaw} but no ${vcRaw} was sent.`,
          path: vcRaw,
        });
      }
      verifiedContact = vcRaw;
    }
    if ((i.tags?.length ?? 0) > 100 || Object.keys(i.external_ids ?? {}).length > 50) {
      throw ProblemError.of("VALIDATION_FAILED", {
        detail: "Too many tags (max 100) or external ids (max 50).",
      });
    }
    const name =
      i.name?.trim() ||
      [i.first_name, i.last_name]
        .map((s) => s?.trim())
        .filter(Boolean)
        .join(" ") ||
      null;
    // Consent without an `at` is not evidence: it is not stored (and never
    // flips an existing channel).
    // A future `at` is clamped to now: the evidence cannot be dated ahead.
    const marketing: { email?: CustomerConsent; sms?: CustomerConsent } = {};
    const nowMs = ctx.now().getTime();
    for (const ch of ["email", "sms"] as const) {
      const c = i.marketing?.[ch];
      if (!c?.at) continue;
      marketing[ch] =
        Date.parse(c.at) > nowMs ? { ...c, at: new Date(nowMs).toISOString() } : c;
    }
    const tenantId = ctx.principal.tenant_id;
    const { customer } = await ctx.driver.upsertCustomerIdentity(tenantId, {
      newId: globalThis.crypto.randomUUID(),
      email: i.email ?? null,
      phone: i.phone ?? null,
      name,
      marketing,
      tags: (i.tags ?? []).map((t) => t.trim()).filter(Boolean),
      externalIds: i.external_ids ?? {},
      ...(verifiedContact ? { verifiedContact } : {}),
    });
    const body =
      (await loadCustomer(tenantId, customer.id, ctx.driver)) ??
      toContractCustomer(customer, NO_STATS, await tenantCountry(tenantId, ctx.driver));
    return { status: 200, body };
  },

  /**
   * POST /orders/{id}/payments (0.3.0): record a tender taken OUTSIDE POS's
   * processors (kiosk card reader, cash on delivery, paid invoice, gift card).
   * See `recordExternalTender` below.
   */
  "payments.recordExternal": async (ctx) => recordExternalTender(ctx),

  "staff.list": async (ctx) => {
    let staff = await loadStaffList(ctx.principal.tenant_id, ctx.driver);
    const loc = ctx.url.searchParams.get("location_id");
    const active = ctx.url.searchParams.get("active");
    if (loc) staff = staff.filter((s) => s.location_ids.length === 0 || s.location_ids.includes(loc));
    if (active !== null) staff = staff.filter((s) => s.active === (active === "true"));
    return { body: pageItems(staff, ctx.url.searchParams) };
  },

  "staff.get": async (ctx) => {
    const s = (await loadStaffList(ctx.principal.tenant_id, ctx.driver)).find(
      (x) => x.id === ctx.params.staff_id,
    );
    if (!s) throw notFound("Staff member");
    return { body: s };
  },

  /**
   * POST /staff/verify-pin (HUB_ROUTES, so it is added to the route table by
   * hand): answers "is this the staff member's PIN?" and nothing else. The hub
   * mints the acting-staff session; POS never does, and never sees a token.
   *
   * Reuses the till's PIN logic: `begin_pin_attempt` counts the attempt under a
   * row lock BEFORE the PIN is checked (5 attempts without a success -> 15-minute
   * lock, shared with /api/terminal/pin), scrypt `verifyPin`, then
   * `clearPinAttempts`. Every mismatch (unknown / inactive / wrong location /
   * no PIN / wrong PIN / suspended tenant / foreign location) is the SAME 403,
   * and an unknown member burns the same scrypt time, so nothing is enumerable.
   * The PIN is never logged, echoed or stored.
   */
  "staff.verifyPin": async (ctx) => {
    const parsed = StaffPinVerifyInputSchema.safeParse(await readBody(ctx.req));
    if (!parsed.success) throw zodProblem(parsed.error, "Request is invalid.");
    const { location_id, staff_id, pin } = parsed.data;
    const tenantId = ctx.principal.tenant_id;
    const mismatch = () => ProblemError.of("FORBIDDEN", { detail: "PIN not recognised." });

    const tenant = await ctx.driver.getTenant(tenantId);
    const location = allowedLocation(ctx.principal, location_id)
      ? await loadLocation(tenantId, location_id, ctx.driver)
      : null;
    const staff = isGuid(staff_id) ? await ctx.driver.getStaffById(tenantId, staff_id) : null;
    const eligible =
      tenant?.status === "active" &&
      !!location &&
      !!staff &&
      staff.active &&
      (!staff.location_ids?.length || staff.location_ids.includes(location_id));
    if (!eligible || !staff) {
      // Same cost, same budget and the same answers as a real check: nothing here
      // tells an unknown id from a known one.
      verifyPin(pin, dummyPinHash());
      const g = ghostBegin(`${tenantId}:${staff_id}`, ctx.now().getTime());
      if (!g.allowed) {
        throw ProblemError.of("RATE_LIMITED", {
          detail: "Too many incorrect PINs. Try again later.",
          details: { locked_until: new Date(g.until).toISOString() },
        });
      }
      throw mismatch();
    }

    const attempt = await ctx.driver.beginPinAttempt(tenantId, staff.id);
    if (!attempt.allowed) {
      throw ProblemError.of("RATE_LIMITED", {
        detail: "Too many incorrect PINs. Try again later.",
        details: { locked_until: attempt.lockedUntil },
      });
    }
    // A member with no PIN set costs the same scrypt as a wrong PIN (and can
    // never match: the dummy is a random secret, and the result is ANDed).
    const ok =
      verifyPin(pin, staff.pin_hash ?? dummyPinHash()) && Boolean(staff.pin_hash);
    if (!ok) throw mismatch();
    await ctx.driver.clearPinAttempts(tenantId, staff.id);

    const email = staff.user_id
      ? ((await ctx.driver.getUserEmails([staff.user_id])).get(staff.user_id) ?? null)
      : null;
    return {
      body: { staff: toContractStaff({ ...staff, pin_hash: undefined }, true, email) },
    };
  },

  /**
   * PUT /staff/{id}/pin (literal scope `staff:set_pin`; the hub has already
   * checked role rank and location). POS re-checks the TENANT (and a
   * location-limited token's reach) and hashes with the till's scrypt. `null`
   * clears the PIN. One targeted update of `pin_hash`; the PIN is never logged.
   */
  "staff.setPin": async (ctx) => {
    requireHubSigned(ctx);
    await requireActiveTenant(ctx);
    const parsed = StaffPinSetInputSchema.safeParse(await readBody(ctx.req));
    if (!parsed.success) throw zodProblem(parsed.error);
    const tenantId = ctx.principal.tenant_id;
    const staffId = ctx.params.staff_id!;
    const staff = isGuid(staffId) ? await ctx.driver.getStaffById(tenantId, staffId) : null;
    if (!staff) throw notFound("Staff member");
    // A location-limited token may only touch staff entirely inside its reach
    // (staff with no location list work everywhere, so they are out of reach).
    const lids = scopedLocationIds(ctx.principal);
    if (
      lids &&
      (!staff.location_ids?.length || !staff.location_ids.every((l) => lids.includes(l)))
    ) {
      throw notFound("Staff member");
    }
    const hash = parsed.data.pin === null ? null : hashPin(parsed.data.pin);
    if (!(await ctx.driver.setStaffPinHash(tenantId, staff.id, hash))) {
      throw notFound("Staff member");
    }
    const member = (await loadStaffList(tenantId, ctx.driver)).find((s) => s.id === staff.id);
    if (!member) throw notFound("Staff member");
    return { body: member };
  },

  "drawerSessions.list": async (ctx) => {
    const bundle = await ownedLocation(ctx, ctx.params.location_id!);
    const q = ctx.url.searchParams;
    let page: { data: { id: string }[]; next_cursor: string | null } = { data: [], next_cursor: null };
    const sessions = await loadDrawerSessions(bundle, ctx.driver, (shifts) => {
      const p = pageItems(
        shifts.map((x) => ({ ...x, created_at: x.opened_at, updated_at: x.closed_at ?? x.opened_at })),
        q,
      );
      page = p;
      return p.data;
    });
    return { body: { data: sessions, next_cursor: page.next_cursor } };
  },

  "deliveries.list": async (ctx) => {
    const ids = scopedLocationIds(ctx.principal);
    const bundles = (await loadLocations(ctx.principal.tenant_id, ctx.driver)).filter(
      (b) => !ids || ids.includes(b.location.id),
    );
    const locFilter = ctx.url.searchParams.get("location_id");
    const status = ctx.url.searchParams.get("status");
    const records = [];
    for (const b of bundles) {
      if (locFilter && b.location.id !== locFilter) continue;
      for (const r of await ctx.driver.listDeliveries(ctx.principal.tenant_id, b.location.id)) {
        if (!status || r.status === status) records.push(r);
      }
    }
    const page = pageItems(records, ctx.url.searchParams);
    const data = (
      await Promise.all(
        page.data.map((r) => loadDelivery(ctx.principal.tenant_id, r.id, ctx.driver)),
      )
    ).filter((d): d is NonNullable<typeof d> => d !== null);
    return { body: { data, next_cursor: page.next_cursor } };
  },

  "deliveries.get": async (ctx) => {
    const d = await loadDelivery(ctx.principal.tenant_id, ctx.params.delivery_id!, ctx.driver);
    if (!d || !allowedLocation(ctx.principal, d.location_id)) throw notFound("Delivery");
    return { body: d };
  },

  "sales.daily": async (ctx) => {
    const bundle = await ownedLocation(ctx, ctx.params.location_id!);
    const q = ctx.url.searchParams;
    const from = q.get("from");
    const to = q.get("to");
    if (!from || !to || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      throw ProblemError.of("VALIDATION_FAILED", { detail: "from and to (YYYY-MM-DD) are required." });
    }
    const orders = await loadTenantOrders(ctx.principal.tenant_id, {
      locationIds: [bundle.location.id],
      ...paddedRange(from, to),
      rowFilter: isSalesRow,
      driver: ctx.driver,
    });
    const dates = [...new Set(orders.map((o) => o.business_date))]
      .filter((d) => d >= from && d <= to)
      .sort();
    const data = [];
    for (const date of dates) {
      const close = await ctx.driver.getBusinessDayClose(
        ctx.principal.tenant_id,
        bundle.location.id,
        date,
      );
      const payments = [
        ...(
          await ctx.driver.listPaymentsForOrders(
            orders.filter((o) => o.business_date === date).map((o) => o.id),
          )
        ).values(),
      ]
        .flat()
        .map(toContractPayment);
      data.push(
        buildDailySales({
          tenant_id: ctx.principal.tenant_id,
          location_id: bundle.location.id,
          business_date: date,
          currency: bundle.settings.currency,
          orders,
          payments,
          closedAt: close ? new Date(close.closed_at).toISOString() : null,
        }),
      );
    }
    return { body: { data } };
  },

  "sales.summary": async (ctx) => {
    const raw = Object.fromEntries(ctx.url.searchParams.entries());
    const parsed = SalesSummaryQuerySchema.safeParse(raw);
    if (!parsed.success) throw zodProblem(parsed.error);
    const q = parsed.data;
    if (q.location_id) await ownedLocation(ctx, q.location_id);
    const ids = q.location_id ? [q.location_id] : scopedLocationIds(ctx.principal);
    const bundles = (await loadLocations(ctx.principal.tenant_id, ctx.driver)).filter(
      (b) => !ids || ids.includes(b.location.id),
    );
    const orders = await loadTenantOrders(ctx.principal.tenant_id, {
      locationIds: ids,
      ...paddedRange(q.from, q.to),
      rowFilter: isSalesRow,
      driver: ctx.driver,
    });
    let categories: Map<string, { id: string; name: string }> | undefined;
    if (q.group_by === "category") {
      categories = new Map();
      for (const b of bundles) {
        const menu = await loadMenu(b, ctx.driver);
        for (const c of menu.categories) {
          for (const i of c.items) categories.set(i.id, { id: c.id, name: c.name });
        }
      }
    }
    return {
      body: buildSalesSummary({
        tenant_id: ctx.principal.tenant_id,
        location_id: q.location_id ?? null,
        from: q.from,
        to: q.to,
        group_by: q.group_by,
        currency: bundles[0]?.settings.currency ?? "USD",
        orders,
        locations: new Map(
          bundles.map((b) => [b.location.id, { name: b.location.name, timezone: b.location.timezone }]),
        ),
        categories,
      }),
    };
  },
};

/** business_date is location-local: pad the UTC created_at window by a day each side. */
function paddedRange(from: string, to: string): { createdFrom: string; createdTo: string } {
  const t = (d: string, days: number) =>
    new Date(new Date(`${d}T00:00:00Z`).getTime() + days * 86_400_000).toISOString();
  return { createdFrom: t(from, -1), createdTo: t(to, 2) };
}

const UNSUPPORTED: V1Operation[] = [
  "orders.updateStatus",
  "deliveries.updateStatus",
  "events.list",
];

/**
 * Operations that live in the hub's route table (`HUB_ROUTES`) but that the hub
 * delegates to the commerce source, so POS must serve them too. They are added
 * to the router by hand: `V1_ROUTES` does not list them.
 */
type ExtraOperation = "staff.verifyPin";
const EXTRA_ROUTES: Record<ExtraOperation, { method: string; path: string; scopes: readonly string[] }> = {
  "staff.verifyPin": HUB_ROUTES["staff.verifyPin"],
};

/**
 * Best-effort twin of `begin_pin_attempt` for ids that are NOT eligible (unknown,
 * inactive, wrong location, suspended tenant). Without it a real id would turn
 * into 429 after five wrong PINs while an unknown id stayed 403, telling a caller
 * which ids exist. Same policy (5 attempts, then a 15-minute lock) and the same
 * 429 shape; per process, which is all a cache of fakes needs.
 */
const ghostAttempts = new Map<string, { n: number; until: number }>();
function ghostBegin(key: string, nowMs: number): { allowed: boolean; until: number } {
  let g = ghostAttempts.get(key) ?? { n: 0, until: 0 };
  if (g.until > nowMs) return { allowed: false, until: g.until };
  if (g.until) g = { n: 0, until: 0 };
  if (g.n >= 5) {
    const until = nowMs + 15 * 60_000;
    ghostAttempts.set(key, { n: 0, until });
    return { allowed: false, until };
  }
  if (ghostAttempts.size > 10_000) ghostAttempts.clear();
  ghostAttempts.set(key, { n: g.n + 1, until: 0 });
  return { allowed: true, until: 0 };
}

let dummyHash: string | null = null;
/** A hash nobody's PIN matches (random secret), for equal-cost misses. */
function dummyPinHash(): string {
  return (dummyHash ??= hashPin(globalThis.crypto.randomUUID()));
}

// ---------------------------------------------------------------------------
// Orders (write)
// ---------------------------------------------------------------------------

/**
 * A stored quote of THIS tenant and an allowed location, still valid. A foreign,
 * out-of-scope or unknown id is the same 404 (existence never leaks); an expired
 * one is 409 QUOTE_EXPIRED (the caller re-quotes).
 */
async function loadStoredQuote(ctx: Ctx, quoteId: string): Promise<StoredQuote> {
  const stored = await ctx.driver.getQuote(ctx.principal.tenant_id, quoteId);
  if (!stored || !allowedLocation(ctx.principal, stored.location_id)) {
    throw ProblemError.of("QUOTE_NOT_FOUND", { detail: "Quote not found." });
  }
  if (Date.parse(stored.expires_at) < ctx.now().getTime()) {
    throw ProblemError.of("QUOTE_EXPIRED", {
      detail: "The quote expired; request a new quote.",
    });
  }
  return stored;
}

async function ownedOrder(ctx: Ctx, orderId: string) {
  const order = await ctx.driver.getOrder(orderId);
  if (
    !order ||
    order.tenant_id !== ctx.principal.tenant_id ||
    !allowedLocation(ctx.principal, order.location_id)
  ) {
    throw notFound("Order");
  }
  return order;
}

async function mapOrderFor(ctx: Ctx, orderId: string): Promise<CoreOrder> {
  const order = await loadOrder(ctx.principal.tenant_id, orderId, ctx.driver);
  if (!order) throw notFound("Order");
  return order;
}

function signature(lines: { item_id: string; quantity: number }[]): string {
  return lines
    .map((l) => `${l.item_id}x${l.quantity}`)
    .sort()
    .join("|");
}

/**
 * POST /orders. Prices server-side with the canonical `priceCart` against the
 * contract view of the POS menu, then persists through the SAME repricing the
 * terminal and shop use (`priceOrder`); the two totals must agree or nothing is
 * written. Unpaid `prepaid` orders (and any order with `hold`) are created HELD
 * (`draft`): invisible to the KDS until released or paid.
 */
async function createOrder(ctx: Ctx): Promise<Reply> {
  const parsed = OrderCreateInputSchema.safeParse(await readBody(ctx.req));
  if (!parsed.success) throw zodProblem(parsed.error);
  const input = parsed.data;
  const tenantId = ctx.principal.tenant_id;
  await requireActiveTenant(ctx);
  const bundle = await ownedLocation(ctx, input.location_id);
  const terminal = isTerminal(ctx.principal);

  // Order id: client id > derived from Idempotency-Key > random.
  const idemKey = ctx.req.headers.get("idempotency-key");
  const orderId =
    input.id ??
    (idemKey ? uuidv5(`${tenantId}:${idemKey}`) : globalThis.crypto.randomUUID());

  // Idempotent replay, checked BEFORE anything that can age out (quote expiry or
  // pruning, plan gate): a retry of a request that already created the order must
  // return it. Foreign-tenant / out-of-scope ids answer exactly like a
  // different-request conflict so id existence never leaks.
  const existing = await ctx.driver.getOrder(orderId);
  if (existing && (input.lines?.length || input.quote_id)) {
    const conflict = () =>
      ProblemError.of("IDEMPOTENCY_CONFLICT", {
        detail: "This id is already in use or was used with a different request.",
      });
    if (existing.tenant_id !== tenantId || !allowedLocation(ctx.principal, existing.location_id)) {
      throw conflict();
    }
    // Compare the cart. A quote_id request compares the stored quote's cart even
    // if it has expired; if it has been pruned the id alone (same tenant and
    // location) is the proof.
    let sentLines: { item_id: string; quantity: number }[] | null = input.lines?.length
      ? input.lines
      : null;
    if (!sentLines && input.quote_id) {
      const q = await ctx.driver.getQuote(tenantId, input.quote_id);
      if (q) sentLines = QuoteRequestSchema.parse(q.request).lines;
    }
    if (sentLines) {
      const sent = signature(sentLines.map((l) => ({ item_id: l.item_id, quantity: l.quantity })));
      const had = signature(
        existing.items
          .filter((i) => !i.voided)
          .map((i) => ({ item_id: i.item_id, quantity: i.quantity })),
      );
      if (sent !== had) throw conflict();
    }
    return {
      status: 200,
      body: await mapOrderFor(ctx, existing.id),
      headers: { "idempotent-replayed": "true" },
    };
  }

  // `quote_id` with no `lines` (pizza-mcp, kiosk): reload the stored request. The
  // cart, fulfillment and adjustments come from it; `tip` and `customer_id` from
  // the input when given, else the stored ones. Prices are NEVER taken from the
  // store: the cart is re-priced below, and drift against the stored hash is
  // PRICE_CHANGED.
  let lines = input.lines;
  let fulfillmentIn = input.fulfillment;
  let adjustmentsIn = input.adjustments;
  let tipIn = input.tip;
  let customerIdIn = input.customer_id;
  let storedQuote: StoredQuote | null = null;
  if ((!lines || lines.length === 0) && input.quote_id) {
    storedQuote = await loadStoredQuote(ctx, input.quote_id);
    if (storedQuote.location_id !== input.location_id) {
      throw ProblemError.of("QUOTE_NOT_FOUND", { detail: "Quote not found." });
    }
    const req = QuoteRequestSchema.parse(storedQuote.request);
    lines = req.lines;
    fulfillmentIn = input.fulfillment ?? req.fulfillment;
    adjustmentsIn = input.adjustments ?? req.adjustments;
    tipIn = input.tip !== undefined ? input.tip : req.tip;
    customerIdIn = input.customer_id ?? req.customer_id;
    if (req.tax_exempt) throw unsupported("tax-exempt orders");
  }

  // Discounts/comps are an owner/manager power in POS: callers need an explicit scope.
  if ((adjustmentsIn?.length ?? 0) > 0) {
    if (!hasLiteralScope(ctx.principal, "orders:discount")) {
      throw ProblemError.of("INSUFFICIENT_SCOPE", {
        detail: "missing scope(s): orders:discount (must be granted explicitly)",
        details: { missing: ["orders:discount"], granted: ctx.principal.scopes },
      });
    }
  }
  // Plan gate: anything but a counter order is "online ordering".
  if (!(terminal && input.channel === "in_store")) {
    const gate = canUseOnlineOrdering(
      resolveEntitlements(await ctx.driver.getSubscription(tenantId)),
    );
    if (!gate.allowed) {
      throw ProblemError.of("FORBIDDEN", { detail: gate.reason ?? "Plan does not allow this." });
    }
  }
  if (!lines || lines.length === 0) {
    throw ProblemError.of("VALIDATION_FAILED", {
      detail: "Send `lines`, or a `quote_id` from POST /quotes.",
      path: "lines",
    });
  }
  if (fulfillmentIn?.type === "delivery") {
    throw unsupported("delivery orders", "Delivery orders cannot be created through /v1 yet.");
  }
  if (input.tax_exempt) throw unsupported("tax-exempt orders");
  rejectFees(input.fees);

  const menu = await loadMenu(bundle, ctx.driver);
  // Only a terminal may skip the hours check, and only for counter orders.
  const inStore = terminal && input.channel === "in_store";
  const quote = priceCart({
    menu,
    location: bundle.contract,
    request: {
      location_id: input.location_id,
      lines,
      fulfillment: fulfillmentIn ?? { type: "pickup" },
      adjustments: adjustmentsIn ?? [],
      tip: tipIn ?? null,
      tax_exempt: false,
      customer_id: customerIdIn ?? null,
    },
    now: ctx.now(),
    checkHours: !inStore,
  });
  if (!quote.valid) {
    throw new ProblemError(
      problem("QUOTE_INVALID", {
        detail: "The cart has errors.",
        errors: quote.errors,
      }),
    );
  }
  if (storedQuote) {
    // Drift guard against the STORED quote, independent of any tip override:
    // re-price the stored request as it was quoted and compare hashes. A menu or
    // price change since the quote is PRICE_CHANGED, never a silently new total.
    const asQuoted = priceCart({
      menu,
      location: bundle.contract,
      request: storedQuote.request as unknown as QuoteRequest,
      now: ctx.now(),
      checkHours: false,
    });
    if (asQuoted.quote_hash !== storedQuote.quote_hash) {
      throw new ProblemError(
        problem("PRICE_CHANGED", {
          detail: "Prices changed since the quote.",
          details: { quote: asQuoted },
        }),
      );
    }
  }
  const preTip = quote.totals.total_cents - quote.totals.tip_cents;
  if (quote.totals.tip_cents > maxTipCents(preTip)) {
    throw ProblemError.of("VALIDATION_FAILED", {
      detail: "Tip is too large.",
      path: "tip",
    });
  }
  if (input.quote_hash && input.quote_hash !== quote.quote_hash) {
    throw new ProblemError(
      problem("PRICE_CHANGED", {
        detail: "Prices changed since the quote.",
        details: { quote },
      }),
    );
  }

  // Persist through the POS repricing path (menu, 86s, half rule, tax).
  const rawItems = quote.lines.map((l) => {
    const item = menu.categories.flatMap((c) => c.items).find((i) => i.id === l.item_id);
    const synthetic = item?.sizes.length === 1 && item.sizes[0]!.id === item.id;
    return {
      id: l.id,
      item_id: l.item_id,
      size_id: synthetic ? null : l.size_id,
      quantity: l.quantity,
      notes: l.notes,
      modifiers: l.modifiers.map((m) => ({
        group_id: m.group_id,
        modifier_id: m.modifier_id,
        placement: m.placement,
      })),
    };
  });
  let priced;
  try {
    priced = await priceOrder({
      tenantId,
      locationId: input.location_id,
      items: rawItems,
      discountCents: quote.totals.discount_cents,
      tipCents: quote.totals.tip_cents,
      settings: bundle.settings,
    });
  } catch (err) {
    if (err instanceof RepriceError) {
      throw ProblemError.of("QUOTE_INVALID", { detail: err.message });
    }
    throw err;
  }
  if (priced.totals.total_cents !== quote.totals.total_cents) {
    // Pricing drift between priceCart and POS repricing: never write a wrong total.
    throw ProblemError.of("INTERNAL", {
      detail: "Pricing mismatch between quote and POS; order not created.",
      details: {
        quote_total_cents: quote.totals.total_cents,
        pos_total_cents: priced.totals.total_cents,
      },
    });
  }

  // Customer + staff (tenant-checked).
  let customerId: string | null = null;
  if (customerIdIn) {
    const c = await ctx.driver.getCustomer(customerIdIn);
    if (!c || c.tenant_id !== tenantId) throw notFound("Customer");
    customerId = c.id;
  } else if (input.contact?.email) {
    const stamp = ctx.now().toISOString();
    const c = await ctx.driver.upsertCustomer({
      id: globalThis.crypto.randomUUID(),
      tenant_id: tenantId,
      email: input.contact.email,
      name: input.contact.name ?? null,
      phone: input.contact.phone ?? null,
      verified: false,
      created_at: stamp,
      updated_at: stamp,
    });
    customerId = c.id;
  }
  let staffId: string | null = null;
  if (input.staff_id) {
    // Attribution must be a real, ACTIVE staff member of this tenant (the same
    // rule the terminal applies to its PIN-switched active staff).
    const s = await ctx.driver.getStaffById(tenantId, input.staff_id);
    if (!s || !s.active) throw notFound("Staff member");
    staffId = s.id;
  }

  // Held unless the caller will take payment at the counter.
  const now = ctx.now();
  // Held unless a terminal takes the order at the counter (or invoices it).
  // Only a terminal may choose the reason. For everyone else the reason is
  // forced to awaiting_payment: a caller-chosen reason (e.g. "manual") must
  // never dodge the unpaid-release check.
  const wantsHold = Boolean(input.hold) || input.payment_intent === "prepaid" || !terminal;
  const holdReason = !wantsHold
    ? null
    : terminal
      ? (input.hold?.reason ?? "awaiting_payment")
      : "awaiting_payment";
  // The reason is what bounds the ttl: only `scheduled` may run up to 30 days,
  // and a non-terminal caller's reason is forced to awaiting_payment above.
  const ttl = Math.min(
    input.hold?.ttl_seconds ?? 900,
    holdReason ? holdCapSeconds(holdReason) : 900,
  );
  const hold = holdReason
    ? { reason: holdReason, expires_at: new Date(now.getTime() + ttl * 1000).toISOString() }
    : null;

  const f = bundle.settings.fulfillment;
  const scheduled = fulfillmentIn?.scheduled_for ?? null;
  const prepMs = (f?.prep_minutes ?? 15) * 60_000;
  const fulfillment: OrderFulfillment = {
    type: "pickup",
    scheduled_for: scheduled ?? "asap",
    promised_at: scheduled ?? new Date(now.getTime() + prepMs).toISOString(),
    // Which deployment kind created the hold: the held-order sweeper only
    // touches its own mode (prod and a test-key preview may share one database).
    checkout_mode: deploymentCheckoutMode(),
    delivery_notes: fulfillmentIn?.delivery_notes ?? undefined,
    contact: input.contact
      ? { name: input.contact.name ?? null, phone: input.contact.phone ?? null }
      : undefined,
  };

  const create: CreateOrderInput = {
    id: orderId,
    tenant_id: tenantId,
    location_id: input.location_id,
    channel: input.channel === "in_store" || input.channel === "kiosk" || input.channel === "phone" ? "in_store" : "online_pickup",
    currency: priced.settings.currency,
    items: priced.items,
    discount_cents: priced.totals.discount_cents,
    totals: priced.totals,
    notes: input.notes?.trim() || null,
    status: hold ? "draft" : "placed",
    customer_id: customerId,
    staff_id: staffId,
    fulfillment,
    hold,
    source: {
      type: input.source.type,
      channel: input.channel,
      module: input.source.module ?? ctx.principal.module ?? "core",
      agent_client_id: input.source.agent_client_id ?? null,
      external_ref: input.source.external_ref ?? null,
      offline_synced: input.source.offline_synced ?? false,
      device_id: input.source.device_id ?? null,
    },
  };
  const order = await ctx.driver.createOrder(create);
  const tz = bundle.location.timezone;
  const body = await mapOrder(order, tz, ctx.driver);
  return { status: 201, body, headers: { location: `/api/v1/orders/${order.id}` } };
}

// ---------------------------------------------------------------------------
// payments.recordExternal
// ---------------------------------------------------------------------------

/**
 * Modules allowed to record money taken outside POS. Recording a CAPTURED tender
 * can mark an order paid, so `payments:write` alone is not enough: an agent
 * client (pizza-mcp) or any other module holding it could "pay" any order. The
 * hub token carries the caller's module as `op_mod` (`principal.module`).
 */
export const EXTERNAL_TENDER_MODULES: readonly string[] = ["kiosk", "driver", "catering", "guests"];

/**
 * POS trusts the hub's checks (role rank, device kind, tender lock, revoked
 * clients), so outside simulated mode a token whose `sub` is not hub-signed
 * (`hub:<caller>`) may not reach the routes that depend on them. The simulated
 * zero-env mode (mock driver, no JWKS, not production: the dev token) is exempt.
 */
function requireHubSigned(ctx: Ctx): void {
  if (ctx.principal.id.startsWith("hub:") || isSimulatedV1(process.env)) return;
  throw ProblemError.of("FORBIDDEN", {
    detail: "This operation must be called through the hub.",
    details: { reason: "not_hub_signed" },
  });
}

/** Statuses of an order that can no longer take a tender. */
const CLOSED_FOR_TENDERS: readonly string[] = ["voided", "abandoned", "refunded"];

/**
 * The hub's `source.device_id` rule (hub `guardExternalTender`), enforced here
 * too: a `collection: "terminal"` tender is only accepted from the device that
 * took the order. The hub signs POS calls with `sub = hub:<caller client id>`
 * (a device's client id is its principal id), so the caller is the `sub` with the
 * `hub:` prefix removed. Fails closed: an order with no `source.device_id`
 * accepts no terminal tender.
 */
function assertTerminalDevice(p: Principal, deviceId: string | null | undefined): void {
  const caller = p.id.startsWith("hub:") ? p.id.slice(4) : p.id;
  if (!deviceId || deviceId !== caller) {
    throw ProblemError.of("FORBIDDEN", {
      detail:
        "terminal tenders can only be recorded by the device that took the order (order.source.device_id)",
      details: { reason: "device_mismatch" },
    });
  }
}

const norm = (s: string | null | undefined): string | null => s?.trim() || null;

interface ExternalWanted {
  method: string;
  processor: string;
  processorRef: string | null;
  amountCents: number;
  tipCents: number;
  requestedStatus: "captured" | "authorized" | "pending";
  collection: string | null;
  staffId: string | null;
}

function sameExternal(p: Payment, w: ExternalWanted): boolean {
  const requested = (p.raw?.requested_status as string | undefined) ?? p.status;
  return (
    p.method === w.method &&
    p.processor === w.processor &&
    (p.processor_ref ?? null) === w.processorRef &&
    p.amount_cents === w.amountCents &&
    p.tip_cents === w.tipCents &&
    requested === w.requestedStatus &&
    (p.collection ?? null) === w.collection &&
    (p.staff_id ?? null) === w.staffId
  );
}

/**
 * POST /orders/{id}/payments. Money recorded here was taken OUTSIDE POS's own
 * processors and nothing proves it: trust rests on the scope, the hub's guard and
 * the checks below, all enforced on the server.
 *
 *  - scope: `payments:write`, or `payments.terminal:write` for a CAPTURED
 *    `collection: "terminal"` tender only (a kiosk); a terminal tender also needs
 *    the caller to be the device that took the order;
 *  - tenant/location from the token (foreign or out-of-scope order = 404);
 *  - the order must still take money (voided/abandoned = 409 INVALID_TRANSITION);
 *  - amounts via core's `checkTenderAmounts` against the FOOD amount due
 *    (tips never reduce it): over-due or over-tip = 422, with the due in details;
 *  - id = `input.id` ?? uuidv5(tenant:Idempotency-Key); a replay of the same
 *    tender returns it (200), the same id with another body is
 *    IDEMPOTENCY_CONFLICT; the same processor + ref cannot be captured twice;
 *  - written by ONE transaction under the order's row lock (driver); if the
 *    order's tenders changed since the amounts were validated, re-validate;
 *  - only a CAPTURED tender counts (`authorized` is stored `pending`); then open
 *    siblings close and the order is paid/released exactly as for a card, hold
 *    rules included. A replay re-runs that step, so a crash after the insert is
 *    healed by the retry.
 */
async function recordExternalTender(ctx: Ctx): Promise<Reply> {
  await requireActiveTenant(ctx);
  const parsed = ExternalTenderInputSchema.safeParse(await readBody(ctx.req));
  if (!parsed.success) throw zodProblem(parsed.error);
  const input = parsed.data;
  const tenantId = ctx.principal.tenant_id;
  const collection = norm(input.collection ?? null);

  if (ctx.terminalOnly && (collection !== "terminal" || input.status !== "captured")) {
    throw ProblemError.of("INSUFFICIENT_SCOPE", {
      detail:
        "payments.terminal:write only records captured card-terminal tenders (collection: terminal)",
      details: { missing: ["payments:write"], granted: ctx.principal.scopes },
    });
  }

  requireHubSigned(ctx);
  const callerModule = ctx.principal.module ?? null;
  const allowed =
    callerModule !== null
      ? EXTERNAL_TENDER_MODULES.includes(callerModule)
      : isSimulatedV1(process.env); // the zero-env dev token has no module
  if (!allowed) {
    throw ProblemError.of("FORBIDDEN", {
      detail: "This client may not record external payments.",
      details: { reason: "module_not_allowed" },
    });
  }

  const order = await ownedOrder(ctx, ctx.params.order_id!);
  if (collection === "terminal") assertTerminalDevice(ctx.principal, order.source?.device_id);

  const idemKey = ctx.req.headers.get("idempotency-key")?.trim() || null;
  const paymentId = input.id ?? (idemKey ? uuidv5(`${tenantId}:${idemKey}`) : null);
  if (!paymentId) {
    throw ProblemError.of("VALIDATION_FAILED", {
      detail: "The Idempotency-Key header (or an `id`) is required: a tender must be replay-safe.",
      path: "headers.idempotency-key",
    });
  }
  if (!isGuid(paymentId)) {
    throw ProblemError.of("VALIDATION_FAILED", { detail: "`id` must be a UUID.", path: "id" });
  }
  if (input.amount_cents <= 0) {
    throw ProblemError.of("VALIDATION_FAILED", {
      detail: "amount_cents must be greater than zero.",
      path: "amount_cents",
    });
  }
  let staffId: string | null = null;
  if (input.staff_id) {
    const s = isGuid(input.staff_id)
      ? await ctx.driver.getStaffById(tenantId, input.staff_id)
      : null;
    if (!s || !s.active) throw notFound("Staff member");
    staffId = s.id;
  }
  const wanted: ExternalWanted = {
    method: input.method,
    processor: input.processor,
    processorRef: norm(input.processor_ref),
    amountCents: input.amount_cents,
    tipCents: input.tip_cents,
    requestedStatus: input.status,
    collection,
    staffId,
  };
  const conflict = () =>
    ProblemError.of("IDEMPOTENCY_CONFLICT", {
      detail: "This id is already in use or was used with a different request.",
    });
  // A tender that already exists: the same request replays (and re-runs the
  // settlement step, which is idempotent); anything else answers like a foreign id.
  const replay = async (existing: Payment): Promise<Reply> => {
    if (
      existing.tenant_id !== tenantId ||
      existing.order_id !== order.id ||
      existing.rail !== "external" ||
      !sameExternal(existing, wanted)
    ) {
      throw conflict();
    }
    await settleOrderAfterExternalTender(existing);
    return {
      status: 200,
      body: toContractPayment((await ctx.driver.getPayment(existing.id)) ?? existing),
      headers: { "idempotent-replayed": "true" },
    };
  };

  for (let attempt = 0; attempt < 4; attempt++) {
    const current = await ownedOrder(ctx, order.id);
    if (CLOSED_FOR_TENDERS.includes(current.status)) {
      throw ProblemError.of("INVALID_TRANSITION", {
        detail: `Order is ${current.status}; it can no longer take a payment.`,
      });
    }
    const existing = await ctx.driver.getPayment(paymentId);
    if (existing) return replay(existing);

    // Hold rule: an expired hold takes no promise of money (nothing to wait for);
    // CAPTURED money that already changed hands is still recorded.
    const heldUntil = current.status === "draft" ? current.hold?.expires_at : null;
    if (
      heldUntil &&
      Date.parse(heldUntil) <= ctx.now().getTime() &&
      input.status !== "captured"
    ) {
      throw ProblemError.of("CONFLICT", {
        detail: "The order's hold expired; only a captured payment can still be recorded.",
        details: { reason: "expired" },
      });
    }

    const tenders = await ctx.driver.listPaymentsForOrder(current.id);
    // FOOD amount due (tips never reduce it), net of refunds beyond the tip: the
    // same base the release check uses.
    const due = Math.max(
      0,
      orderDueCents(current) - netSettledBaseCents(tenders, current.currency),
    );
    const bad = checkTenderAmounts(
      { amount_due_cents: due, tenders },
      { amount_cents: input.amount_cents, tip_cents: input.tip_cents },
    );
    if (bad) {
      throw ProblemError.of("VALIDATION_FAILED", {
        detail: bad.detail,
        path: bad.path,
        details: { reason: bad.reason, amount_due_cents: due },
      });
    }

    const res = await ctx.driver.recordExternalTender({
      tenantId,
      orderId: current.id,
      paymentId,
      method: wanted.method,
      processor: wanted.processor,
      processorRef: wanted.processorRef,
      amountCents: wanted.amountCents,
      tipCents: wanted.tipCents,
      // `authorized` and `pending` never count toward the balance.
      status: input.status === "captured" ? "captured" : "pending",
      requestedStatus: wanted.requestedStatus,
      collection: wanted.collection,
      staffId: wanted.staffId,
      expect: tenderFingerprint(tenders),
      // Server-derived from the verified token; never from the request body.
      recordedBy: { principal_id: ctx.principal.id, module: ctx.principal.module ?? null },
    });
    switch (res.outcome) {
      case "stale":
        continue; // the order's tenders changed under us: re-read, re-validate
      case "not_found":
        throw notFound("Order");
      case "invalid_state":
        throw ProblemError.of("INVALID_TRANSITION", {
          detail: `Order is ${res.status}; it can no longer take a payment.`,
        });
      case "exists":
        return replay(res.payment);
      case "duplicate_ref": {
        // The same real-world payment recorded again under another key: the same
        // order and amount is a retry; anything else would double count it.
        const d = res.payment;
        if (d.order_id === current.id && d.amount_cents === wanted.amountCents) {
          await settleOrderAfterExternalTender(d);
          return {
            status: 200,
            body: toContractPayment(d),
            headers: { "idempotent-replayed": "true" },
          };
        }
        throw ProblemError.of("CONFLICT", {
          detail: "A captured payment with this processor and reference is already recorded.",
          details: { reason: "duplicate_processor_ref" },
        });
      }
      case "ok": {
        await settleOrderAfterExternalTender(res.payment);
        return {
          status: 201,
          body: toContractPayment((await ctx.driver.getPayment(res.payment.id)) ?? res.payment),
          headers: { location: `/api/v1/payments/${res.payment.id}` },
        };
      }
    }
  }
  // Contended order: the modules retry this exact reason with backoff.
  throw ProblemError.of("CONFLICT", {
    detail: "Another tender for this order is being recorded; retry.",
    details: { reason: "tender_in_progress" },
  });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

interface CompiledRoute {
  op: V1Operation | ExtraOperation;
  method: string;
  regex: RegExp;
  names: string[];
  scopes: readonly string[];
  static: number;
}

const ROUTE_DEFS: [V1Operation | ExtraOperation, { method: string; path: string; scopes: readonly string[] }][] = [
  ...(Object.keys(V1_ROUTES) as V1Operation[]).map(
    (op) => [op, V1_ROUTES[op]] as [V1Operation, (typeof V1_ROUTES)[V1Operation]],
  ),
  ...(Object.keys(EXTRA_ROUTES) as ExtraOperation[]).map(
    (op) => [op, EXTRA_ROUTES[op]] as [ExtraOperation, (typeof EXTRA_ROUTES)[ExtraOperation]],
  ),
];

const ROUTES: CompiledRoute[] = ROUTE_DEFS
  .map(([op, def]) => {
    const names: string[] = [];
    const pattern = def.path.replace(/\{(\w+)\}/g, (_, n: string) => {
      names.push(n);
      return "([^/]+)";
    });
    return {
      op,
      method: def.method,
      regex: new RegExp(`^${pattern}$`),
      names,
      scopes: def.scopes as readonly string[],
      static: names.length,
    };
  })
  .sort((a, b) => a.static - b.static);

function problemResponse(p: Problem, requestId: string): Response {
  return new Response(JSON.stringify({ ...p, request_id: requestId }), {
    status: p.status,
    headers: {
      "content-type": PROBLEM_CONTENT_TYPE,
      "x-request-id": requestId,
      "cache-control": "no-store",
    },
  });
}

export async function handleV1(
  req: Request,
  segments: string[],
  deps: V1Deps = {},
): Promise<Response> {
  const requestId = req.headers.get("x-request-id") ?? globalThis.crypto.randomUUID();
  const path = `/${segments.join("/")}`;
  try {
    let route: CompiledRoute | undefined;
    let params: Record<string, string> = {};
    for (const r of ROUTES) {
      if (r.method !== req.method) continue;
      const m = r.regex.exec(path);
      if (m) {
        route = r;
        try {
          params = Object.fromEntries(
            r.names.map((n, i) => [n, decodeURIComponent(m[i + 1]!)]),
          );
        } catch {
          throw ProblemError.of("VALIDATION_FAILED", {
            detail: "Malformed percent-encoding in the path.",
            status: 400,
          });
        }
        break;
      }
    }

    // Authenticate BEFORE revealing whether a route exists.
    const principal = deps.principal ?? (await authenticateV1(req, deps.auth));
    if (!route) throw ProblemError.of("NOT_FOUND", { detail: `No route ${req.method} ${path}.` });
    // A kiosk holds `payments.terminal:write` instead of `payments:write`: it may
    // reach recordExternal, and the handler then allows only a captured terminal
    // tender (so this can never widen what the token may do).
    const terminalOnly =
      route.op === "payments.recordExternal" &&
      !hasScopes(principal.scopes, route.scopes) &&
      hasScopes(principal.scopes, [TERMINAL_PAYMENT_SCOPE]);
    if (!terminalOnly) requireScopes(principal, route.scopes);
    if (params.location_id) requireLocation(principal, params.location_id);

    if (
      (UNSUPPORTED as string[]).includes(route.op) ||
      !handlers[route.op]
    ) {
      throw unsupported(route.op);
    }
    const reply = await handlers[route.op]!({
      terminalOnly,
      req,
      url: new URL(req.url),
      params,
      principal,
      driver: deps.driver ?? getPosDriver(),
      now: deps.now ?? (() => new Date()),
      requestId,
    });
    const status = reply.status ?? 200;
    return new Response(status === 304 ? null : JSON.stringify(reply.body ?? {}), {
      status,
      headers: {
        "content-type": "application/json",
        "x-request-id": requestId,
        "cache-control": "no-store",
        ...reply.headers,
      },
    });
  } catch (err) {
    if (isProblemError(err)) return problemResponse(err.problem, requestId);
    console.error("[v1] unhandled error", requestId, err);
    return problemResponse(problem("INTERNAL"), requestId);
  }
}
