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
 * quotes (stateless), orders (list/get/create held/cancel/release), payments
 * (read), customers (read), staff, drawer sessions, deliveries (read), sales.
 * Declared but unsupported by POS answer 501 CAPABILITY_UNSUPPORTED:
 * orders.updateStatus, payments.recordExternal, customers.upsert,
 * deliveries.updateStatus, quotes.get, events.list (events go out by webhook).
 */
import {
  AvailabilityUpdateSchema,
  EVENT_TYPES,
  OrderCancelInputSchema,
  OrderCreateInputSchema,
  OrderListQuerySchema,
  PROBLEM_CONTENT_TYPE,
  ProblemError,
  QuoteRequestSchema,
  SalesSummaryQuerySchema,
  V1_ROUTES,
  hasScopes,
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
  type V1Operation,
} from "@openpizza/core";
import type { ZodError } from "zod";
import {
  getPosDriver,
  type CreateOrderInput,
  type PosDriver,
  type OrderFulfillment,
} from "@/lib/db";
import { priceOrder } from "@/lib/order-pricing";
import { isStaleUnsettled } from "@/lib/payments/balance";
import { RepriceError, maxTipCents } from "@/lib/reprice";
import { getPlan } from "@/lib/saas/plans";
import { canUseOnlineOrdering, resolveEntitlements } from "@/lib/saas/entitlements";
import { authenticateV1, type AuthDeps } from "./auth";
import {
  NO_STATS,
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
import { toContractCustomer, toContractPayment, toContractTenant } from "./mappers";
import { buildDailySales, buildSalesSummary } from "./sales";

export interface V1Deps {
  auth?: AuthDeps;
  driver?: PosDriver;
  now?: () => Date;
  /** Pre-authenticated principal (tests / internal callers). */
  principal?: Principal;
}

interface Ctx {
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
    if (Array.isArray(v) && typeof v[0] === "string" && typeof v[1] === "string") {
      return [v[0], v[1]];
    }
  } catch {
    /* fallthrough */
  }
  throw ProblemError.of("VALIDATION_FAILED", { detail: "Invalid cursor." });
}

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
  return hasScopes(p.scopes, "orders:place_direct");
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

const POS_EVENTS = EVENT_TYPES.filter(
  (t) => !t.startsWith("tenant.") && !t.startsWith("entitlements."),
);

const handlers: Partial<Record<V1Operation, Handler>> = {
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
        "customers.write": false,
        "payments.external_tender": false,
        "deliveries.write": false,
        "sales.summary": true,
        drawer_sessions: true,
        webhooks: true,
      },
      events: [...POS_EVENTS],
      payment_modes: ["prepaid", "pay_at_counter"],
      notes: [
        "Delivery orders cannot be created through /v1 yet; use pickup/dine_in.",
        "Quotes are stateless: send the full cart to POST /orders (optionally with quote_hash).",
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
    return { body: quote };
  },

  "quotes.get": async () => {
    throw ProblemError.of("QUOTE_NOT_FOUND", {
      detail:
        "POS quotes are stateless and not stored. Send the cart to POST /orders (with quote_hash to detect price changes).",
    });
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
    const rows = await loadOrdersPage(ctx.principal.tenant_id, {
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
    return {
      body: {
        data,
        next_cursor: rows.length > limit && last ? encodeCursor(last.created_at, last.id) : null,
      },
    };
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
    const payments = await ctx.driver.listPaymentsForOrder(order.id);
    // In-flight money can still capture after we void. Use the POS tender
    // settlement semantics: an abandoned attempt (unsettled, never reached a
    // rail, past the stale TTL) is voided here (same row-locked voidTender the
    // terminal uses); anything else in flight must settle or be voided first.
    const inFlight = payments.filter((p) =>
      ["pending", "authorized", "requires_action"].includes(p.status),
    );
    for (const p of inFlight) {
      if (isStaleUnsettled(p, ctx.now().getTime())) {
        const v = await ctx.driver.voidTender(p.id);
        if (v.ok) continue;
      }
      throw ProblemError.of("CANCEL_NOT_ALLOWED", {
        detail: "Order has payments in flight; wait for them to settle or void them first.",
      });
    }
    const live = payments.filter(
      (p) => p.status === "captured" && p.amount_cents + p.tip_cents > p.refunded_cents,
    );
    if (live.length > 0) {
      throw ProblemError.of("CANCEL_NOT_ALLOWED", {
        detail: "Order has captured payments; refund them first.",
      });
    }
    // Compare-and-set: a concurrent release/payment wins and we report it.
    const res = await ctx.driver.transitionOrderStatus(order.id, [order.status], "voided");
    if (!res.ok && res.reason === "conflict" && res.order.status !== "voided") {
      throw ProblemError.of("CONFLICT", { detail: "Order changed while canceling; reload and retry." });
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
      await ctx.driver.transitionOrderStatus(order.id, ["draft"], "voided");
      throw ProblemError.of("INVALID_TRANSITION", {
        detail: "The hold expired and the order was canceled.",
      });
    }
    // An awaiting_payment hold is only released once fully paid, unless the
    // caller holds the explicit scope (e.g. a terminal taking cash).
    if (
      order.hold?.reason === "awaiting_payment" &&
      !hasScopes(ctx.principal.scopes, "orders:release_unpaid")
    ) {
      const payments = await ctx.driver.listPaymentsForOrder(order.id);
      const covered = payments
        .filter((p) => p.status === "captured")
        .reduce((sum, p) => sum + p.amount_cents, 0);
      if (covered < order.totals.total_cents) {
        throw ProblemError.of("PAYMENT_REQUIRED", {
          detail: "The order is not fully paid; it cannot be released yet.",
          details: { amount_due_cents: order.totals.total_cents - covered },
        });
      }
    }
    const res = await ctx.driver.transitionOrderStatus(order.id, ["draft"], "placed");
    if (!res.ok && res.reason === "conflict" && res.order.status === "voided") {
      throw ProblemError.of("INVALID_TRANSITION", { detail: "Order was canceled." });
    }
    return { body: await mapOrderFor(ctx, order.id) };
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
    const last = data[data.length - 1];
    return {
      body: {
        data: data.map((c) => toContractCustomer(c, stats.get(c.id) ?? NO_STATS)),
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
      found =
        (await ctx.driver.listCustomers(tenantId, { limit: 1000 })).find(
          (c) => c.phone?.replace(/[\s().-]/g, "") === phone,
        ) ?? null;
    }
    if (!found) throw notFound("Customer");
    return { body: await loadCustomer(tenantId, found.id, ctx.driver) };
  },

  "customers.get": async (ctx) => {
    const c = await loadCustomer(ctx.principal.tenant_id, ctx.params.customer_id!, ctx.driver);
    if (!c) throw notFound("Customer");
    return { body: c };
  },

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
  "payments.recordExternal",
  "customers.upsert",
  "deliveries.updateStatus",
  "events.list",
];

// ---------------------------------------------------------------------------
// Orders (write)
// ---------------------------------------------------------------------------

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

  // Discounts/comps are an owner/manager power in POS: callers need an explicit scope.
  if ((input.adjustments?.length ?? 0) > 0) {
    requireScopes(ctx.principal, ["orders:discount"]);
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
  if (!input.lines || input.lines.length === 0) {
    throw ProblemError.of("VALIDATION_FAILED", {
      detail: input.quote_id
        ? "POS does not store quotes; send `lines` (and optionally `quote_hash`)."
        : "lines are required.",
      path: "lines",
    });
  }
  if (input.fulfillment?.type === "delivery") {
    throw unsupported("delivery orders", "Delivery orders cannot be created through /v1 yet.");
  }
  if (input.tax_exempt) throw unsupported("tax-exempt orders");

  // Order id: client id > derived from Idempotency-Key > random.
  const idemKey = ctx.req.headers.get("idempotency-key");
  const orderId =
    input.id ??
    (idemKey ? uuidv5(`${tenantId}:${idemKey}`) : globalThis.crypto.randomUUID());

  // Idempotent replay. Foreign-tenant / out-of-scope ids answer exactly like a
  // different-request conflict so id existence never leaks.
  const existing = await ctx.driver.getOrder(orderId);
  if (existing) {
    const conflict = () =>
      ProblemError.of("IDEMPOTENCY_CONFLICT", {
        detail: "This id is already in use or was used with a different request.",
      });
    if (existing.tenant_id !== tenantId || !allowedLocation(ctx.principal, existing.location_id)) {
      throw conflict();
    }
    const sent = signature(
      input.lines.map((l) => ({ item_id: l.item_id, quantity: l.quantity })),
    );
    const had = signature(
      existing.items.filter((i) => !i.voided).map((i) => ({ item_id: i.item_id, quantity: i.quantity })),
    );
    if (sent !== had) throw conflict();
    return {
      status: 200,
      body: await mapOrderFor(ctx, existing.id),
      headers: { "idempotent-replayed": "true" },
    };
  }

  const menu = await loadMenu(bundle, ctx.driver);
  // Only a terminal may skip the hours check, and only for counter orders.
  const inStore = terminal && input.channel === "in_store";
  const quote = priceCart({
    menu,
    location: bundle.contract,
    request: {
      location_id: input.location_id,
      lines: input.lines,
      fulfillment: input.fulfillment ?? { type: "pickup" },
      adjustments: input.adjustments ?? [],
      tip: input.tip ?? null,
      tax_exempt: false,
      customer_id: input.customer_id ?? null,
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
  if (input.customer_id) {
    const c = await ctx.driver.getCustomer(input.customer_id);
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
  const holdReason =
    input.hold?.reason ??
    (input.payment_intent === "prepaid" || !terminal ? "awaiting_payment" : null);
  const ttl = input.hold?.ttl_seconds ?? 900;
  const hold = holdReason
    ? { reason: holdReason, expires_at: new Date(now.getTime() + ttl * 1000).toISOString() }
    : null;

  const f = bundle.settings.fulfillment;
  const scheduled = input.fulfillment?.scheduled_for ?? null;
  const prepMs = (f?.prep_minutes ?? 15) * 60_000;
  const fulfillment: OrderFulfillment = {
    type: "pickup",
    scheduled_for: scheduled ?? "asap",
    promised_at: scheduled ?? new Date(now.getTime() + prepMs).toISOString(),
    delivery_notes: input.fulfillment?.delivery_notes ?? undefined,
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
// Router
// ---------------------------------------------------------------------------

interface CompiledRoute {
  op: V1Operation;
  method: string;
  regex: RegExp;
  names: string[];
  scopes: readonly string[];
  static: number;
}

const ROUTES: CompiledRoute[] = (Object.keys(V1_ROUTES) as V1Operation[])
  .map((op) => {
    const def = V1_ROUTES[op];
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
    requireScopes(principal, route.scopes);
    if (params.location_id) requireLocation(principal, params.location_id);

    if (UNSUPPORTED.includes(route.op) || !handlers[route.op]) {
      throw unsupported(route.op);
    }
    const reply = await handlers[route.op]!({
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
