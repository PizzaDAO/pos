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
 * deliveries (read + `updateStatus`), sales (summary, daily, hourly, items), tips
 * (list), kitchen load, allergen publication (stored and announced only).
 * Declared but unsupported by POS answer 501 CAPABILITY_UNSUPPORTED:
 * orders.updateStatus, events.list (events go out by webhook).
 * `staff.verifyPin` is a HUB_ROUTES operation: it is added to the route table by
 * hand (EXTRA_ROUTES).
 *
 * Payment sessions are the ONLY /v1 path that can reach Stripe. They are gated on
 * the server (`assertSessionChargeAllowed` in payment-sessions.ts): simulated
 * mode or a positively identified Stripe TEST key only; live keys answer 501
 * unless the tenant is explicitly allow-listed.
 */
import { scheduleAutoPrint } from "@/lib/printing/queue";
import {
  AllergenPublishInputSchema,
  AvailabilityUpdateSchema,
  CustomerUpsertInputSchema,
  DeliveryStatusUpdateSchema,
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
  SalesRangeQuerySchema,
  SalesSummaryQuerySchema,
  StaffPinSetInputSchema,
  StaffPinVerifyInputSchema,
  V1_ROUTES,
  checkTenderAmounts,
  extendedHoldExpiry,
  fromPosOrderStatus,
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
  type OrderStatus,
  type Payment,
  type PosDriver,
  type OrderFulfillment,
} from "@/lib/db";
import type { StoredQuote } from "@/lib/db/payment-types";
import { deploymentCheckoutMode } from "@/lib/payments/env";
import { isGuid, isIsoTimestamp } from "@/lib/db/paging";
import { isUnpaidOnlineStatus } from "@/lib/db/menu-types";
import { cancelDeliveryForOrder } from "@/lib/delivery/service";
import { DRIVER_CONFLICT_MARK } from "@/lib/delivery/attention";
import { captureError } from "@/lib/observability";
import {
  SCHEDULED_PAID_GRACE_MS,
  cancelOpenOnlineIntents,
  flagStrandedScheduled,
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
  mapOrders,
  type LocationBundle,
} from "./loaders";
import {
  toPosOrderStatus,
  toContractAllergenPublication,
  toContractCustomer,
  toContractPayment,
  toContractStaff,
  toContractTenant,
} from "./mappers";
import { phoneKey } from "@/lib/db/customer-identity";
import type {
  CustomerConsent,
  DeliveryPatch,
  OrderCoreExt,
  OrderFeeLine,
} from "@/lib/db";
import { hashPin, verifyPin } from "@/lib/auth/pin";
import { tenderFingerprint } from "@/lib/db/payment-types";
import { netSettledBaseCents } from "./money";
import {
  createPaymentSession,
  getPaymentsAccount,
  loadPaymentSession,
  toContractSession,
} from "./payment-sessions";
import { buildDailySales, buildHourlySales, buildItemSales, buildSalesSummary, isSalesRow } from "./sales";
import { buildKitchenLoad, KITCHEN_LOAD_WINDOW_MS } from "./kitchen-load";
import { RangeTooLarge, loadHeadsInRange, loadTipFacts, type TipCursor } from "./range-loader";

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

/**
 * Larger budget for the one route that carries a whole matrix: 20,000 allergen
 * rows. (Vercel's own request cap is 4.5 MB, so this is the most a deployment can
 * deliver anyway.)
 */
const MAX_ALLERGEN_BODY_BYTES = 4_000_000;

/** Read the JSON body, aborting as soon as the byte budget is exceeded. */
async function readBody(req: Request, maxBytes: number = MAX_BODY_BYTES): Promise<unknown> {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > maxBytes) {
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
      if (received > maxBytes) {
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
 * Fee lines raise what a customer pays and `scheduled` holds park an order for up
 * to 30 days, so both are reserved for the catering module (and, for holds, the
 * terminal). Same trust rule as `recordExternal`: the token's `sub` must be
 * hub-signed (the hub vouches for `op_mod`) outside the zero-env simulation.
 */
function requireCateringModule(ctx: Ctx, what: string): void {
  requireHubSigned(ctx);
  const m = ctx.principal.module ?? null;
  const ok = m === "catering" || (m === null && isSimulatedV1(process.env));
  if (!ok) {
    throw ProblemError.of("FORBIDDEN", {
      detail: `${what} is only available to the catering module.`,
      details: { reason: "module_not_allowed" },
    });
  }
}

/**
 * Custom fee lines: catering only; no `gratuity` lines (a gratuity is a `tip`, and
 * tips follow the tip rules: bounded by maxTipCents, per-tender tip facts, food-only
 * amount due); the same code at most once.
 */
function checkFeeInput(ctx: Ctx, fees: readonly { kind?: string; code: string }[] | undefined): void {
  if (!fees?.length) return;
  requireCateringModule(ctx, "Custom fee lines");
  fees.forEach((f, i) => {
    if (f.kind === "gratuity") {
      throw ProblemError.of("VALIDATION_FAILED", {
        detail: "Gratuity fee lines are not accepted; send the gratuity as `tip`.",
        path: `fees.${i}.kind`,
      });
    }
  });
  if (new Set(fees.map((f) => f.code)).size !== fees.length) {
    throw ProblemError.of("VALIDATION_FAILED", {
      detail: "Fee line codes must be unique.",
      path: "fees",
    });
  }
}

/**
 * Fee cap: all fee lines together may not exceed 50% of the discounted subtotal
 * (5000 bps). Catering service/setup charges sit around 15-30%; 50% leaves room
 * for those while bounding a typo or a hostile caller (an extra $5000 on a $40
 * order). A single percent line is already limited to 100% by the contract, so
 * the total cap is the binding one. No per-tenant override exists yet (it needs a
 * settings column); until then this is a constant.
 */
const MAX_FEES_BPS_OF_SUBTOTAL = 5000;
function checkFeeCap(feesCents: number, subtotalAfterDiscountCents: number): void {
  // Half-up, like core's applyBps, so a 50% percent line on an odd-cent subtotal is not refused.
  const cap = Math.floor((subtotalAfterDiscountCents * MAX_FEES_BPS_OF_SUBTOTAL) / 10_000 + 0.5);
  if (feesCents > cap) {
    throw ProblemError.of("VALIDATION_FAILED", {
      detail: `Fee lines total ${feesCents} cents; at most ${cap} cents (50% of the discounted subtotal) is allowed.`,
      path: "fees",
      details: { fees_cents: feesCents, max_fees_cents: cap },
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
  "menu.allergens.published",
  "tip.recorded",
  "tip.adjusted",
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
        "deliveries.write": true,
        "menu.allergens.publish": true,
        "sales.summary": true,
        "sales.hourly": true,
        "sales.items": true,
        "tips.list": true,
        "kitchen.load": true,
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
        "Custom fee lines (`fees`) are charged to the customer and included in the order total; tax_exempt orders need the literal orders:discount scope.",
        "Hold reasons: awaiting_payment and scheduled (up to 30 days) for any caller; manual only for terminals. `fire_at` is stored and echoed, POS does not release at that time.",
        "Allergen matrices are stored and announced (menu.allergens.published); POS shows them nowhere.",
        "Tip facts carry processing_fee_cents = 0: POS holds no card-processing fee data.",
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
    checkFeeInput(ctx, parsed.data.fees);
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
    if (quote.valid && quote.totals.fees_cents) {
      checkFeeCap(quote.totals.fees_cents, quote.totals.subtotal_cents - quote.totals.discount_cents);
    }
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
    // An expired hold that is FULLY PAID is not an expired order: the money is
    // real (a card paid a `scheduled` hold, then the hold ran out before its
    // release time), so it releases normally instead of being voided/stranded.
    const expired = Boolean(expires) && new Date(expires!).getTime() <= ctx.now().getTime();
    const expiredPayments = expired ? await ctx.driver.listPaymentsForOrder(order.id) : [];
    const paidInFull =
      expired &&
      netSettledBaseCents(expiredPayments, order.currency) >= orderDueCents(order);
    const isScheduled = order.hold?.reason === "scheduled";
    if (paidInFull && isScheduled) {
      // Paid, but the hold ran out long ago: releasing now would fire old food at
      // the kitchen. Past the grace it is not released; staff decide (refund, or
      // recreate it) from the admin "Late payments" list.
      const lateMs = ctx.now().getTime() - new Date(expires!).getTime();
      if (lateMs > SCHEDULED_PAID_GRACE_MS) {
        await flagStrandedScheduled(order, expiredPayments, "paid");
        throw ProblemError.of("CONFLICT", {
          detail:
            "The order is fully paid but its scheduled hold expired too long ago to release it; it was not fired. Staff have been alerted to refund or recreate it.",
          details: { reason: "stranded_paid" },
        });
      }
    }
    if (expired && !paidInFull) {
      // A scheduled order with an invoice still owed is never voided by a lapse:
      // money was promised, so a human decides.
      if (
        isScheduled &&
        expiredPayments.some((p) => p.status === "pending" && p.rail === "external")
      ) {
        await flagStrandedScheduled(order, expiredPayments, "invoice_pending");
        throw ProblemError.of("CONFLICT", {
          detail:
            "The scheduled hold expired while an invoice is still owed; the order was not canceled. Staff have been alerted to decide.",
          details: { reason: "invoice_pending" },
        });
      }
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
        if (captured && isScheduled) {
          // Settled money that does not cover the order (a deposit): partly paid.
          await flagStrandedScheduled(
            order,
            await ctx.driver.listPaymentsForOrder(order.id),
            "partial",
          );
        }
        throw ProblemError.of("CONFLICT", {
          detail: captured
            ? isScheduled
              ? "The scheduled hold expired and the order is only PARTLY paid; it was not released. Staff have been alerted to refund it or collect the balance."
              : "The hold expired but the order holds captured payment; refund it or accept the order."
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
    if (res.ok) scheduleAutoPrint(res.order);
    // Released by hand after all: a still-open "stranded" flag is moot.
    const flag = order.fulfillment?.late_payment;
    if (res.ok && flag && flag.kind === "scheduled" && !flag.resolved) {
      await ctx.driver
        .updateLatePayment(order.id, {
          resolved: "released",
          resolved_at: ctx.now().toISOString(),
          claim: null,
          claim_at: null,
        })
        .catch((err) => captureError(err, { scope: "v1.orders.release.unflag", orderId: order.id }));
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
      const phoneCountry = await tenantCountry(tenantId, ctx.driver);
      // Keyset-page through ALL customers (no silent 1000-row truncation).
      let after: { created_at: string; id: string } | undefined;
      for (let guard = 0; guard < 400 && !found; guard++) {
        const batch = await ctx.driver.listCustomers(tenantId, { after, limit: 500 });
        const key = phoneKey(phone, phoneCountry);
        found = key
          ? (batch.find((c) => phoneKey(c.phone, phoneCountry) === key) ?? null)
          : null;
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
      // National numbers are read in the tenant's country: 'US' when its location
      // stores none (the boundary default), the stored code otherwise (a non-US/CA
      // country gives national numbers no comparison key, never a guess).
      country: await tenantCountry(tenantId, ctx.driver),
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

  /**
   * POST /deliveries/{id}/status (0.3.0): a delivery partner (the driver module, a
   * dispatcher) reports progress. 200 with the Delivery; 404 for an unknown or
   * foreign id; 409 INVALID_TRANSITION when the delivery already finished
   * (delivered, canceled, failed) and the update asks for a different status.
   * Replaying an update is a no-op. `tracking_url` is stored as `tracking_ref`.
   * The write is a compare-and-set (never while terminal), so a late update cannot
   * reopen a finished delivery. `picked_up`/`delivering` move the ORDER to
   * `out_for_delivery` and `delivered` to `completed`, each as its own
   * compare-and-set (a replay heals an order write that was lost). `canceled` and
   * `failed` leave the order alone: whether to refund or re-dispatch is a human call.
   */
  "deliveries.updateStatus": async (ctx) => {
    await requireActiveTenant(ctx);
    const parsed = DeliveryStatusUpdateSchema.safeParse(await readBody(ctx.req));
    if (!parsed.success) throw zodProblem(parsed.error);
    const u = parsed.data;
    const tenantId = ctx.principal.tenant_id;
    const id = ctx.params.delivery_id!;
    const rec = await ctx.driver.getDelivery(id);
    if (!rec || rec.tenant_id !== tenantId || !allowedLocation(ctx.principal, rec.location_id)) {
      throw notFound("Delivery");
    }
    // Only providers whose state is PUSHED may be updated here. DoorDash Drive (and
    // anything else that reports through its own tracking) owns its status and ids;
    // a push must never overwrite them.
    if (!PUSHED_DELIVERY_PROVIDERS.includes(rec.provider)) {
      throw ProblemError.of("CONFLICT", {
        detail: `This delivery is run by ${rec.provider}; its status comes from that provider, not from /v1.`,
        details: { reason: "provider_owned" },
      });
    }
    // The driver module may only report on deliveries POS handed to it: a delivery
    // switched to manual (or run by anyone else), or one the driver reports under
    // a different delivery id than the stored one, is refused (409). Other callers
    // are unchanged.
    if (ctx.principal.module === "driver") {
      const wrongId =
        u.provider_delivery_id &&
        rec.provider_delivery_id !== null &&
        rec.provider_delivery_id !== u.provider_delivery_id;
      if (rec.provider !== "openpizza_driver" || wrongId) {
        console.error(
          `[pos][ALERT] driver status push refused for delivery ${id}: ${
            rec.provider !== "openpizza_driver"
              ? `delivery is run by ${rec.provider}`
              : "provider_delivery_id does not match the stored one"
          }`,
        );
        throw ProblemError.of("INVALID_TRANSITION", {
          detail:
            rec.provider !== "openpizza_driver"
              ? `This delivery is run by ${rec.provider}, not the driver module.`
              : "The driver's delivery id does not match this delivery.",
        });
      }
    }
    const patch: DeliveryPatch = { status: u.status };
    if (u.driver !== undefined) {
      patch.driver_name = u.driver?.name ?? null;
      patch.driver_phone = u.driver?.phone ?? null;
    }
    if (u.eta_minutes !== undefined) patch.eta_minutes = u.eta_minutes ?? null;
    if (u.tracking_url) patch.tracking_ref = u.tracking_url;
    if (u.provider_delivery_id) patch.provider_delivery_id = u.provider_delivery_id;

    const differs = (r: typeof rec) =>
      r.status !== patch.status ||
      (patch.driver_name !== undefined && r.driver_name !== patch.driver_name) ||
      (patch.driver_phone !== undefined && r.driver_phone !== patch.driver_phone) ||
      (patch.eta_minutes !== undefined && r.eta_minutes !== patch.eta_minutes) ||
      (patch.tracking_ref !== undefined && r.tracking_ref !== patch.tracking_ref) ||
      (patch.provider_delivery_id !== undefined &&
        r.provider_delivery_id !== patch.provider_delivery_id);
    const invalid = (r: typeof rec) =>
      ProblemError.of("INVALID_TRANSITION", {
        detail: `The delivery is ${r.status}; it cannot become ${patch.status}.`,
      });

    let current = rec;
    if (TERMINAL_DELIVERY.includes(rec.status)) {
      // Finished: the same status is a replay (no-op), anything else is refused.
      if (rec.status !== patch.status) throw invalid(rec);
    } else if (differs(rec)) {
      const res = await ctx.driver.transitionDelivery(id, tenantId, patch);
      if (!res.ok) {
        if (res.reason === "not_found") throw notFound("Delivery");
        // Finished while we were writing: same rule as above.
        if (res.delivery.status !== patch.status) throw invalid(res.delivery);
        current = res.delivery;
      } else {
        current = res.delivery;
      }
    }

    // The driver's push carries its id: any "waiting for the push" conflict mark is stale.
    if (
      rec.provider === "openpizza_driver" &&
      u.provider_delivery_id &&
      current.dispatch_error === DRIVER_CONFLICT_MARK
    ) {
      await ctx.driver.updateDriverDispatch(id, tenantId, {
        expect_status: current.status,
        dispatch_error: null,
        dispatch_next_at: null,
      });
    }

    const target =
      patch.status === "picked_up" || patch.status === "delivering"
        ? "out_for_delivery"
        : patch.status === "delivered"
          ? "completed"
          : null;
    if (target) {
      await ctx.driver.transitionOrderStatus(
        current.order_id,
        target === "completed"
          ? ["out_for_delivery", "ready", "in_kitchen", "paid", "placed", "recall"]
          : ["ready", "in_kitchen", "paid", "placed", "recall"],
        target,
      );
    }
    const body = await loadDelivery(tenantId, id, ctx.driver);
    if (!body) throw notFound("Delivery");
    return { body };
  },

  /**
   * PUT /catalog/allergens (backofhouse): store the allergen matrix and announce
   * `menu.allergens.published`. STORED AND ANNOUNCED ONLY: no POS surface shows
   * allergens to a guest (decision 2026-11-01). Same version + hash replays (200);
   * same version with another hash is IDEMPOTENCY_CONFLICT; a target (item, size or
   * modifier) or location that is not this tenant's is refused as a whole and
   * nothing is written (checked in SQL: the service key bypasses RLS). A token
   * limited to some locations cannot publish (the matrix is tenant-wide).
   */
  "menu.publishAllergens": async (ctx) => {
    await requireActiveTenant(ctx);
    const parsed = AllergenPublishInputSchema.safeParse(
      await readBody(ctx.req, MAX_ALLERGEN_BODY_BYTES),
    );
    if (!parsed.success) throw zodProblem(parsed.error);
    const i = parsed.data;
    // The matrix is tenant-wide and a publication REPLACES it, so a token limited
    // to some locations may not publish at all (it would rewrite rows for
    // locations it cannot see).
    if (scopedLocationIds(ctx.principal)) {
      throw ProblemError.of("FORBIDDEN", {
        detail: "A location-limited token cannot publish the allergen matrix; it is tenant-wide.",
      });
    }
    const res = await ctx.driver.publishAllergens(ctx.principal.tenant_id, {
      version: i.version,
      payload_hash: i.payload_hash,
      location_ids: i.location_ids?.length ? i.location_ids : null,
      published_by: i.published_by ?? ctx.principal.module ?? null,
      rows: i.rows.map((r) => ({
        target_type: r.target_type,
        target_id: r.target_id,
        contains: r.contains,
        may_contain: r.may_contain,
        tags: r.tags,
      })),
    });
    switch (res.outcome) {
      case "conflict":
        throw ProblemError.of("IDEMPOTENCY_CONFLICT", {
          detail: "This version was already published with a different payload.",
        });
      case "unknown_target":
        throw ProblemError.of("ITEM_NOT_FOUND", {
          detail: `Not on this tenant's menu: ${res.ids.slice(0, 5).join(", ")}.`,
          path: "rows.target_id",
        });
      case "unknown_location":
        throw ProblemError.of("NOT_FOUND", {
          detail: `Location not found: ${res.ids.slice(0, 5).join(", ")}.`,
          path: "location_ids",
        });
      case "duplicate":
        throw ProblemError.of("VALIDATION_FAILED", {
          detail: `A target appears twice: ${res.ids.slice(0, 5).join(", ")}.`,
          path: "rows",
        });
      default: {
        const pub = res.publication;
        return {
          status: 200,
          body: toContractAllergenPublication(pub),
          ...(res.outcome === "replay" ? { headers: { "idempotent-replayed": "true" } } : {}),
        };
      }
    }
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

  "sales.hourly": async (ctx) => {
    const bundle = await ownedLocation(ctx, ctx.params.location_id!);
    const q = parseRange(ctx.url.searchParams);
    const timezones = new Map([[bundle.location.id, bundle.location.timezone]]);
    // Header rows only (no item graph, no mapping): hourly needs status, times
    // and totals. The derivations below are the mapper's own, so it ties to daily.
    const heads = await guardRange(() =>
      loadHeadsInRange(ctx.driver, ctx.principal.tenant_id, {
        locationIds: [bundle.location.id],
        from: q.from,
        to: q.to,
        timezones,
      }),
    );
    const orders = heads
      .filter((h) => !isUnpaidOnlineStatus(h.status))
      .map((h) => ({
        location_id: h.location_id,
        business_date: h.business_date,
        fulfillment_status: fromPosOrderStatus(toPosOrderStatus(h.status)).fulfillment_status,
        placed_at: h.status === "draft" ? null : new Date(h.created_at).toISOString(),
        created_at: new Date(h.created_at).toISOString(),
        totals: h.totals,
      }));
    return { body: { data: buildHourlySales({ from: q.from, to: q.to, orders, timezones }) } };
  },

  "sales.items": async (ctx) => {
    const q = parseRange(ctx.url.searchParams);
    const { ids, bundles } = await rangeLocations(ctx, q.location_id);
    const orders = await loadRangeOrders(ctx, ids, q);
    // Category per item from the menu (lines already carry category_id when POS
    // wrote it; older lines fall back to the current menu).
    const categoryOfItem = new Map<string, string>();
    if (orders.some((o) => o.lines.some((l) => !l.voided && !l.category_id))) {
      for (const b of bundles) {
        const menu = await loadMenu(b, ctx.driver);
        for (const c of menu.categories) {
          for (const i of c.items) categoryOfItem.set(i.id, c.id);
        }
      }
    }
    return {
      body: { data: buildItemSales({ from: q.from, to: q.to, orders, categoryOfItem }) },
    };
  },

  "tips.list": async (ctx) => {
    const sp = ctx.url.searchParams;
    const q = parseRange(sp);
    const limit = parseLimit(sp);
    const cursor = parseTipCursor(sp.get("cursor"));
    const { ids, bundles } = await rangeLocations(ctx, q.location_id);
    const facts = await guardRange(() =>
      loadTipFacts(ctx.driver, ctx.principal.tenant_id, {
        locationIds: ids,
        from: q.from,
        to: q.to,
        timezones: new Map(bundles.map((b) => [b.location.id, b.location.timezone])),
        cursor,
        need: limit,
      }),
    );
    const data = facts.slice(0, limit);
    const last = data[data.length - 1];
    return {
      body: {
        data,
        next_cursor:
          facts.length > limit && last
            ? Buffer.from(JSON.stringify([last.business_date, last.occurred_at, last.id])).toString("base64url")
            : null,
      },
    };
  },

  "kitchen.load": async (ctx) => {
    const bundle = await ownedLocation(ctx, ctx.params.location_id!);
    const now = ctx.now();
    const tenantId = ctx.principal.tenant_id;
    const since = new Date(now.getTime() - KITCHEN_LOAD_WINDOW_MS).toISOString();
    // SQL does the filtering: only the board's statuses, newest first, capped;
    // the last-15-minutes count reads header rows only.
    const [activeHeads, recentHeads] = await Promise.all([
      ctx.driver.listOrderHeads(tenantId, {
        locationIds: [bundle.location.id],
        createdFrom: since,
        statuses: KITCHEN_POS_STATUSES,
        newestFirst: true,
        limit: 300,
      }),
      ctx.driver.listOrderHeads(tenantId, {
        locationIds: [bundle.location.id],
        createdFrom: new Date(now.getTime() - 15 * 60_000).toISOString(),
        newestFirst: true,
        limit: 500,
      }),
    ]);
    const active = await mapOrders(
      await ctx.driver.getOrdersByIds(tenantId, activeHeads.map((h) => h.id)),
      () => bundle.location.timezone,
      ctx.driver,
    );
    active.sort((a, b) => b.created_at.localeCompare(a.created_at));
    const recent = recentHeads.filter((h) => !["draft", "voided", "abandoned", "awaiting_payment"].includes(h.status)).length;
    return {
      body: buildKitchenLoad({
        location_id: bundle.location.id,
        orders: active,
        recent_count: recent,
        prep_minutes: bundle.settings.fulfillment?.prep_minutes ?? bundle.contract.fulfillment.prep_minutes,
        accepting_orders: bundle.contract.fulfillment.accepting_orders,
        now,
      }),
    };
  },
};

/** POS statuses that can be on the board (contract placed/accepted/preparing/ready). */
const KITCHEN_POS_STATUSES: OrderStatus[] = ["placed", "paid", "in_kitchen", "ready", "recall"];

const MAX_RANGE_DAYS = 93;
const ITEMS_ROW_CAP = 5_000;

function parseLimit(sp: URLSearchParams): number {
  const raw = sp.get("limit");
  const limit = raw ? Number(raw) : DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw ProblemError.of("VALIDATION_FAILED", {
      detail: `limit must be an integer 1..${MAX_LIMIT}.`,
    });
  }
  return limit;
}

/** Tip cursor: [business_date, occurred_at, id] (fact ids are strings, not GUIDs). */
function parseTipCursor(raw: string | null): TipCursor | undefined {
  if (!raw) return undefined;
  try {
    const v = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (
      Array.isArray(v) &&
      typeof v[0] === "string" &&
      /^\d{4}-\d{2}-\d{2}$/.test(v[0]) &&
      isIsoTimestamp(v[1]) &&
      typeof v[2] === "string" &&
      /^[\w:.-]{1,200}$/.test(v[2])
    ) {
      return { business_date: v[0], occurred_at: v[1], id: v[2] };
    }
  } catch {
    /* fallthrough */
  }
  throw ProblemError.of("VALIDATION_FAILED", { detail: "Invalid cursor." });
}

/** A range that would not fit the caps answers 422 early, never a timeout. */
async function guardRange<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof RangeTooLarge) {
      throw ProblemError.of("VALIDATION_FAILED", { detail: e.message });
    }
    throw e;
  }
}

/** `?from&to[&location_id]` (SalesRangeQuery): dates valid, ordered, and at most 93 days. */
function parseRange(sp: URLSearchParams): { from: string; to: string; location_id?: string } {
  const parsed = SalesRangeQuerySchema.safeParse({
    from: sp.get("from") ?? undefined,
    to: sp.get("to") ?? undefined,
    location_id: sp.get("location_id") ?? undefined,
  });
  if (!parsed.success) throw zodProblem(parsed.error);
  const { from, to } = parsed.data;
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
  if (!Number.isFinite(days) || days < 0 || days > MAX_RANGE_DAYS) {
    throw ProblemError.of("VALIDATION_FAILED", {
      detail: `from..to must be a forward range of at most ${MAX_RANGE_DAYS} days.`,
      path: "to",
    });
  }
  return parsed.data;
}

/** Locations a range read covers: the named one (owned), else the token's allowed ones. */
async function rangeLocations(
  ctx: Ctx,
  locationId: string | undefined,
): Promise<{ ids: string[] | null; bundles: LocationBundle[] }> {
  if (locationId) {
    const b = await ownedLocation(ctx, locationId);
    return { ids: [b.location.id], bundles: [b] };
  }
  const ids = scopedLocationIds(ctx.principal);
  const bundles = (await loadLocations(ctx.principal.tenant_id, ctx.driver)).filter(
    (b) => !ids || ids.includes(b.location.id),
  );
  return { ids, bundles };
}

/**
 * Orders (full, mapped) whose business_date is in [from, to]; used by sales.items,
 * which needs lines. Bounded by the padded created_at window (SQL) and a small
 * row cap that aborts as soon as it is crossed (422), not after paging it all.
 */
async function loadRangeOrders(
  ctx: Ctx,
  locationIds: string[] | null,
  q: { from: string; to: string },
): Promise<CoreOrder[]> {
  const orders = await loadTenantOrders(ctx.principal.tenant_id, {
    locationIds,
    ...paddedRange(q.from, q.to),
    maxRows: ITEMS_ROW_CAP + 1,
    rowFilter: isSalesRow,
    driver: ctx.driver,
  });
  if (orders.length > ITEMS_ROW_CAP) {
    throw ProblemError.of("VALIDATION_FAILED", {
      detail:
        "That range holds too many orders for one request; ask for at most 7 days at a time (or pass location_id).",
    });
  }
  return orders.filter((o) => o.business_date >= q.from && o.business_date <= q.to);
}

/** business_date is location-local: pad the UTC created_at window by a day each side. */
function paddedRange(from: string, to: string): { createdFrom: string; createdTo: string } {
  const t = (d: string, days: number) =>
    new Date(new Date(`${d}T00:00:00Z`).getTime() + days * 86_400_000).toISOString();
  return { createdFrom: t(from, -1), createdTo: t(to, 2) };
}

/** Delivery providers whose state partners push through deliveries.updateStatus. */
const PUSHED_DELIVERY_PROVIDERS: readonly string[] = ["openpizza_driver", "in_house_manual"];
const TERMINAL_DELIVERY: readonly string[] = ["delivered", "canceled", "failed"];

const UNSUPPORTED: V1Operation[] = ["orders.updateStatus", "events.list"];

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
    // Every priced input is part of "the same request": fees, tax status and tip
    // (from the quote when the request carries a quote_id).
    let sentFees = input.fees;
    let sentExempt = input.tax_exempt;
    let sentTip = input.tip;
    if (!sentLines && input.quote_id) {
      const q = await ctx.driver.getQuote(tenantId, input.quote_id);
      if (q) {
        const qr = QuoteRequestSchema.parse(q.request);
        sentLines = qr.lines;
        sentFees = qr.fees;
        sentExempt = input.tax_exempt || qr.tax_exempt;
        sentTip = input.tip !== undefined ? input.tip : qr.tip;
      }
    }
    if (sentLines) {
      const feeKey = (f: { code: string; amount_cents?: number | null; percent_bps?: number | null; taxable?: boolean }) =>
        `${f.code}|${f.amount_cents ?? ""}|${f.percent_bps ?? ""}|${f.taxable ? 1 : 0}`;
      const sentFeeKeys = (sentFees ?? []).map(feeKey).sort().join(";");
      // A stored percent line keeps its percent AND the resolved amount, so a
      // replay of either spelling matches.
      const hadFeeKeys = (existing.core_ext?.fees ?? [])
        .map((f) =>
          sentFees?.find((x) => x.code === f.code)?.percent_bps !== undefined
            ? feeKey({ code: f.code, percent_bps: f.percent_bps, taxable: f.taxable })
            : feeKey({ code: f.code, amount_cents: f.amount_cents, taxable: f.taxable }),
        )
        .sort()
        .join(";");
      if (sentFeeKeys !== hadFeeKeys) throw conflict();
      if (Boolean(sentExempt) !== Boolean(existing.core_ext?.tax_exempt)) throw conflict();
      const hadTip = existing.totals.tip_cents;
      if (sentTip) {
        if ("amount_cents" in sentTip) {
          if (sentTip.amount_cents !== hadTip) throw conflict();
        } else {
          const base = existing.totals.subtotal_cents - existing.totals.discount_cents;
          // Percent tips round in core; a one-cent tolerance covers the rounding mode.
          if (Math.abs(hadTip - (base * sentTip.percent_bps) / 10_000) > 1) throw conflict();
        }
      } else if (hadTip !== 0) {
        throw conflict();
      }
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
  let feesIn = input.fees;
  let taxExemptIn = input.tax_exempt;
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
    // Fees and tax status are part of what was quoted: they come from the quote
    // (and are re-priced below), never from a second source on the order request.
    if (input.fees?.length) {
      throw ProblemError.of("VALIDATION_FAILED", {
        detail: "Fee lines belong on the quote; do not send `fees` with a quote_id.",
        path: "fees",
      });
    }
    feesIn = req.fees;
    taxExemptIn = input.tax_exempt || req.tax_exempt;
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
  checkFeeInput(ctx, feesIn);
  if (fulfillmentIn?.type === "delivery") {
    throw unsupported("delivery orders", "Delivery orders cannot be created through /v1 yet.");
  }
  // Tax exemption lowers what the customer pays: an owner/manager power, like
  // discounts, so it needs the explicit scope.
  if (taxExemptIn && !hasLiteralScope(ctx.principal, "orders:discount")) {
    throw ProblemError.of("INSUFFICIENT_SCOPE", {
      detail: "missing scope(s): orders:discount (must be granted explicitly) for tax_exempt orders",
      details: { missing: ["orders:discount"], granted: ctx.principal.scopes },
    });
  }

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
      tax_exempt: taxExemptIn,
      customer_id: customerIdIn ?? null,
      ...(feesIn?.length ? { fees: feesIn } : {}),
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
  if (quote.totals.fees_cents) {
    checkFeeCap(quote.totals.fees_cents, quote.totals.subtotal_cents - quote.totals.discount_cents);
  }
  const feeLines: OrderFeeLine[] = (quote.fee_lines ?? []).map((f) => ({
    code: f.code,
    kind: f.kind,
    label: f.label,
    percent_bps: f.percent_bps ?? null,
    amount_cents: f.amount_cents,
    taxable: f.taxable,
  }));
  let priced;
  try {
    priced = await priceOrder({
      tenantId,
      locationId: input.location_id,
      items: rawItems,
      discountCents: quote.totals.discount_cents,
      tipCents: quote.totals.tip_cents,
      settings: bundle.settings,
      // Fee amounts as PRICED by priceCart (percent lines resolved), so both
      // totals are derived from the same figures; the drift check below compares.
      fees: feeLines,
      taxExempt: taxExemptIn,
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

  const now = ctx.now();
  // Held unless a terminal takes the order at the counter (or invoices it).
  // Every caller may ask for an `awaiting_payment` or `scheduled` hold. Any other
  // reason (`manual`, ...) is a terminal's: the held-order sweeper only expires
  // `awaiting_payment` holds, so a reason chosen by an arbitrary caller would
  // leave orders held forever. That used to be silently rewritten to
  // awaiting_payment; it is refused now.
  const wantsHold = Boolean(input.hold) || input.payment_intent === "prepaid" || !terminal;
  const requestedReason = input.hold?.reason;
  if (
    wantsHold &&
    !terminal &&
    requestedReason !== undefined &&
    requestedReason !== "awaiting_payment" &&
    requestedReason !== "scheduled"
  ) {
    throw ProblemError.of("VALIDATION_FAILED", {
      detail: `Hold reason "${requestedReason}" is only available to terminals; use awaiting_payment (or scheduled, catering only).`,
      path: "hold.reason",
    });
  }
  if (wantsHold && !terminal && requestedReason === "scheduled") {
    // A scheduled hold parks an order for up to 30 days: catering (or a terminal).
    requireCateringModule(ctx, "A scheduled hold");
  }
  const holdReason = !wantsHold ? null : (requestedReason ?? "awaiting_payment");
  // The reason is what bounds the ttl: only `scheduled` may run up to 30 days.
  // The schema already enforces this; a request over the cap is refused, never
  // shortened.
  const ttl = input.hold?.ttl_seconds ?? 900;
  if (holdReason && ttl > holdCapSeconds(holdReason)) {
    throw ProblemError.of("VALIDATION_FAILED", {
      detail: `A ${holdReason} hold can last at most ${holdCapSeconds(holdReason)} seconds.`,
      path: "hold.ttl_seconds",
    });
  }
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

  const metadata = input.metadata && Object.keys(input.metadata).length ? input.metadata : undefined;
  const coreExt: OrderCoreExt = {
    ...(feeLines.length ? { fees: feeLines } : {}),
    ...(taxExemptIn ? { tax_exempt: true } : {}),
    ...(input.callout_name?.trim() ? { callout_name: input.callout_name.trim() } : {}),
    ...(metadata ? { metadata } : {}),
    ...(input.fire_at ? { fire_at: input.fire_at } : {}),
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
    ...(Object.keys(coreExt).length ? { core_ext: coreExt } : {}),
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
  // Held (draft) orders print when released; placed orders fire now.
  scheduleAutoPrint(order);
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
