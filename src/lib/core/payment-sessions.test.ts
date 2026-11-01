/**
 * `/v1` stored quotes + payment sessions (pos-v1-gaps phase 1), against the
 * zero-env mock driver. Stripe is never reached: the transport is mocked, and
 * the gate tests assert it is not even called on refusal.
 *
 * Real-mode (test key) cases flip `usingMockDriver()` off with `goLive()` (env
 * stubs only; the memoized mock driver stays in place), exactly like
 * payments/review-fixes.test.ts.
 */
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  OrderSchema,
  PaymentSessionSchema,
  PaymentsAccountSchema,
  QuoteSchema,
  type Principal,
} from "@openpizza/core";
import {
  DEMO_LOCATION_DOWNTOWN_ID,
  DEMO_LOCATION_UPTOWN_ID,
  DEMO_TENANT_ID,
  getPosDriver,
} from "@/lib/db";
import type { ConnectAccount } from "@/lib/db/payment-types";
import { resetMockOnline, resetMockOrders, resetMockPayments } from "@/lib/db/mock";

const stripeRequest = vi.fn();
const stripeGet = vi.fn();
vi.mock("@/lib/payments/providers/stripe-client", async (orig) => ({
  ...(await orig<typeof import("@/lib/payments/providers/stripe-client")>()),
  stripeRequest: (...a: unknown[]) => stripeRequest(...a),
  stripeGet: (...a: unknown[]) => stripeGet(...a),
}));

import { POST as webhookPOST } from "@/app/api/payments/stripe/webhook/route";
import { handleV1 } from "./v1";
import { memoryOutbox } from "./outbox";
import {
  assertSessionChargeAllowed,
  liveSessionTenants,
} from "./payment-sessions";
import { completeSimulatedSession } from "./sim-session";
import { cancelOnlineCheckout } from "@/lib/shop/lifecycle";
import { applyRailStatus, refundPayment } from "@/lib/payments/service";

// Thursday 2026-06-04 18:00 America/New_York (store open 11:00-22:00).
const NOW = new Date("2026-06-04T22:00:00.000Z");
const OTHER_TENANT = "20000000-0000-4000-8000-0000000000bb";
const ACCT = "acct_test_tony";
const WH_SECRET = "whsec_sessions";
const SUCCESS = "https://agent.example/paid";

const SCOPES = [
  "menu:read",
  "quotes:write",
  "orders:write",
  "orders:read",
  "payments:write",
  "payments:read",
];

function principal(extra: Partial<Principal> = {}): Principal {
  return {
    kind: "service",
    id: "test-client",
    tenant_id: DEMO_TENANT_ID,
    location_ids: null,
    scopes: SCOPES,
    module: "pizza_mcp",
    ...extra,
  };
}

async function call(
  method: string,
  path: string,
  opts: {
    body?: unknown;
    p?: Principal;
    headers?: Record<string, string>;
    now?: Date;
  } = {},
) {
  const url = `https://pos.test/api/v1${path}`;
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const req = new Request(url, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const segments = new URL(url).pathname.replace(/^\/api\/v1\/?/, "").split("/").filter(Boolean);
  const res = await handleV1(req, segments, {
    now: () => opts.now ?? NOW,
    principal: opts.p ?? principal(),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) : null };
}

function acct(over: Partial<ConnectAccount> = {}): ConnectAccount {
  return {
    tenant_id: DEMO_TENANT_ID,
    account_id: ACCT,
    status: "connected",
    charges_enabled: true,
    payouts_enabled: true,
    details_submitted: true,
    simulated: false,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

/** Behave like a live driver (env stubs only; the memoized mock driver stays). */
function goLive() {
  getPosDriver();
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://localhost:54321");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service-key");
}

/** Real Stripe TEST mode against the mock driver, with a connected account. */
async function testMode(key = "sk_test_unit") {
  goLive();
  vi.stubEnv("STRIPE_SECRET_KEY", key);
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", WH_SECRET);
  await getPosDriver().upsertConnectAccount(acct());
}

let csSeq = 0;
function stripeSession(over: Record<string, unknown> = {}) {
  csSeq += 1;
  return {
    id: `cs_test_${csSeq}`,
    url: `https://checkout.stripe.com/c/pay/cs_test_${csSeq}`,
    status: "open",
    livemode: false,
    expires_at: Math.floor(NOW.getTime() / 1000) + 31 * 60,
    ...over,
  };
}

async function pepperoniCart(qty = 1) {
  const { json: menu } = await call(
    "GET",
    `/locations/${DEMO_LOCATION_DOWNTOWN_ID}/menu`,
  );
  const item = menu.categories
    .flatMap((c: { items: unknown[] }) => c.items)
    .find((i: { name: string }) => i.name === "Pepperoni");
  const large = item.sizes.find((s: { name: string }) => s.name.startsWith("Large"));
  return {
    lines: [{ item_id: item.id, size_id: large.id, quantity: qty, modifiers: [] }],
    item,
  };
}

/** Quote then order by quote_id (the pizza-mcp / kiosk shape). */
async function heldOrder(opts: { tip?: number; p?: Principal } = {}) {
  const { lines } = await pepperoniCart();
  const q = await call("POST", "/quotes", {
    body: {
      location_id: DEMO_LOCATION_DOWNTOWN_ID,
      lines,
      fulfillment: { type: "pickup" },
      tip: opts.tip ? { amount_cents: opts.tip } : null,
    },
    p: opts.p,
  });
  expect(q.status).toBe(200);
  const o = await call("POST", "/orders", {
    body: {
      location_id: DEMO_LOCATION_DOWNTOWN_ID,
      quote_id: q.json.id,
      channel: "agent",
      source: { type: "agent", module: "pizza_mcp" },
    },
    headers: { "idempotency-key": `order-${q.json.id}` },
    p: opts.p,
  });
  expect(o.status).toBe(201);
  return o.json as { id: string; amount_due_cents: number; totals: { tip_cents: number; total_cents: number } };
}

let keySeq = 0;
function session(orderId: string, body: Record<string, unknown> = {}, key?: string, p?: Principal) {
  keySeq += 1;
  return call("POST", `/orders/${orderId}/payment-sessions`, {
    body: { success_url: SUCCESS, ...body },
    headers: { "idempotency-key": key ?? `pay-${keySeq}` },
    p,
  });
}

function signedWebhook(event: unknown) {
  const payload = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  const sig = `t=${t},v1=${createHmac("sha256", WH_SECRET).update(`${t}.${payload}`).digest("hex")}`;
  return webhookPOST(
    new Request("http://localhost/api/payments/stripe/webhook", {
      method: "POST",
      headers: { "stripe-signature": sig },
      body: payload,
    }),
  );
}

beforeEach(async () => {
  const driver = getPosDriver();
  for (const loc of [DEMO_LOCATION_DOWNTOWN_ID, DEMO_LOCATION_UPTOWN_ID]) {
    for (const o of await driver.listOverrides(DEMO_TENANT_ID, loc)) {
      if (o.available === false) {
        await driver.clearOverride(DEMO_TENANT_ID, loc, o.target_type, o.target_id);
      }
    }
  }
  resetMockOrders();
  resetMockPayments();
  resetMockOnline();
  memoryOutbox.clear();
  stripeRequest.mockReset();
  stripeGet.mockReset();
  vi.unstubAllEnvs();
  vi.stubEnv("STRIPE_SECRET_KEY", "");
  vi.stubEnv("TRAINING_MODE", "");
  vi.stubEnv("V1_LIVE_SESSION_TENANTS", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// Stored quotes
// ---------------------------------------------------------------------------

describe("stored quotes", () => {
  it("quotes.get returns the stored quote, re-priced, same id and window", async () => {
    const { lines } = await pepperoniCart();
    const q = await call("POST", "/quotes", {
      body: { location_id: DEMO_LOCATION_DOWNTOWN_ID, lines },
    });
    const got = await call("GET", `/quotes/${q.json.id}`);
    expect(got.status).toBe(200);
    expect(QuoteSchema.safeParse(got.json).success).toBe(true);
    expect(got.json.id).toBe(q.json.id);
    expect(got.json.quote_hash).toBe(q.json.quote_hash);
    expect(got.json.expires_at).toBe(q.json.expires_at);
  });

  it("an invalid quote is not stored", async () => {
    const q = await call("POST", "/quotes", {
      body: {
        location_id: DEMO_LOCATION_DOWNTOWN_ID,
        lines: [{ item_id: "11111111-1111-4111-8111-111111111111", quantity: 1 }],
      },
    });
    expect(q.json.valid).toBe(false);
    expect((await call("GET", `/quotes/${q.json.id}`)).status).toBe(404);
  });

  it("orders.create with only quote_id creates the held order with the quoted total", async () => {
    const { lines } = await pepperoniCart();
    const q = await call("POST", "/quotes", {
      body: { location_id: DEMO_LOCATION_DOWNTOWN_ID, lines },
    });
    const o = await call("POST", "/orders", {
      body: {
        location_id: DEMO_LOCATION_DOWNTOWN_ID,
        quote_id: q.json.id,
        quote_hash: q.json.quote_hash,
        channel: "agent",
        source: { type: "agent" },
      },
    });
    expect(o.status).toBe(201);
    expect(OrderSchema.safeParse(o.json).success).toBe(true);
    expect(o.json.fulfillment_status).toBe("held");
    expect(o.json.totals.total_cents).toBe(q.json.totals.total_cents);
  });

  it("a foreign tenant's quote id is 404", async () => {
    const { lines } = await pepperoniCart();
    const q = await call("POST", "/quotes", {
      body: { location_id: DEMO_LOCATION_DOWNTOWN_ID, lines },
    });
    const foreign = principal({ tenant_id: OTHER_TENANT });
    expect((await call("GET", `/quotes/${q.json.id}`, { p: foreign })).status).toBe(404);
    const o = await call("POST", "/orders", {
      body: {
        location_id: DEMO_LOCATION_DOWNTOWN_ID,
        quote_id: q.json.id,
        channel: "agent",
        source: { type: "agent" },
      },
      p: foreign,
    });
    expect([403, 404]).toContain(o.status);
    expect(o.json.code).not.toBe("PRICE_CHANGED");
    expect(o.status === 404 ? o.json.code : "FORBIDDEN").toMatch(/QUOTE_NOT_FOUND|NOT_FOUND|FORBIDDEN/);
  });

  it("an unknown quote id is 404 QUOTE_NOT_FOUND", async () => {
    const o = await call("POST", "/orders", {
      body: {
        location_id: DEMO_LOCATION_DOWNTOWN_ID,
        quote_id: "quo_does_not_exist",
        channel: "agent",
        source: { type: "agent" },
      },
    });
    expect(o.status).toBe(404);
    expect(o.json.code).toBe("QUOTE_NOT_FOUND");
  });

  it("an expired quote is 409 QUOTE_EXPIRED", async () => {
    const { lines } = await pepperoniCart();
    const q = await call("POST", "/quotes", {
      body: { location_id: DEMO_LOCATION_DOWNTOWN_ID, lines },
    });
    const later = new Date(NOW.getTime() + 11 * 60_000);
    const o = await call("POST", "/orders", {
      body: {
        location_id: DEMO_LOCATION_DOWNTOWN_ID,
        quote_id: q.json.id,
        channel: "agent",
        source: { type: "agent" },
      },
      now: later,
    });
    expect(o.status).toBe(409);
    expect(o.json.code).toBe("QUOTE_EXPIRED");
    expect((await call("GET", `/quotes/${q.json.id}`, { now: later })).status).toBe(409);
  });

  it("a menu change since the quote is 409 PRICE_CHANGED", async () => {
    const { lines, item } = await pepperoniCart();
    const q = await call("POST", "/quotes", {
      body: { location_id: DEMO_LOCATION_DOWNTOWN_ID, lines },
    });
    const driver = getPosDriver();
    const large = item.sizes.find((s: { name: string }) => s.name.startsWith("Large"));
    await driver.upsertOverride({
      tenant_id: DEMO_TENANT_ID,
      location_id: DEMO_LOCATION_DOWNTOWN_ID,
      target_type: "size",
      target_id: large.id,
      available: null,
      price_cents: (large.price_cents ?? 1000) + 100,
    } as Parameters<typeof driver.upsertOverride>[0]);
    const o = await call("POST", "/orders", {
      body: {
        location_id: DEMO_LOCATION_DOWNTOWN_ID,
        quote_id: q.json.id,
        channel: "agent",
        source: { type: "agent" },
      },
    });
    expect(o.status).toBe(409);
    expect(o.json.code).toBe("PRICE_CHANGED");
  });

  it("an input tip overrides the stored tip", async () => {
    const { lines } = await pepperoniCart();
    const q = await call("POST", "/quotes", {
      body: {
        location_id: DEMO_LOCATION_DOWNTOWN_ID,
        lines,
        tip: { amount_cents: 100 },
      },
    });
    expect(q.json.totals.tip_cents).toBe(100);
    const o = await call("POST", "/orders", {
      body: {
        location_id: DEMO_LOCATION_DOWNTOWN_ID,
        quote_id: q.json.id,
        tip: { amount_cents: 250 },
        channel: "agent",
        source: { type: "agent" },
      },
    });
    expect(o.status).toBe(201);
    expect(o.json.totals.tip_cents).toBe(250);
    const kept = await call("POST", "/orders", {
      body: {
        location_id: DEMO_LOCATION_DOWNTOWN_ID,
        quote_id: q.json.id,
        channel: "agent",
        source: { type: "agent" },
      },
    });
    expect(kept.json.totals.tip_cents).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// The safety gate
// ---------------------------------------------------------------------------

describe("assertSessionChargeAllowed (the gate)", () => {
  const code = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      return (e as { code?: string }).code;
    }
    return "allowed";
  };

  it("simulated when there is no key", () => {
    expect(assertSessionChargeAllowed(DEMO_TENANT_ID)).toBe("simulated");
  });

  it("simulated for ANY key while the mock driver is in use", () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_live_abc");
    expect(assertSessionChargeAllowed(DEMO_TENANT_ID)).toBe("simulated");
  });

  it("simulated for a live key under TRAINING_MODE", () => {
    goLive();
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_live_abc");
    vi.stubEnv("TRAINING_MODE", "true");
    expect(assertSessionChargeAllowed(DEMO_TENANT_ID)).toBe("simulated");
  });

  it("test for sk_test_ and rk_test_ only", () => {
    goLive();
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_abc");
    expect(assertSessionChargeAllowed(DEMO_TENANT_ID)).toBe("test");
    vi.stubEnv("STRIPE_SECRET_KEY", "rk_test_abc");
    expect(assertSessionChargeAllowed(DEMO_TENANT_ID)).toBe("test");
  });

  it("live keys are refused with 501 by default (empty allowlist)", () => {
    goLive();
    expect(liveSessionTenants().size).toBe(0);
    for (const key of ["sk_live_abc", "rk_live_abc"]) {
      vi.stubEnv("STRIPE_SECRET_KEY", key);
      expect(code(() => assertSessionChargeAllowed(DEMO_TENANT_ID))).toBe(
        "CAPABILITY_UNSUPPORTED",
      );
      expect(code(() => assertSessionChargeAllowed(OTHER_TENANT))).toBe(
        "CAPABILITY_UNSUPPORTED",
      );
    }
  });

  it("a live key is only allowed for an allow-listed tenant on a production deployment", () => {
    goLive();
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_live_abc");
    vi.stubEnv("V1_LIVE_SESSION_TENANTS", ` ${OTHER_TENANT.toUpperCase()} , x`);
    vi.stubEnv("VERCEL_ENV", "production");
    expect(assertSessionChargeAllowed(OTHER_TENANT)).toBe("live");
    // Not listed: still refused.
    expect(code(() => assertSessionChargeAllowed("30000000-0000-4000-8000-000000000001"))).toBe(
      "CAPABILITY_UNSUPPORTED",
    );
    // Listed but not a production deployment: refused.
    vi.stubEnv("VERCEL_ENV", "preview");
    expect(code(() => assertSessionChargeAllowed(OTHER_TENANT))).toBe("CAPABILITY_UNSUPPORTED");
  });

  it("the demo tenant is refused on a live key even when allow-listed", () => {
    goLive();
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_live_abc");
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("V1_LIVE_SESSION_TENANTS", DEMO_TENANT_ID);
    expect(code(() => assertSessionChargeAllowed(DEMO_TENANT_ID))).toBe(
      "CAPABILITY_UNSUPPORTED",
    );
  });

  it("an unrecognised key prefix is refused, always", () => {
    goLive();
    vi.stubEnv("V1_LIVE_SESSION_TENANTS", `${DEMO_TENANT_ID},${OTHER_TENANT}`);
    vi.stubEnv("VERCEL_ENV", "production");
    for (const key of ["pk_test_abc", "whatever", "sk_prod_abc", "sk_TEST_abc", " sk_test_abc"]) {
      vi.stubEnv("STRIPE_SECRET_KEY", key);
      expect(code(() => assertSessionChargeAllowed(DEMO_TENANT_ID))).toBe(
        "CAPABILITY_UNSUPPORTED",
      );
    }
  });

  it("a refusal writes no tender and makes no Stripe call (live, unknown)", async () => {
    const o = await heldOrder();
    goLive();
    await getPosDriver().upsertConnectAccount(acct());
    for (const key of ["sk_live_abc", "sk_weird_abc"]) {
      vi.stubEnv("STRIPE_SECRET_KEY", key);
      const r = await session(o.id);
      expect(r.status).toBe(501);
      expect(r.json.code).toBe("CAPABILITY_UNSUPPORTED");
    }
    expect(stripeRequest).not.toHaveBeenCalled();
    expect(stripeGet).not.toHaveBeenCalled();
    expect(await getPosDriver().listPaymentsForOrder(o.id)).toHaveLength(0);
    expect(await getPosDriver().getOpenPaymentSessionForOrder(o.id)).toBeNull();
  });

  it("a replay is served from storage and never reaches Stripe either", async () => {
    const o = await heldOrder();
    const first = await session(o.id, {}, "same-key");
    expect(first.status).toBe(201);
    goLive();
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_live_abc");
    const again = await session(o.id, {}, "same-key");
    expect(again.status).toBe(200);
    expect(stripeRequest).not.toHaveBeenCalled();
  });

  it("test mode: a session whose id is not cs_test_ is expired at once and the call fails", async () => {
    await testMode();
    const o = await heldOrder();
    stripeRequest.mockImplementation(async (path: string) => {
      if (path === "/checkout/sessions") return stripeSession({ id: "cs_live_surprise" });
      return { id: "cs_live_surprise", status: "expired" };
    });
    const r = await session(o.id);
    expect(r.status).toBe(501);
    expect(stripeRequest.mock.calls.map((c) => c[0])).toEqual([
      "/checkout/sessions",
      "/checkout/sessions/cs_live_surprise/expire",
    ]);
    expect(await getPosDriver().getOpenPaymentSessionForOrder(o.id)).toBeNull();
    const tenders = await getPosDriver().listPaymentsForOrder(o.id);
    expect(tenders.every((t) => t.status === "failed")).toBe(true);
  });

  it("test mode: a livemode:true session is expired at once too", async () => {
    await testMode();
    const o = await heldOrder();
    stripeRequest.mockImplementation(async (path: string) =>
      path === "/checkout/sessions" ? stripeSession({ livemode: true }) : { status: "expired" },
    );
    expect((await session(o.id)).status).toBe(501);
  });
});

// ---------------------------------------------------------------------------
// Simulated sessions (zero env)
// ---------------------------------------------------------------------------

describe("simulated payment session", () => {
  it("quote -> held order -> session -> pay -> paid, released, on the outbox", async () => {
    const o = await heldOrder({ tip: 150 });
    const s = await session(o.id);
    expect(s.status).toBe(201);
    expect(PaymentSessionSchema.safeParse(s.json).success).toBe(true);
    expect(s.json.simulated).toBe(true);
    expect(s.json.status).toBe("open");
    expect(s.json.payment_id).toBeNull();
    expect(s.json.url).toContain("/pay/sim/");
    expect(s.json.url).not.toContain("stripe.com");
    // The tip rides on the tender; the amount is the food only.
    expect(s.json.tip_cents).toBe(150);
    expect(s.json.amount_cents).toBe(o.totals.total_cents - 150);
    expect(stripeRequest).not.toHaveBeenCalled();

    // Still held and unpaid.
    const held = await call("GET", `/orders/${o.id}`);
    expect(held.json.fulfillment_status).toBe("held");

    const got = await call("GET", `/payment-sessions/${s.json.id}`);
    expect(got.json.status).toBe("open");

    const done = await completeSimulatedSession(s.json.id, NOW);
    expect(done.ok).toBe(true);

    const after = await call("GET", `/payment-sessions/${s.json.id}`);
    expect(after.json.status).toBe("completed");
    expect(after.json.payment_id).not.toBeNull();
    const order = await call("GET", `/orders/${o.id}`);
    expect(order.json.fulfillment_status).toBe("placed");
    expect(order.json.payment_status).toBe("paid");
    expect(order.json.hold).toBeNull();
    const pays = await call("GET", `/orders/${o.id}/payments`);
    expect(pays.json.data).toHaveLength(1);
    expect(pays.json.data[0].status).toBe("captured");
    expect(pays.json.data[0].id).toBe(after.json.payment_id);
    expect(
      memoryOutbox.rows.some((e) => e.event_type === "order.placed" && e.subject_id === o.id),
    ).toBe(true);
    // Paying twice is refused.
    expect((await completeSimulatedSession(s.json.id, NOW)).ok).toBe(false);
  });

  it("the platform fee is on the food only, never the tip", async () => {
    const o = await heldOrder({ tip: 400 });
    const s = await session(o.id);
    const tender = (await getPosDriver().listPaymentsForOrder(o.id))[0]!;
    const food = o.totals.total_cents - 400;
    // 2.5% + 10c of the food, not of food + tip.
    const expected = Math.floor((food * 250) / 10_000 + 0.5) + 10;
    expect(tender.application_fee_cents).toBe(expected);
    expect(tender.tip_cents).toBe(400);
    expect(tender.amount_cents).toBe(food);
    expect(s.json.amount_cents + s.json.tip_cents).toBe(o.totals.total_cents);
  });

  it("the simulate step refuses a real (non-simulated) deployment", async () => {
    const o = await heldOrder();
    const s = await session(o.id);
    goLive();
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_abc");
    expect((await completeSimulatedSession(s.json.id, NOW)).ok).toBe(false);
  });

  it("replays the same key and body (200, replayed header); a different body conflicts", async () => {
    const o = await heldOrder();
    const a = await session(o.id, {}, "k1");
    const b = await session(o.id, {}, "k1");
    expect(b.status).toBe(200);
    expect(b.headers.get("idempotent-replayed")).toBe("true");
    expect(b.json.id).toBe(a.json.id);
    const c = await session(o.id, { tip_cents: 5 }, "k1");
    expect(c.status).toBe(409);
    expect(c.json.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(await getPosDriver().listPaymentsForOrder(o.id)).toHaveLength(1);
  });

  it("a new key supersedes the open session (old one canceled, one tender open)", async () => {
    const o = await heldOrder();
    const a = await session(o.id, {}, "k1");
    const b = await session(o.id, {}, "k2");
    expect(b.status).toBe(201);
    expect(b.json.id).not.toBe(a.json.id);
    expect((await call("GET", `/payment-sessions/${a.json.id}`)).json.status).toBe("canceled");
    expect((await call("GET", `/payment-sessions/${b.json.id}`)).json.status).toBe("open");
    const tenders = await getPosDriver().listPaymentsForOrder(o.id);
    expect(tenders.filter((t) => t.status === "requires_action")).toHaveLength(1);
    expect(tenders.filter((t) => t.status === "canceled")).toHaveLength(1);
  });

  it("amount over the amount due is 422; a partial amount is allowed", async () => {
    const o = await heldOrder();
    const due = o.amount_due_cents;
    const over = await session(o.id, { amount_cents: due + 1 });
    expect(over.status).toBe(422);
    expect(over.json.code).toBe("VALIDATION_FAILED");
    const tip = await session(o.id, { amount_cents: 100, tip_cents: 101 });
    expect(tip.status).toBe(422);
    const part = await session(o.id, { amount_cents: 100 });
    expect(part.status).toBe(201);
    expect(part.json.amount_cents).toBe(100);
    expect(part.json.tip_cents).toBe(0);
  });

  it("requires an Idempotency-Key header", async () => {
    const o = await heldOrder();
    const r = await call("POST", `/orders/${o.id}/payment-sessions`, {
      body: { success_url: SUCCESS },
    });
    expect(r.status).toBe(422);
  });

  it("a foreign tenant and a location-limited token get 404", async () => {
    const o = await heldOrder();
    const s = await session(o.id);
    const foreign = principal({ tenant_id: OTHER_TENANT });
    // A tenant that does not exist is not active (403); either way nothing leaks.
    expect([403, 404]).toContain((await session(o.id, {}, "x1", foreign)).status);
    expect((await call("GET", `/payment-sessions/${s.json.id}`, { p: foreign })).status).toBe(404);
    const limited = principal({ location_ids: [DEMO_LOCATION_UPTOWN_ID] });
    expect((await session(o.id, {}, "x2", limited)).status).toBe(404);
    expect((await call("GET", `/payment-sessions/${s.json.id}`, { p: limited })).status).toBe(404);
    expect((await call("GET", "/payment-sessions/ps_unknown")).status).toBe(404);
  });

  it("scope checks: payments:write to create, payments:read to read", async () => {
    const o = await heldOrder();
    const noWrite = principal({ scopes: ["payments:read", "orders:read"] });
    expect((await session(o.id, {}, "x3", noWrite)).status).toBe(403);
    const s = await session(o.id);
    const noRead = principal({ scopes: ["payments:write"] });
    expect((await call("GET", `/payment-sessions/${s.json.id}`, { p: noRead })).status).toBe(403);
  });

  it("refuses a canceled order, an expired hold, and a settled order", async () => {
    const canceled = await heldOrder();
    await call("POST", `/orders/${canceled.id}/cancel`, { body: { reason: "test" } });
    const r1 = await session(canceled.id);
    expect(r1.status).toBe(409);
    expect(r1.json.code).toBe("INVALID_TRANSITION");

    const stale = await heldOrder();
    const r2 = await call("POST", `/orders/${stale.id}/payment-sessions`, {
      body: { success_url: SUCCESS },
      headers: { "idempotency-key": "late" },
      now: new Date(NOW.getTime() + 20 * 60_000),
    });
    expect(r2.status).toBe(409);
    expect(r2.json.details?.reason).toBe("expired");

    const paid = await heldOrder();
    const s = await session(paid.id);
    await completeSimulatedSession(s.json.id, NOW);
    const r3 = await session(paid.id);
    expect(r3.status).toBe(409);
    expect(r3.json.details?.reason).toBe("settled");
  });

  it("extends the hold to outlive the pay link by 2 minutes (within the cap)", async () => {
    const o = await heldOrder();
    await session(o.id);
    const order = (await getPosDriver().getOrder(o.id))!;
    // Stripe's 31 minute minimum + 2 minutes of grace.
    expect(Date.parse(order.hold!.expires_at!)).toBe(NOW.getTime() + 33 * 60_000);
  });

  it("at the hold's lifetime cap a link cannot be created (409 at_cap)", async () => {
    const o = await heldOrder();
    // 23h50m after creation: the 24h cap leaves 10 minutes, less than 31.
    const driver = getPosDriver();
    const order = (await driver.getOrder(o.id))!;
    // (The mock stamps created_at with the wall clock, so measure from that.)
    const lateNow = new Date(Date.parse(order.created_at) + 23 * 3_600_000 + 50 * 60_000);
    await driver.extendOrderHold(
      o.id,
      DEMO_TENANT_ID,
      { expires_at: order.hold!.expires_at },
      { ...order.hold!, expires_at: new Date(lateNow.getTime() + 5 * 60_000).toISOString() },
    );
    const r = await call("POST", `/orders/${o.id}/payment-sessions`, {
      body: { success_url: SUCCESS },
      headers: { "idempotency-key": "cap" },
      now: lateNow,
    });
    expect(r.status).toBe(409);
    expect(r.json.details?.reason).toBe("at_cap");
    expect(await driver.listPaymentsForOrder(o.id)).toHaveLength(0);
  });

  it("a cancel closes the open session (no tender left in flight)", async () => {
    const o = await heldOrder();
    const s = await session(o.id);
    const c = await call("POST", `/orders/${o.id}/cancel`, { body: { reason: "test" } });
    expect(c.status).toBe(200);
    expect((await call("GET", `/payment-sessions/${s.json.id}`)).json.status).toBe("canceled");
    expect((await completeSimulatedSession(s.json.id, NOW)).ok).toBe(false);
  });

  it("payments.account reports the simulated account", async () => {
    const r = await call("GET", "/payments/account");
    expect(r.status).toBe(200);
    expect(PaymentsAccountSchema.safeParse(r.json).success).toBe(true);
    expect(r.json.simulated).toBe(true);
    expect(r.json.platform_fee).toEqual({ bps: 250, fixed_cents: 10, max_cents: null });
    expect(r.json.default_currency).toBe("USD");
  });
});

// ---------------------------------------------------------------------------
// Stripe test mode (transport mocked)
// ---------------------------------------------------------------------------

describe("test-mode Checkout session", () => {
  it("creates a Checkout Session on the connected account with the fee on the food only", async () => {
    await testMode();
    const o = await heldOrder({ tip: 200 });
    stripeRequest.mockResolvedValueOnce(stripeSession());
    const r = await session(o.id);
    expect(r.status).toBe(201);
    expect(r.json.simulated).toBe(false);
    expect(r.json.url).toContain("checkout.stripe.com");
    expect(r.json.url).toContain("cs_test_");

    const [path, body, opts] = stripeRequest.mock.calls[0]!;
    expect(path).toBe("/checkout/sessions");
    expect(opts.stripeAccount).toBe(ACCT);
    const tender = (await getPosDriver().listPaymentsForOrder(o.id))[0]!;
    expect(opts.idempotencyKey).toBe(`cs_${tender.id}`);
    const food = o.totals.total_cents - 200;
    const fee = Math.floor((food * 250) / 10_000 + 0.5) + 10;
    expect(body.payment_intent_data.application_fee_amount).toBe(fee);
    expect(body.payment_intent_data.metadata.payment_id).toBe(tender.id);
    expect(body.payment_method_types).toEqual(["card"]);
    expect(body.mode).toBe("payment");
    // Charge = food + tip.
    const charged = body.line_items.reduce(
      (n: number, l: { price_data: { unit_amount: number } }) => n + l.price_data.unit_amount,
      0,
    );
    expect(charged).toBe(o.totals.total_cents);
    expect(body.expires_at - Math.floor(NOW.getTime() / 1000)).toBeGreaterThanOrEqual(31 * 60);
    expect(tender.status).toBe("requires_action");
    expect(tender.charge_id).toBeNull();
    expect(tender.raw?.checkout_session_id).toBe(`cs_test_${csSeq}`);
    expect(tender.connect_account_id).toBe(ACCT);
  });

  it("an honoured Stripe minimum: a 60 s request still expires in >= 31 minutes", async () => {
    await testMode();
    const o = await heldOrder();
    stripeRequest.mockResolvedValueOnce(stripeSession());
    const r = await session(o.id, { expires_in_seconds: 60 });
    expect(Date.parse(r.json.expires_at) - NOW.getTime()).toBeGreaterThanOrEqual(31 * 60_000);
  });

  it("card not ready (no charges-enabled account) is 409 card_not_ready, with no Stripe call", async () => {
    await testMode();
    await getPosDriver().upsertConnectAccount(acct({ charges_enabled: false }));
    stripeGet.mockRejectedValue(new Error("offline"));
    const o = await heldOrder();
    const r = await session(o.id);
    expect(r.status).toBe(409);
    expect(r.json.details?.reason).toBe("card_not_ready");
    expect(stripeRequest).not.toHaveBeenCalled();
    expect(await getPosDriver().listPaymentsForOrder(o.id)).toHaveLength(0);
  });

  it("Stripe failing marks the tender failed and answers 503", async () => {
    await testMode();
    const o = await heldOrder();
    stripeRequest.mockRejectedValueOnce(new Error("boom"));
    const r = await session(o.id);
    expect(r.status).toBe(503);
    expect(r.json.code).toBe("UPSTREAM_UNAVAILABLE");
    const tenders = await getPosDriver().listPaymentsForOrder(o.id);
    expect(tenders[0]?.status).toBe("failed");
    // The slot is free again: a retry works.
    stripeRequest.mockResolvedValueOnce(stripeSession());
    expect((await session(o.id)).status).toBe(201);
  });

  it("a new key expires the old Checkout Session at Stripe first", async () => {
    await testMode();
    const o = await heldOrder();
    stripeRequest.mockResolvedValueOnce(stripeSession());
    const a = await session(o.id, {}, "k1");
    const firstId = `cs_test_${csSeq}`;
    stripeRequest.mockResolvedValueOnce({ id: firstId, status: "expired" });
    stripeRequest.mockResolvedValueOnce(stripeSession());
    const b = await session(o.id, {}, "k2");
    expect(b.status).toBe(201);
    expect(stripeRequest.mock.calls.map((c) => c[0])).toEqual([
      "/checkout/sessions",
      `/checkout/sessions/${firstId}/expire`,
      "/checkout/sessions",
    ]);
    expect((await call("GET", `/payment-sessions/${a.json.id}`)).json.status).toBe("canceled");
  });

  it("if Stripe will not expire the old session (payer is mid-payment) no second one is created", async () => {
    await testMode();
    const o = await heldOrder();
    stripeRequest.mockResolvedValueOnce(stripeSession());
    await session(o.id, {}, "k1");
    stripeRequest.mockRejectedValueOnce(new Error("cannot expire"));
    stripeGet.mockResolvedValueOnce({ id: "x", status: "open" });
    const b = await session(o.id, {}, "k2");
    expect(b.status).toBe(503);
    expect(stripeRequest.mock.calls.filter((c) => c[0] === "/checkout/sessions")).toHaveLength(1);
  });

  describe("capture", () => {
    async function openSession(tip = 100) {
      await testMode();
      const o = await heldOrder({ tip });
      stripeRequest.mockResolvedValueOnce(stripeSession());
      const s = await session(o.id);
      const tender = (await getPosDriver().listPaymentsForOrder(o.id))[0]!;
      return { o, s, tender };
    }

    function succeeded(tenderId: string, amount: number, over: Record<string, unknown> = {}) {
      return {
        type: "payment_intent.succeeded",
        account: ACCT,
        data: {
          object: {
            id: "pi_cs_1",
            amount,
            currency: "usd",
            metadata: { payment_id: tenderId },
            ...over,
          },
        },
      };
    }

    it("payment_intent.succeeded matches by metadata, writes charge_id, completes the session, releases the hold", async () => {
      const { o, s, tender } = await openSession();
      const res = await signedWebhook(succeeded(tender.id, o.totals.total_cents));
      expect(res.status).toBe(200);
      const paid = (await getPosDriver().getPayment(tender.id))!;
      expect(paid.status).toBe("captured");
      expect(paid.charge_id).toBe("pi_cs_1");
      const got = await call("GET", `/payment-sessions/${s.json.id}`);
      expect(got.json.status).toBe("completed");
      expect(got.json.payment_id).toBe(tender.id);
      const order = await call("GET", `/orders/${o.id}`);
      expect(order.json.fulfillment_status).toBe("placed");
      expect(order.json.payment_status).toBe("paid");
      expect(
        memoryOutbox.rows.some((e) => e.event_type === "order.placed" && e.subject_id === o.id),
      ).toBe(true);
      // A replayed webhook is harmless.
      expect((await signedWebhook(succeeded(tender.id, o.totals.total_cents))).status).toBe(200);
    });

    it("the existing amount and account checks still apply", async () => {
      const { o, tender } = await openSession();
      await signedWebhook(succeeded(tender.id, o.totals.total_cents - 1));
      await signedWebhook({ ...succeeded(tender.id, o.totals.total_cents), account: "acct_other" });
      expect((await getPosDriver().getPayment(tender.id))!.status).toBe("requires_action");
      expect((await call("GET", `/orders/${o.id}`)).json.fulfillment_status).toBe("held");
    });

    it("a declined card (payment_failed) leaves the session open", async () => {
      const { o, s, tender } = await openSession();
      await signedWebhook({
        type: "payment_intent.payment_failed",
        account: ACCT,
        data: {
          object: {
            id: "pi_cs_1",
            amount: o.totals.total_cents,
            currency: "usd",
            metadata: { payment_id: tender.id },
            last_payment_error: { message: "declined" },
          },
        },
      });
      expect((await getPosDriver().getPayment(tender.id))!.status).toBe("requires_action");
      stripeGet.mockResolvedValueOnce({ id: "cs", status: "open" });
      expect((await call("GET", `/payment-sessions/${s.json.id}`)).json.status).toBe("open");
    });

    it("getSession reconciles a paid session the webhook missed", async () => {
      const { o, s, tender } = await openSession();
      stripeGet.mockResolvedValueOnce({
        id: `cs_test_${csSeq}`,
        status: "complete",
        payment_status: "paid",
        payment_intent: "pi_missed",
        amount_total: o.totals.total_cents,
        currency: "usd",
      });
      const got = await call("GET", `/payment-sessions/${s.json.id}`);
      expect(got.json.status).toBe("completed");
      expect((await getPosDriver().getPayment(tender.id))!.charge_id).toBe("pi_missed");
      expect((await call("GET", `/orders/${o.id}`)).json.fulfillment_status).toBe("placed");
    });

    it("getSession does not settle on an amount mismatch", async () => {
      const { o, s, tender } = await openSession();
      stripeGet.mockResolvedValueOnce({
        id: `cs_test_${csSeq}`,
        status: "complete",
        payment_status: "paid",
        payment_intent: "pi_x",
        amount_total: 1,
        currency: "usd",
      });
      const got = await call("GET", `/payment-sessions/${s.json.id}`);
      expect(got.json.status).toBe("open");
      expect((await getPosDriver().getPayment(tender.id))!.status).toBe("requires_action");
      expect((await call("GET", `/orders/${o.id}`)).json.fulfillment_status).toBe("held");
    });

    it("getSession shows an expired session as expired and frees the order", async () => {
      const { o, s, tender } = await openSession();
      stripeGet.mockResolvedValueOnce({ id: "cs", status: "expired" });
      expect((await call("GET", `/payment-sessions/${s.json.id}`)).json.status).toBe("expired");
      expect((await getPosDriver().getPayment(tender.id))!.status).toBe("canceled");
      stripeRequest.mockResolvedValueOnce(stripeSession());
      expect((await session(o.id)).status).toBe(201);
    });

    it("a refund after capture goes to the PaymentIntent", async () => {
      const { o, tender } = await openSession();
      await signedWebhook(succeeded(tender.id, o.totals.total_cents));
      stripeRequest.mockResolvedValueOnce({ id: "re_1", status: "succeeded" });
      const refunded = await refundPayment({ paymentId: tender.id, refundId: "r1" });
      expect(refunded?.refunded_cents).toBe(o.totals.total_cents);
      const call0 = stripeRequest.mock.calls.at(-1)!;
      expect(call0[0]).toBe("/refunds");
      expect(call0[1].payment_intent).toBe("pi_cs_1");
      expect(call0[2].stripeAccount).toBe(ACCT);
    });

    it("cancel with an open session expires it at Stripe, then voids", async () => {
      const { o, s } = await openSession();
      stripeRequest.mockResolvedValueOnce({ id: "cs", status: "expired" });
      const c = await call("POST", `/orders/${o.id}/cancel`, { body: { reason: "test" } });
      expect(c.status).toBe(200);
      expect(stripeRequest.mock.calls.at(-1)![0]).toBe(
        `/checkout/sessions/cs_test_${csSeq}/expire`,
      );
      expect(c.json.fulfillment_status).toBe("canceled");
      stripeGet.mockClear();
      expect((await call("GET", `/payment-sessions/${s.json.id}`)).json.status).toBe("canceled");
    });

    it("cancel when Stripe says the session already completed records the payment and refuses the cancel", async () => {
      const { o, tender } = await openSession();
      stripeRequest.mockRejectedValueOnce(new Error("session already complete"));
      stripeGet.mockResolvedValueOnce({
        id: `cs_test_${csSeq}`,
        status: "complete",
        payment_status: "paid",
        payment_intent: "pi_late",
        amount_total: o.totals.total_cents,
        currency: "usd",
      });
      const c = await call("POST", `/orders/${o.id}/cancel`, { body: { reason: "test" } });
      expect(c.status).toBe(409);
      expect(c.json.code).toBe("CANCEL_NOT_ALLOWED");
      expect((await getPosDriver().getPayment(tender.id))!.status).toBe("captured");
    });

    it("cancel when Stripe cannot expire an open session fails closed (502-class), order stays held", async () => {
      const { o } = await openSession();
      stripeRequest.mockRejectedValueOnce(new Error("nope"));
      stripeGet.mockResolvedValueOnce({ id: "cs", status: "open" });
      const c = await call("POST", `/orders/${o.id}/cancel`, { body: { reason: "test" } });
      expect(c.status).toBeGreaterThanOrEqual(500);
      expect((await call("GET", `/orders/${o.id}`)).json.fulfillment_status).toBe("held");
    });

    it("an aged session tender (null charge_id, > 15 min) is still closed at Stripe before cancel", async () => {
      const { o, tender } = await openSession();
      await getPosDriver().upsertPayment({
        ...tender,
        created_at: new Date(NOW.getTime() - 40 * 60_000).toISOString(),
      });
      stripeRequest.mockResolvedValueOnce({ id: "cs", status: "expired" });
      const c = await call("POST", `/orders/${o.id}/cancel`, { body: { reason: "test" } });
      expect(c.status).toBe(200);
      expect(stripeRequest.mock.calls.at(-1)![0]).toContain("/expire");
    });

    it("a payment that lands after the order was voided is flagged as a late payment", async () => {
      const { o, tender } = await openSession();
      // Voided out from under the session (hold sweep / manual), then Stripe confirms.
      await getPosDriver().upsertPayment({ ...tender, status: "canceled" });
      await getPosDriver().cancelOrder(o.id, DEMO_TENANT_ID, { nowMs: NOW.getTime() });
      await signedWebhook(succeeded(tender.id, o.totals.total_cents));
      const order = (await getPosDriver().getOrder(o.id))!;
      expect(order.status).toBe("voided");
      expect(order.fulfillment?.late_payment?.amount_cents).toBe(o.totals.total_cents);
    });
  });

  it("a held order paid by session promotes ASAP promised_at from payment time", async () => {
    await testMode();
    const o = await heldOrder();
    stripeRequest.mockResolvedValueOnce(stripeSession());
    await session(o.id);
    const tender = (await getPosDriver().listPaymentsForOrder(o.id))[0]!;
    const before = (await getPosDriver().getOrder(o.id))!.fulfillment!.promised_at;
    await signedWebhook({
      type: "payment_intent.succeeded",
      account: ACCT,
      data: {
        object: {
          id: "pi_p",
          amount: o.totals.total_cents,
          currency: "usd",
          metadata: { payment_id: tender.id },
        },
      },
    });
    const after = (await getPosDriver().getOrder(o.id))!.fulfillment!;
    expect(after.paid_at).toBeTruthy();
    expect(after.promised_at).not.toBe(before);
    expect(after.finalized_at).toBeTruthy();
  });

  it("payments.account reports the test account", async () => {
    await testMode();
    const r = await call("GET", "/payments/account");
    expect(PaymentsAccountSchema.safeParse(r.json).success).toBe(true);
    expect(r.json.simulated).toBe(false);
    expect(r.json.connect_account_id).toBe(ACCT);
    expect(r.json.charges_enabled).toBe(true);
  });

  it("payments.account never reports a simulated acct_sim_ id in real mode", async () => {
    goLive();
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_unit");
    // The driver refuses to store a sim account over a real row, but a row left
    // from before the key was set is stored: seed it directly.
    await getPosDriver().upsertConnectAccount(
      acct({ account_id: "acct_sim_x", simulated: true }),
    );
    const r = await call("GET", "/payments/account");
    expect(r.json.connect_account_id).toBeNull();
    expect(r.json.charges_enabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Review fixes
// ---------------------------------------------------------------------------

describe("F1: the order is settled while the session is being created", () => {
  it("expires the Stripe session, leaves no open URL or open tender, and answers 409", async () => {
    await testMode();
    const o = await heldOrder();
    const driver = getPosDriver();
    stripeRequest.mockImplementation(async (path: string) => {
      if (path !== "/checkout/sessions") return { status: "expired" };
      // While Stripe is "answering", the till takes cash for the full amount: it
      // settles the order and closes the sibling (our not-yet-linked) tender.
      await driver.upsertPayment({
        id: "race-cash",
        order_id: o.id,
        tenant_id: DEMO_TENANT_ID,
        location_id: DEMO_LOCATION_DOWNTOWN_ID,
        rail: "cash",
        status: "requires_action",
        amount_cents: o.amount_due_cents,
        tip_cents: 0,
        application_fee_cents: 0,
        currency: "USD",
        charge_id: null,
        connect_account_id: null,
        crypto_tx_hash: null,
        crypto_chain: null,
        cash_tendered_cents: null,
        cash_change_cents: null,
        refunded_cents: 0,
        simulated: false,
        raw: null,
        created_at: NOW.toISOString(),
        updated_at: NOW.toISOString(),
      });
      await applyRailStatus("race-cash", "captured");
      return stripeSession();
    });
    const r = await session(o.id);
    expect(r.status).toBe(409);
    expect(r.json.details?.reason).toBe("settled");
    const paths = stripeRequest.mock.calls.map((c) => c[0] as string);
    expect(paths).toContain(`/checkout/sessions/cs_test_${csSeq}/expire`);
    expect(await driver.getOpenPaymentSessionForOrder(o.id)).toBeNull();
    const tenders = await driver.listPaymentsForOrder(o.id);
    expect(tenders.filter((t) => t.status === "requires_action" || t.status === "pending")).toHaveLength(0);
    expect(tenders.find((t) => t.rail === "stripe_online")?.status).toBe("canceled");
  });

  it("an order voided during the create window is also closed and refused", async () => {
    await testMode();
    const o = await heldOrder();
    stripeRequest.mockImplementation(async (path: string) => {
      if (path !== "/checkout/sessions") return { status: "expired" };
      await getPosDriver().casOrderStatus(o.id, ["draft"], "voided");
      return stripeSession();
    });
    const r = await session(o.id);
    expect(r.status).toBe(409);
    expect(stripeRequest.mock.calls.map((c) => c[0] as string).some((p) => p.endsWith("/expire"))).toBe(true);
    expect(await getPosDriver().getOpenPaymentSessionForOrder(o.id)).toBeNull();
  });
});

describe("F2: payment events for held orders", () => {
  const types = (orderId?: string) =>
    memoryOutbox.rows
      .filter(
        (r) =>
          (r.event_type === "payment.captured" || r.event_type === "order.placed") &&
          (orderId === undefined ||
            r.subject_id === orderId ||
            r.row_snapshot?.order_id === orderId),
      )
      .map((r) => r.event_type);

  it("a held order emits payment.captured BEFORE order.placed", async () => {
    const o = await heldOrder();
    const s = await session(o.id);
    memoryOutbox.clear();
    await completeSimulatedSession(s.json.id, NOW);
    expect(types()).toEqual(["payment.captured", "order.placed"]);
  });

  it("a shop awaiting_payment order and a parked draft stay suppressed", async () => {
    const driver = getPosDriver();
    const mk = (id: string, status: "awaiting_payment" | "draft") =>
      driver.createOrder({
        id,
        tenant_id: DEMO_TENANT_ID,
        location_id: DEMO_LOCATION_DOWNTOWN_ID,
        channel: status === "draft" ? "in_store" : "online_pickup",
        currency: "USD",
        items: [],
        discount_cents: 0,
        totals: {
          subtotal_cents: 1000,
          discount_cents: 0,
          taxable_cents: 1000,
          tax_cents: 0,
          tip_cents: 0,
          total_cents: 1000,
        },
        notes: null,
        status,
        hold: null,
        fulfillment:
          status === "awaiting_payment"
            ? { type: "pickup", scheduled_for: "asap", promised_at: NOW.toISOString() }
            : undefined,
      });
    await mk("shop-await", "awaiting_payment");
    await mk("parked-draft", "draft");
    memoryOutbox.clear();
    for (const [id, orderId] of [
      ["t-shop", "shop-await"],
      ["t-parked", "parked-draft"],
    ] as const) {
      await driver.upsertPayment({
        id,
        order_id: orderId,
        tenant_id: DEMO_TENANT_ID,
        location_id: DEMO_LOCATION_DOWNTOWN_ID,
        rail: "cash",
        status: "captured",
        amount_cents: 500,
        tip_cents: 0,
        application_fee_cents: 0,
        currency: "USD",
        charge_id: null,
        connect_account_id: null,
        crypto_tx_hash: null,
        crypto_chain: null,
        cash_tendered_cents: null,
        cash_change_cents: null,
        refunded_cents: 0,
        simulated: false,
        raw: null,
        created_at: NOW.toISOString(),
        updated_at: NOW.toISOString(),
      });
    }
    expect(memoryOutbox.rows.filter((r) => r.event_type === "payment.captured")).toHaveLength(0);
  });
});

describe("F3: a payer-added tip is not a duplicate payment", () => {
  it("an agent-channel order paid with a tip it did not carry is not flagged", async () => {
    const o = await heldOrder();
    const s = await session(o.id, { tip_cents: 300 });
    expect(s.json.tip_cents).toBe(300);
    await completeSimulatedSession(s.json.id, NOW);
    const order = (await getPosDriver().getOrder(o.id))!;
    expect(order.fulfillment?.late_payment).toBeUndefined();
  });

  it("two full base payments are still flagged as a duplicate", async () => {
    const o = await heldOrder();
    const s = await session(o.id);
    await completeSimulatedSession(s.json.id, NOW);
    const driver = getPosDriver();
    await driver.upsertPayment({
      id: "dup-cash",
      order_id: o.id,
      tenant_id: DEMO_TENANT_ID,
      location_id: DEMO_LOCATION_DOWNTOWN_ID,
      rail: "cash",
      status: "requires_action",
      amount_cents: o.amount_due_cents,
      tip_cents: 0,
      application_fee_cents: 0,
      currency: "USD",
      charge_id: null,
      connect_account_id: null,
      crypto_tx_hash: null,
      crypto_chain: null,
      cash_tendered_cents: null,
      cash_change_cents: null,
      refunded_cents: 0,
      simulated: false,
      raw: null,
      created_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
    });
    await applyRailStatus("dup-cash", "captured");
    const order = (await driver.getOrder(o.id))!;
    expect(order.fulfillment?.late_payment?.kind).toBe("duplicate");
    expect(order.fulfillment?.late_payment?.amount_cents).toBe(o.amount_due_cents);
  });
});

describe("N1: a tipped duplicate refunds food AND tip", () => {
  it("the marker amount is the whole duplicate charge (food + tip)", async () => {
    const o = await heldOrder({ tip: 300 });
    const s = await session(o.id);
    await completeSimulatedSession(s.json.id, NOW);
    const driver = getPosDriver();
    const food = o.amount_due_cents;
    await driver.upsertPayment({
      id: "dup-tipped",
      order_id: o.id,
      tenant_id: DEMO_TENANT_ID,
      location_id: DEMO_LOCATION_DOWNTOWN_ID,
      rail: "cash",
      status: "requires_action",
      amount_cents: food,
      tip_cents: 300,
      application_fee_cents: 0,
      currency: "USD",
      charge_id: null,
      connect_account_id: null,
      crypto_tx_hash: null,
      crypto_chain: null,
      cash_tendered_cents: null,
      cash_change_cents: null,
      refunded_cents: 0,
      simulated: false,
      raw: null,
      created_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
    });
    await applyRailStatus("dup-tipped", "captured");
    const lp = (await driver.getOrder(o.id))!.fulfillment?.late_payment;
    expect(lp?.kind).toBe("duplicate");
    expect(lp?.amount_cents).toBe(food + 300);
  });
});

describe("release of an expired hold holding captured money", () => {
  it("answers captured_money (not the retryable tender_in_progress)", async () => {
    const o = await heldOrder();
    const a = await session(o.id, { amount_cents: 1000 });
    await completeSimulatedSession(a.json.id, NOW);
    const later = new Date(NOW.getTime() + 40 * 60_000);
    const r = await call("POST", `/orders/${o.id}/release`, { body: {}, now: later });
    expect(r.status).toBe(409);
    expect(r.json.details?.reason).toBe("captured_money");
  });
});

describe("F5: simulated sessions only where they cannot cook a real order", () => {
  const code = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      return (e as { code?: string }).code;
    }
    return "allowed";
  };

  it("mock driver: any tenant, any VERCEL_ENV", () => {
    vi.stubEnv("VERCEL_ENV", "production");
    expect(assertSessionChargeAllowed(OTHER_TENANT)).toBe("simulated");
  });

  it("real database + no Stripe key: refused, except the demo tenant off production", () => {
    goLive();
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    expect(assertSessionChargeAllowed(DEMO_TENANT_ID)).toBe("simulated");
    vi.stubEnv("VERCEL_ENV", "preview");
    expect(assertSessionChargeAllowed(DEMO_TENANT_ID)).toBe("simulated");
    expect(code(() => assertSessionChargeAllowed(OTHER_TENANT))).toBe("CAPABILITY_UNSUPPORTED");
    vi.stubEnv("VERCEL_ENV", "production");
    expect(code(() => assertSessionChargeAllowed(DEMO_TENANT_ID))).toBe("CAPABILITY_UNSUPPORTED");
  });

  it("real database + TRAINING_MODE + live key: same rule", () => {
    goLive();
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_live_abc");
    vi.stubEnv("TRAINING_MODE", "true");
    vi.stubEnv("VERCEL_ENV", "production");
    expect(code(() => assertSessionChargeAllowed(DEMO_TENANT_ID))).toBe("CAPABILITY_UNSUPPORTED");
  });

  it("the simulate step refuses the same deployments, and creating one writes nothing", async () => {
    const o = await heldOrder();
    const s = await session(o.id);
    goLive();
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    vi.stubEnv("VERCEL_ENV", "production");
    expect((await completeSimulatedSession(s.json.id, NOW)).ok).toBe(false);
    const o2 = await heldOrder();
    const r = await session(o2.id);
    expect(r.status).toBe(501);
    expect(await getPosDriver().listPaymentsForOrder(o2.id)).toHaveLength(0);
  });
});

describe("F6: an order replay survives quote expiry", () => {
  it("the same Idempotency-Key after the quote expired returns the order (200)", async () => {
    const { lines } = await pepperoniCart();
    const q = await call("POST", "/quotes", {
      body: { location_id: DEMO_LOCATION_DOWNTOWN_ID, lines },
    });
    const body = {
      location_id: DEMO_LOCATION_DOWNTOWN_ID,
      quote_id: q.json.id,
      channel: "agent",
      source: { type: "agent" },
    };
    const headers = { "idempotency-key": "replay-after-expiry" };
    const first = await call("POST", "/orders", { body, headers });
    expect(first.status).toBe(201);
    const later = new Date(NOW.getTime() + 11 * 60_000);
    const again = await call("POST", "/orders", { body, headers, now: later });
    expect(again.status).toBe(200);
    expect(again.headers.get("idempotent-replayed")).toBe("true");
    expect(again.json.id).toBe(first.json.id);
    // A different request on the same key is still a conflict.
    const other = await pepperoniCart(2);
    const q2 = await call("POST", "/quotes", {
      body: { location_id: DEMO_LOCATION_DOWNTOWN_ID, lines: other.lines },
    });
    const clash = await call("POST", "/orders", {
      body: { ...body, quote_id: q2.json.id },
      headers,
    });
    expect(clash.status).toBe(409);
    expect(clash.json.code).toBe("IDEMPOTENCY_CONFLICT");
  });
});

describe("F7/F8/F9", () => {
  it("F7: a second session after a PARTIAL capture works", async () => {
    const o = await heldOrder();
    const a = await session(o.id, { amount_cents: 1000 });
    expect(a.status).toBe(201);
    await completeSimulatedSession(a.json.id, NOW);
    const b = await session(o.id);
    expect(b.status).toBe(201);
    expect(b.json.amount_cents).toBe(o.amount_due_cents - 1000);
    await completeSimulatedSession(b.json.id, NOW);
    expect((await call("GET", `/orders/${o.id}`)).json.payment_status).toBe("paid");
  });

  it("F8: a session row left open after capture is repaired by a read", async () => {
    const o = await heldOrder();
    const s = await session(o.id);
    const driver = getPosDriver();
    const tender = (await driver.listPaymentsForOrder(o.id))[0]!;
    // Captured behind the service's back (as if the session sync had failed).
    await driver.upsertPayment({ ...tender, status: "captured", charge_id: "sim_pi_x" });
    expect((await driver.getPaymentSession(s.json.id))!.status).toBe("open");
    const got = await call("GET", `/payment-sessions/${s.json.id}`);
    expect(got.json.status).toBe("completed");
    expect(got.json.payment_id).toBe(tender.id);
  });

  it("F8: a repeated webhook for an already-captured tender repairs the session row", async () => {
    await testMode();
    const o = await heldOrder();
    stripeRequest.mockResolvedValueOnce(stripeSession());
    const s = await session(o.id);
    const driver = getPosDriver();
    const tender = (await driver.listPaymentsForOrder(o.id))[0]!;
    await driver.upsertPayment({ ...tender, status: "captured", charge_id: "pi_cs_1" });
    await signedWebhook({
      type: "payment_intent.succeeded",
      account: ACCT,
      data: {
        object: {
          id: "pi_cs_1",
          amount: o.totals.total_cents,
          currency: "usd",
          metadata: { payment_id: tender.id },
        },
      },
    });
    expect((await driver.getPaymentSession(s.json.id))!.status).toBe("completed");
  });

  it("F9: releasing an expired hold closes its open session and tender", async () => {
    const o = await heldOrder();
    const s = await session(o.id);
    const later = new Date(NOW.getTime() + 40 * 60_000);
    const r = await call("POST", `/orders/${o.id}/release`, { body: {}, now: later });
    expect(r.status).toBe(409);
    expect(r.json.code).toBe("INVALID_TRANSITION");
    const driver = getPosDriver();
    expect((await driver.getOrder(o.id))!.status).toBe("voided");
    expect((await driver.getPaymentSession(s.json.id))!.status).toBe("canceled");
    expect((await driver.listPaymentsForOrder(o.id))[0]!.status).toBe("canceled");
  });

  it("F9: with a real session, release of an expired hold expires it at Stripe", async () => {
    await testMode();
    const o = await heldOrder();
    stripeRequest.mockResolvedValueOnce(stripeSession());
    await session(o.id);
    stripeRequest.mockResolvedValueOnce({ status: "expired" });
    const later = new Date(NOW.getTime() + 40 * 60_000);
    await call("POST", `/orders/${o.id}/release`, { body: {}, now: later });
    expect(stripeRequest.mock.calls.at(-1)![0]).toBe(`/checkout/sessions/cs_test_${csSeq}/expire`);
    expect((await getPosDriver().getOrder(o.id))!.status).toBe("voided");
  });
});

describe("shop checkout is unchanged except for the fee", () => {
  it("cancelOnlineCheckout is untouched by sessions (no awaiting order -> not_found)", async () => {
    expect((await cancelOnlineCheckout("nope")).ok).toBe(false);
  });
});
