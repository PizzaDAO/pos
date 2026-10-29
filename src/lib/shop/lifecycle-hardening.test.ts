/**
 * Online-checkout lifecycle hardening (post-review): races between the sweeper
 * and a new tender, late payments, crash recovery, sweeper paging/mode scoping,
 * rail switching, split cash, refunds of abandoned orders.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import {
  getPosDriver,
  DEMO_TENANT_ID,
  DEMO_LOCATION_DOWNTOWN_ID,
  type CreateOrderInput,
  type OrderStatus,
  type Payment,
} from "@/lib/db";
import type { ConnectAccount } from "@/lib/db/payment-types";
import { resetMockOnline, resetMockOrders, resetMockPayments } from "@/lib/db/mock";
import { buildTickets } from "@/lib/kds/board";

const stripeRequest = vi.fn();
const stripeGet = vi.fn();
vi.mock("@/lib/payments/providers/stripe-client", async (orig) => ({
  ...(await orig<typeof import("@/lib/payments/providers/stripe-client")>()),
  stripeRequest: (...a: unknown[]) => stripeRequest(...a),
  stripeGet: (...a: unknown[]) => stripeGet(...a),
}));

const requireTenantRole = vi.fn();
const requireTenantMember = vi.fn();
vi.mock("@/lib/auth/api", () => ({
  requireTenantMember: (...a: unknown[]) => requireTenantMember(...a),
  requireTenantRole: (...a: unknown[]) => requireTenantRole(...a),
}));

const captureSpy = vi.fn();
vi.mock("@/lib/observability", async (orig) => ({
  ...(await orig<typeof import("@/lib/observability")>()),
  captureError: (...a: unknown[]) => captureSpy(...a),
}));

import { applyRailStatus, refundPayment } from "@/lib/payments/service";
import { deriveTenderId } from "@/lib/payments/ids";
import { finalizeOnlinePayment } from "./finalize";
import { expireOnlineOrders, orderExpiresAt } from "./lifecycle";
import { hasProgressedPastPayment } from "./order-status";
import { POST as paymentsPOST } from "@/app/api/payments/route";
import { POST as webhookPOST } from "@/app/api/payments/stripe/webhook/route";
import { GET as trackGET } from "@/app/api/shop/track/route";
import { GET as cronGET, maxDuration } from "@/app/api/cron/expire-online-orders/route";
import {
  GET as lateGET,
  POST as latePOST,
} from "@/app/api/admin/late-payments/route";
import { RATE_LIMIT_RULES } from "@/lib/security";
import { buildSalesReport } from "@/lib/reports";

const TENANT = DEMO_TENANT_ID;
const LOCATION = DEMO_LOCATION_DOWNTOWN_ID;
const ITEM = "30000000-0000-0000-0000-000000000001";
const ACCT = "acct_real_1";
const SECRET = "whsec_hardening";
const MIN = 60_000;

let seq = 0;

function acct(): ConnectAccount {
  return {
    tenant_id: TENANT,
    account_id: ACCT,
    status: "connected",
    charges_enabled: true,
    payouts_enabled: true,
    details_submitted: true,
    simulated: false,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

async function seedOnline(
  opts: {
    id?: string;
    status?: OrderStatus;
    delivery?: boolean;
    mode?: "live" | "test" | "sim";
  } = {},
): Promise<string> {
  seq += 1;
  const id = opts.id ?? `hard-order-${seq}`;
  const delivery = opts.delivery ?? false;
  const input: CreateOrderInput = {
    id,
    tenant_id: TENANT,
    location_id: LOCATION,
    channel: delivery ? "online_delivery" : "online_pickup",
    currency: "USD",
    items: [
      {
        id: "l1",
        item_id: ITEM,
        item_name: "Margherita",
        size_id: "s1",
        size_name: "L",
        base_price_cents: 1800,
        quantity: 2,
        modifiers: [],
        notes: null,
        voided: false,
        unit_price_cents: 1800,
        line_total_cents: 3600,
      },
    ],
    discount_cents: 0,
    totals: {
      subtotal_cents: 3600,
      discount_cents: 0,
      taxable_cents: 3600,
      tax_cents: 0,
      tip_cents: 0,
      total_cents: 3600,
    },
    notes: null,
    status: opts.status ?? "awaiting_payment",
    fulfillment: {
      type: delivery ? "delivery" : "pickup",
      // Scheduled: the /api/payments ASAP-hours gate must not depend on the clock.
      scheduled_for: "2030-01-01T18:00:00.000Z",
      promised_at: "2030-01-01T18:00:00.000Z",
      ...(opts.mode ? { checkout_mode: opts.mode } : {}),
      ...(delivery
        ? {
            address: {
              line1: "1 Main",
              city: "NYC",
              region: "NY",
              postal_code: "10001",
              country: "US",
            },
            zone_id: "zone-near",
            delivery_provider: "in_house_manual",
            eta_minutes: 30,
            delivery_fee_cents: 399,
          }
        : {}),
    },
  };
  await getPosDriver().createOrder(input);
  return id;
}

async function seedTender(
  orderId: string,
  over: Partial<Payment> = {},
): Promise<Payment> {
  seq += 1;
  return getPosDriver().upsertPayment({
    id: `hard-tender-${seq}`,
    order_id: orderId,
    tenant_id: TENANT,
    location_id: LOCATION,
    rail: "stripe_online",
    status: "requires_action",
    amount_cents: 3600,
    tip_cents: 0,
    application_fee_cents: 0,
    currency: "USD",
    charge_id: `pi_hard_${seq}`,
    connect_account_id: ACCT,
    crypto_tx_hash: null,
    crypto_chain: null,
    cash_tendered_cents: null,
    cash_change_cents: null,
    refunded_cents: 0,
    simulated: false,
    raw: { livemode: false },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...over,
  });
}

async function onHand(name: string): Promise<number> {
  const inv = await getPosDriver().listInventory(TENANT, LOCATION);
  return inv.find((i) => i.name === name)?.on_hand ?? -1;
}

async function boardIds(): Promise<string[]> {
  const orders = await getPosDriver().listOrders(TENANT, LOCATION);
  return buildTickets(orders, new Date(), {
    warn_seconds: 300,
    urgent_seconds: 600,
  }).map((t) => t.order.id);
}

function payReq(orderId: string, body: Record<string, unknown>) {
  return new Request("http://localhost/api/payments", {
    method: "POST",
    headers: { "x-forwarded-for": "7.7.7.7" },
    body: JSON.stringify({
      orderId,
      tenantId: TENANT,
      locationId: LOCATION,
      currency: "USD",
      paymentId: "client-id",
      amountCents: 1,
      ...body,
    }),
  });
}

function goLive() {
  getPosDriver(); // memoize the mock before pretending to be a live driver
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://localhost:54321");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service-key");
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
}

const later = (min: number) => new Date(Date.now() + min * MIN);

beforeEach(() => {
  resetMockOrders();
  resetMockPayments();
  resetMockOnline();
  stripeRequest.mockReset();
  stripeGet.mockReset();
  captureSpy.mockReset();
  requireTenantRole.mockReset();
  requireTenantMember.mockReset();
  requireTenantRole.mockResolvedValue({ ok: true, user: { id: "u1", email: "o@x" } });
  requireTenantMember.mockResolvedValue({ ok: true, user: { id: "u1", email: "o@x" } });
  vi.unstubAllEnvs();
  vi.stubEnv("STRIPE_SECRET_KEY", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("1: a tender created on a just-abandoned order", () => {
  it("is canceled on the provider and the client gets 409, never a secret", async () => {
    goLive();
    await getPosDriver().upsertConnectAccount(acct());
    const id = await seedOnline();
    stripeRequest.mockImplementation(async (path: string) => {
      if (path === "/payment_intents") {
        // The sweeper (or a cancel) wins the race between the gate and the upsert.
        await getPosDriver().transitionOrderStatus(id, ["awaiting_payment"], "abandoned");
        return { id: "pi_race", status: "requires_payment_method", client_secret: "cs_SECRET" };
      }
      return { id: "pi_race", status: "canceled" };
    });
    const res = await paymentsPOST(payReq(id, { rail: "stripe_online" }));
    expect(res.status).toBe(409);
    const text = await res.text();
    expect(text).toContain("checkout_abandoned");
    expect(text).not.toContain("cs_SECRET");
    expect(stripeRequest.mock.calls.map((c) => c[0])).toContain(
      "/payment_intents/pi_race/cancel",
    );
    const tender = await getPosDriver().getPayment(deriveTenderId(id, "stripe_online"));
    expect(tender?.status).toBe("canceled");
    expect((await getPosDriver().getOrder(id))?.status).toBe("abandoned");
  });
});

describe("2a: closing a pending Coinbase tender cancels the charge at Coinbase", () => {
  beforeEach(() => {
    goLive();
    vi.stubEnv("COINBASE_COMMERCE_API_KEY", "cb_key");
  });

  function coinbaseFetch(cancelOk: boolean) {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const isCancel = String(url).endsWith("/charges/cb_1/cancel");
      if (isCancel) {
        return new Response(JSON.stringify(cancelOk ? {} : { error: { message: "nope" } }), {
          status: cancelOk ? 200 : 400,
        });
      }
      void init;
      return new Response(
        JSON.stringify({
          data: { id: "cb_1", code: "C", hosted_url: "u", timeline: [{ status: "NEW" }] },
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("on expiry: provider cancel, then the local row, then the order is abandoned", async () => {
    const f = coinbaseFetch(true);
    const id = await seedOnline();
    const t = await seedTender(id, {
      rail: "crypto_coinbase",
      status: "pending",
      charge_id: "cb_1",
      connect_account_id: null,
      raw: null,
    });
    const summary = await expireOnlineOrders(later(61));
    expect(summary.abandoned).toBe(1);
    expect(f.mock.calls.some((c) => String(c[0]).endsWith("/charges/cb_1/cancel"))).toBe(true);
    expect((await getPosDriver().getPayment(t.id))?.status).toBe("canceled");
  });

  it("a refused provider cancel is logged but the order is still given up", async () => {
    coinbaseFetch(false);
    const id = await seedOnline();
    const t = await seedTender(id, {
      rail: "crypto_coinbase",
      status: "pending",
      charge_id: "cb_1",
      connect_account_id: null,
      raw: null,
    });
    await expireOnlineOrders(later(61));
    expect((await getPosDriver().getPayment(t.id))?.status).toBe("canceled");
    expect(captureSpy.mock.calls.some((c) => (c[1] as { scope?: string }).scope === "cancel-tender-provider")).toBe(true);
  });
});

describe("2b/2d: a payment settling on an abandoned order", () => {
  async function lateOrder() {
    const id = await seedOnline({ status: "abandoned" });
    const t = await seedTender(id, {
      simulated: true,
      status: "pending",
      rail: "crypto_onchain_usdc",
      connect_account_id: null,
    });
    await applyRailStatus(t.id, "captured");
    return { id, t };
  }

  it("is flagged durably (marker + audit + alert) and the order is NOT promoted", async () => {
    const { id } = await lateOrder();
    const order = (await getPosDriver().getOrder(id))!;
    expect(order.status).toBe("abandoned");
    expect(order.fulfillment?.late_payment).toMatchObject({ amount_cents: 3600 });
    expect(await boardIds()).not.toContain(id);
    const audit = await getPosDriver().listAuditLog(TENANT);
    expect(audit.filter((a) => a.action === "late_payment_flagged")).toHaveLength(1);
    expect(captureSpy.mock.calls.some((c) => (c[1] as { scope?: string }).scope === "late-payment")).toBe(true);
    // Re-evaluating is idempotent: no second audit row.
    const t = (await getPosDriver().listPaymentsForOrder(id))[0]!;
    await applyRailStatus(t.id, "captured");
    expect(
      (await getPosDriver().listAuditLog(TENANT)).filter((a) => a.action === "late_payment_flagged"),
    ).toHaveLength(1);
  });

  it("the tracking feed never claims 'nothing was charged' data: it exposes late_payment, not the marker", async () => {
    const { id } = await lateOrder();
    const res = await trackGET(new Request(`http://x/api/shop/track?orderId=${id}`));
    const body = await res.json();
    expect(body.order.late_payment).toBe("unresolved");
    expect(body.order.fulfillment.late_payment).toBeUndefined();
    expect(body.order.fulfillment.paid_at).toBeUndefined();
    // And an order with no late payment reports null.
    const clean = await seedOnline({ status: "abandoned" });
    const r2 = await trackGET(new Request(`http://x/api/shop/track?orderId=${clean}`));
    expect((await r2.json()).order.late_payment).toBeNull();
  });

  it("admin lists it, Accept promotes it through finalize (once), audited", async () => {
    const dough = await onHand("Pizza dough ball");
    const { id } = await lateOrder();
    const list = await lateGET(
      new Request(`http://x/api/admin/late-payments?tenantId=${TENANT}&locationId=${LOCATION}`),
    );
    expect((await list.json()).latePayments.map((r: { order: { id: string } }) => r.order.id)).toContain(id);

    const post = () =>
      latePOST(
        new Request("http://x/api/admin/late-payments", {
          method: "POST",
          body: JSON.stringify({ orderId: id, action: "accept" }),
        }),
      );
    expect((await post()).status).toBe(200);
    const order = (await getPosDriver().getOrder(id))!;
    expect(order.status).toBe("paid");
    expect(order.fulfillment?.late_payment?.resolved).toBe("accepted");
    expect(order.fulfillment?.finalized_at).toBeTruthy();
    expect(await boardIds()).toContain(id);
    expect(await onHand("Pizza dough ball")).toBe(dough - 2);
    expect((await post()).status).toBe(409); // already resolved
    expect(
      (await getPosDriver().listAuditLog(TENANT)).some((a) => a.action === "late_payment_accepted"),
    ).toBe(true);
    // Resolved items leave the list.
    const after = await lateGET(
      new Request(`http://x/api/admin/late-payments?tenantId=${TENANT}&locationId=${LOCATION}`),
    );
    expect((await after.json()).latePayments).toHaveLength(0);
  });

  it("admin Refund refunds every settled tender and leaves the order abandoned", async () => {
    const { id, t } = await lateOrder();
    const res = await latePOST(
      new Request("http://x/api/admin/late-payments", {
        method: "POST",
        body: JSON.stringify({ orderId: id, action: "refund" }),
      }),
    );
    expect(res.status).toBe(200);
    const order = (await getPosDriver().getOrder(id))!;
    expect(order.status).toBe("abandoned"); // NOT overwritten with refunded
    expect(order.fulfillment?.late_payment?.resolved).toBe("refunded");
    expect((await getPosDriver().getPayment(t.id))?.refunded_cents).toBe(3600);
    expect(
      (await getPosDriver().listAuditLog(TENANT)).some((a) => a.action === "late_payment_refunded"),
    ).toBe(true);
    // The tracking feed now says refunded.
    const track = await trackGET(new Request(`http://x/api/shop/track?orderId=${id}`));
    expect((await track.json()).order.late_payment).toBe("refunded");
  });

  it("admin endpoints are owner/manager only", async () => {
    const { id } = await lateOrder();
    requireTenantRole.mockResolvedValue({
      ok: false,
      res: new Response(JSON.stringify({ error: "no" }), { status: 403 }),
    });
    const r = await latePOST(
      new Request("http://x/p", {
        method: "POST",
        body: JSON.stringify({ orderId: id, action: "accept" }),
      }),
    );
    expect(r.status).toBe(403);
    expect((await getPosDriver().getOrder(id))?.status).toBe("abandoned");
  });

  it("Accept refuses when settled money does not cover the order", async () => {
    const id = await seedOnline({ status: "abandoned" });
    const t = await seedTender(id, { simulated: true, status: "captured", amount_cents: 3600 });
    await applyRailStatus(t.id, "captured"); // flag it
    // Pretend only part was ever paid.
    await getPosDriver().upsertPayment({ ...t, amount_cents: 1000 });
    const r = await latePOST(
      new Request("http://x/p", {
        method: "POST",
        body: JSON.stringify({ orderId: id, action: "accept" }),
      }),
    );
    expect(r.status).toBe(409);
  });
});

describe("2c: a settling webhook that hits the one-live-tender index", () => {
  const NOW = () => Math.floor(Date.now() / 1000);
  function hook(t: Payment, type = "payment_intent.succeeded") {
    const payload = JSON.stringify({
      id: "evt_1",
      type,
      account: ACCT,
      data: {
        object: {
          id: t.charge_id,
          amount: t.amount_cents + t.tip_cents,
          currency: "usd",
          metadata: { payment_id: t.id },
        },
      },
    });
    const ts = NOW();
    const sig = createHmac("sha256", SECRET).update(`${ts}.${payload}`).digest("hex");
    return new Request("http://localhost/api/payments/stripe/webhook", {
      method: "POST",
      headers: { "stripe-signature": `t=${ts},v1=${sig}` },
      body: payload,
    });
  }

  beforeEach(() => {
    goLive();
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", SECRET);
    stripeRequest.mockResolvedValue({ id: "x", status: "canceled" });
  });

  it("canceled -> captured is recorded by canceling the newer live tender; 200, order paid", async () => {
    const id = await seedOnline();
    const old = await seedTender(id, { status: "canceled" });
    const newer = await seedTender(id, { status: "requires_action" });
    const res = await webhookPOST(hook(old));
    expect(res.status).toBe(200);
    expect((await getPosDriver().getPayment(old.id))?.status).toBe("captured");
    expect((await getPosDriver().getPayment(newer.id))?.status).toBe("canceled");
    expect(stripeRequest.mock.calls.map((c) => c[0])).toContain(
      `/payment_intents/${newer.charge_id}/cancel`,
    );
    expect((await getPosDriver().getOrder(id))?.status).toBe("paid");
  });

  it("a genuine double settlement answers 200 and is flagged, never a 500", async () => {
    const id = await seedOnline();
    const old = await seedTender(id, { status: "canceled" });
    const newer = await seedTender(id, { status: "captured" });
    const res = await webhookPOST(hook(old));
    expect(res.status).toBe(200);
    expect((await getPosDriver().getPayment(old.id))?.status).toBe("canceled");
    expect((await getPosDriver().getPayment(newer.id))?.status).toBe("captured");
    expect(
      captureSpy.mock.calls.some((c) => String((c[0] as Error).message).includes("DOUBLE SETTLEMENT")),
    ).toBe(true);
  });
});

describe("3: crash recovery of paid-but-unfinalized orders", () => {
  async function crashedAfterCas(paidMinAgo: number, opts: { depleted?: boolean } = {}) {
    const id = await seedOnline({ delivery: true });
    const order = (await getPosDriver().getOrder(id))!;
    // The compare-and-set committed; the process died before the steps ran.
    await getPosDriver().transitionOrderStatus(id, ["awaiting_payment"], "paid", {
      fulfillment: {
        ...order.fulfillment!,
        paid_at: new Date(Date.now() - paidMinAgo * MIN).toISOString(),
      },
    });
    if (opts.depleted) await getPosDriver().depleteInventoryForOrder(id);
    return id;
  }

  it("finalize stamps finalized_at after the steps", async () => {
    const id = await seedOnline({ delivery: true });
    await finalizeOnlinePayment(id);
    const o = (await getPosDriver().getOrder(id))!;
    expect(o.fulfillment?.paid_at).toBeTruthy();
    expect(o.fulfillment?.finalized_at).toBeTruthy();
  });

  it("re-runs depletion and dispatch for an order paid >2 min ago, then stops", async () => {
    const dough = await onHand("Pizza dough ball");
    const id = await crashedAfterCas(3);
    expect(await getPosDriver().getDeliveryForOrder(id)).toBeNull();
    const first = await expireOnlineOrders();
    expect(first.recovered).toBe(1);
    expect(await onHand("Pizza dough ball")).toBe(dough - 2);
    expect((await getPosDriver().getDeliveryForOrder(id))?.provider).toBe("in_house_manual");
    expect((await getPosDriver().getOrder(id))?.fulfillment?.finalized_at).toBeTruthy();
    expect((await expireOnlineOrders()).recovered).toBe(0);
    expect(await onHand("Pizza dough ball")).toBe(dough - 2);
  });

  it("does not deplete twice when the crash came after depletion", async () => {
    const dough = await onHand("Pizza dough ball");
    const id = await crashedAfterCas(3, { depleted: true });
    expect(await onHand("Pizza dough ball")).toBe(dough - 2);
    await expireOnlineOrders();
    expect(await onHand("Pizza dough ball")).toBe(dough - 2);
    expect(await getPosDriver().getDeliveryForOrder(id)).not.toBeNull();
  });

  it("leaves a fresh (<2 min) order to the live finalize", async () => {
    const dough = await onHand("Pizza dough ball");
    await crashedAfterCas(0.5);
    expect((await expireOnlineOrders()).recovered).toBe(0);
    expect(await onHand("Pizza dough ball")).toBe(dough);
  });

  it("skips another deployment mode's orders", async () => {
    const id = await seedOnline({ mode: "live" });
    const order = (await getPosDriver().getOrder(id))!;
    await getPosDriver().transitionOrderStatus(id, ["awaiting_payment"], "paid", {
      fulfillment: { ...order.fulfillment!, paid_at: new Date(Date.now() - 5 * MIN).toISOString() },
    });
    expect((await expireOnlineOrders()).recovered).toBe(0); // zero-env deployment is "sim"
  });
});

describe("4: sweeper paging, mode scoping, alerts, maxDuration", () => {
  beforeEach(() => {
    goLive();
  });

  it("pages through more than one page of expired orders", async () => {
    for (let n = 0; n < 230; n += 1) {
      await seedOnline({ id: `pg-${String(n).padStart(4, "0")}` });
    }
    const summary = await expireOnlineOrders(later(31));
    expect(summary.abandoned).toBe(230);
    expect(await getPosDriver().listAwaitingPaymentOrders(later(60).toISOString())).toHaveLength(0);
  });

  it("long-lived skipped (processing) orders cannot starve newer ones", async () => {
    stripeGet.mockResolvedValue({ status: "processing" });
    for (let n = 0; n < 105; n += 1) {
      const id = await seedOnline({ id: `st-${String(n).padStart(4, "0")}` });
      await seedTender(id, { status: "pending" });
    }
    for (let n = 0; n < 5; n += 1) {
      await seedOnline({ id: `st-z${n}` });
    }
    const summary = await expireOnlineOrders(later(31));
    expect(summary.skipped).toBe(105);
    expect(summary.abandoned).toBe(5);
  });

  it("never scans another mode's orders (query filter), but does scan unmarked legacy ones", async () => {
    const live = await seedOnline({ mode: "live" }); // this deployment is "test"
    const test = await seedOnline({ mode: "test" });
    const legacy = await seedOnline();
    const scanned = await getPosDriver().listAwaitingPaymentOrders(later(60).toISOString(), {
      checkoutMode: "test",
    });
    expect(scanned.map((o) => o.id).sort()).toEqual([test, legacy].sort());
    const summary = await expireOnlineOrders(later(31));
    expect(summary.abandoned).toBe(2);
    expect((await getPosDriver().getOrder(live))?.status).toBe("awaiting_payment");
  });

  it("alerts when an expired order holds settled money that does not cover it", async () => {
    const id = await seedOnline();
    await seedTender(id, { status: "captured", amount_cents: 1000 });
    const summary = await expireOnlineOrders(later(31));
    expect(summary.skipped).toBe(1);
    expect(
      captureSpy.mock.calls.some((c) => (c[1] as { scope?: string }).scope === "checkout.in_flight"),
    ).toBe(true);
    expect((await getPosDriver().getOrder(id))?.status).toBe("awaiting_payment");
  });

  it("the cron route sets maxDuration", async () => {
    expect(maxDuration).toBeGreaterThanOrEqual(30);
    expect(typeof cronGET).toBe("function");
  });
});

describe("5: /pay/sync has its own, larger rate-limit bucket", () => {
  it("is separate from payments and sized for 3-4s polling from two tabs", () => {
    expect(RATE_LIMIT_RULES.paySync).toBeDefined();
    // two tabs polling every 3s = 40 requests per minute
    expect(RATE_LIMIT_RULES.paySync.limit).toBeGreaterThanOrEqual(60);
    expect(RATE_LIMIT_RULES.paySync.limit).toBeGreaterThan(RATE_LIMIT_RULES.payments.limit);
  });
});

describe("6: one expiry rule for the route and the sweeper; no false checkout_abandoned", () => {
  it("orderExpiresAt uses the earliest window of live tenders (else the requested rail)", async () => {
    const id = await seedOnline();
    const order = (await getPosDriver().getOrder(id))!;
    const created = new Date(order.created_at).getTime();
    expect(orderExpiresAt(order, [], "crypto_onchain_usdc").getTime()).toBe(created + 60 * MIN);
    expect(orderExpiresAt(order, []).getTime()).toBe(created + 30 * MIN);
    const usdc = await seedTender(id, { rail: "crypto_onchain_usdc", status: "pending", simulated: true });
    const card = { ...usdc, id: "c", rail: "stripe_online" as const, status: "requires_action" as const };
    // card (30) is the earliest live window even though USDC (60) is also live
    expect(orderExpiresAt(order, [usdc, card]).getTime()).toBe(created + 30 * MIN);
  });

  it("past the window with a payment still in flight: 409 payment_pending, order untouched", async () => {
    goLive();
    await getPosDriver().upsertConnectAccount(acct());
    const id = await seedOnline();
    await seedTender(id, { status: "pending" }); // real card, processing
    stripeGet.mockResolvedValue({ status: "processing" });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 31 * MIN);
    try {
      const res = await paymentsPOST(payReq(id, { rail: "crypto_onchain_usdc" }));
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.code).toBe("payment_pending");
      expect(body.code).not.toBe("checkout_abandoned");
    } finally {
      vi.useRealTimers();
    }
    expect((await getPosDriver().getOrder(id))?.status).toBe("awaiting_payment");
  });

  it("past the window with nothing in flight: really abandoned, then 409 checkout_abandoned", async () => {
    const id = await seedOnline();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 31 * MIN);
    try {
      const res = await paymentsPOST(payReq(id, { rail: "stripe_online" }));
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe("checkout_abandoned");
    } finally {
      vi.useRealTimers();
    }
    expect((await getPosDriver().getOrder(id))?.status).toBe("abandoned");
  });
});

describe("7: switching rails cancels the other pending tender", () => {
  it("a pending (simulated) USDC tender no longer blocks card", async () => {
    const id = await seedOnline();
    const usdc = await paymentsPOST(payReq(id, { rail: "crypto_onchain_usdc" }));
    expect(usdc.status).toBe(201);
    expect((await usdc.json()).orderStatus).toBe("awaiting_payment");
    const card = await paymentsPOST(payReq(id, { rail: "stripe_online" }));
    expect(card.status).toBe(201);
    expect((await card.json()).orderStatus).toBe("paid");
    const tenders = await getPosDriver().listPaymentsForOrder(id);
    expect(tenders.find((t) => t.rail === "crypto_onchain_usdc")?.status).toBe("canceled");
  });

  it("a pending real Coinbase charge is canceled with Coinbase before the switch", async () => {
    vi.stubEnv("COINBASE_COMMERCE_API_KEY", "cb_key");
    const f = vi.fn(async (_url: string) => {
      void _url;
      return new Response("{}", { status: 200 });
    });
    vi.stubGlobal("fetch", f);
    const id = await seedOnline();
    const cb = await seedTender(id, {
      rail: "crypto_coinbase",
      status: "pending",
      charge_id: "cb_9",
      connect_account_id: null,
      raw: null,
    });
    const res = await paymentsPOST(payReq(id, { rail: "stripe_online" }));
    expect(res.status).toBe(201);
    expect(f.mock.calls.some((c) => String(c[0]).endsWith("/charges/cb_9/cancel"))).toBe(true);
    expect((await getPosDriver().getPayment(cb.id))?.status).toBe("canceled");
  });

  it("a real USDC tender with a reported tx hash (money maybe in flight) is NOT canceled", async () => {
    const id = await seedOnline();
    await seedTender(id, {
      rail: "crypto_onchain_usdc",
      status: "pending",
      simulated: false,
      connect_account_id: null,
      crypto_tx_hash: "0xabc",
    });
    const res = await paymentsPOST(payReq(id, { rail: "stripe_online" }));
    expect(res.status).toBe(409); // nothing left to pay: the pending USDC covers it
  });
});

describe("8: retried checkout after a lost response", () => {
  it("an order that already progressed past payment is confirmed, not paid again", () => {
    for (const s of ["paid", "in_kitchen", "ready", "recall", "out_for_delivery", "completed"] as const) {
      expect(hasProgressedPastPayment(s)).toBe(true);
    }
    for (const s of ["awaiting_payment", "placed", "abandoned", "voided", "draft"] as const) {
      expect(hasProgressedPastPayment(s)).toBe(false);
    }
  });
});

describe("10: refunds and reports with abandoned orders", () => {
  it("refunding a tender on an abandoned order does not turn it into refunded", async () => {
    const id = await seedOnline({ status: "abandoned" });
    const t = await seedTender(id, { simulated: true, status: "captured" });
    await refundPayment({ paymentId: t.id, refundId: "r1" });
    expect((await getPosDriver().getPayment(t.id))?.status).toBe("refunded");
    expect((await getPosDriver().getOrder(id))?.status).toBe("abandoned");
  });

  it("still marks a normal paid order refunded", async () => {
    const id = await seedOnline({ status: "paid" });
    const t = await seedTender(id, { simulated: true, status: "captured" });
    await refundPayment({ paymentId: t.id, refundId: "r2" });
    expect((await getPosDriver().getOrder(id))?.status).toBe("refunded");
  });

  it("the payment mix excludes tenders on abandoned/awaiting orders", async () => {
    const abandoned = await seedOnline({ status: "abandoned" });
    const awaiting = await seedOnline();
    const paid = await seedOnline({ status: "paid" });
    const orders = (
      await Promise.all([abandoned, awaiting, paid].map((i) => getPosDriver().getOrder(i)))
    ).filter((o): o is NonNullable<typeof o> => !!o);
    const payments = [
      await seedTender(abandoned, { simulated: true, status: "captured" }),
      await seedTender(awaiting, { simulated: true, status: "requires_action", rail: "crypto_onchain_usdc" }),
      await seedTender(paid, { simulated: true, status: "captured" }),
    ];
    const report = buildSalesReport({
      tenantId: TENANT,
      locationId: LOCATION,
      range: {
        from: new Date(Date.now() - 86_400_000).toISOString(),
        to: new Date(Date.now() + 86_400_000).toISOString(),
      },
      orders,
      payments,
      categoryOf: () => null,
      locationName: () => "L",
    });
    expect(report.order_count).toBe(1);
    const mixTotal = report.paymentMix.reduce((n, s) => n + s.amount_cents, 0);
    expect(mixTotal).toBe(3600);
  });
});

describe("11: split cash on an online order", () => {
  const cashReq = (id: string, paymentId: string, amountCents: number) =>
    paymentsPOST(payReq(id, { rail: "cash", paymentId, amountCents }));

  it("several cash tenders split the bill; a retry of one is idempotent", async () => {
    const id = await seedOnline();
    const a = await cashReq(id, "cash-a", 1000);
    expect(a.status).toBe(201);
    expect((await a.json()).orderStatus).toBe("awaiting_payment");
    // Lost response: the same client id again is the SAME tender.
    const retry = await cashReq(id, "cash-a", 1000);
    expect(retry.status).toBe(201);
    expect((await getPosDriver().listPaymentsForOrder(id)).filter((p) => p.rail === "cash")).toHaveLength(1);
    // The last tender never exceeds what is owed.
    const b = await cashReq(id, "cash-b", 999_999);
    expect(b.status).toBe(201);
    const body = await b.json();
    expect(body.payment.amount_cents).toBe(2600);
    expect(body.orderStatus).toBe("paid");
    expect(await boardIds()).toContain(id);
  });

  it("cash on an online order still needs a till role", async () => {
    requireTenantRole.mockResolvedValue({
      ok: false,
      res: new Response("{}", { status: 403 }),
    });
    const id = await seedOnline();
    expect((await cashReq(id, "cash-x", 1000)).status).toBe(403);
  });
});
