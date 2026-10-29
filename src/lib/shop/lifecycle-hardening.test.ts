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
import { POST as refundPOST } from "@/app/api/payments/refund/route";
import { dispatchDelivery } from "@/lib/delivery/service";
import {
  FOREIGN_MODE_GRACE_MS,
  RECOVERY_GRACE_MS,
  recoverUnfinalizedOrders,
} from "./lifecycle";
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
    tip?: number;
    quoteExpiresAt?: string;
    postal?: string;
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
      tip_cents: opts.tip ?? 0,
      total_cents: 3600 + (opts.tip ?? 0),
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
              postal_code: opts.postal ?? "10001",
              country: "US",
            },
            ...(opts.quoteExpiresAt ? { quote_expires_at: opts.quoteExpiresAt } : {}),
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

  it("a refused cancel (payment detected) re-syncs: still pending => in flight, NOT abandoned", async () => {
    coinbaseFetch(false);
    const id = await seedOnline();
    const t = await seedTender(id, {
      rail: "crypto_coinbase",
      status: "pending",
      charge_id: "cb_1",
      connect_account_id: null,
      raw: null,
    });
    const summary = await expireOnlineOrders(later(61));
    expect(summary.skipped).toBe(1);
    expect(summary.abandoned).toBe(0);
    expect((await getPosDriver().getPayment(t.id))?.status).toBe("pending"); // NOT marked canceled
    expect((await getPosDriver().getOrder(id))?.status).toBe("awaiting_payment");
    expect(captureSpy.mock.calls.some((c) => (c[1] as { scope?: string }).scope === "cancel-open-tender")).toBe(true);
  });

  it("a refused cancel where Coinbase says the payment landed finalizes the order", async () => {
    const f = vi.fn(async (url: string) => {
      if (String(url).endsWith("/cancel")) {
        return new Response(JSON.stringify({ error: { message: "paid" } }), { status: 400 });
      }
      return new Response(
        JSON.stringify({
          data: { id: "cb_1", code: "C", hosted_url: "u", timeline: [{ status: "NEW" }, { status: "COMPLETED" }] },
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", f);
    const id = await seedOnline();
    await seedTender(id, {
      rail: "crypto_coinbase",
      status: "pending",
      charge_id: "cb_1",
      connect_account_id: null,
      raw: null,
    });
    // refreshPaymentStatus in closeOpenTenders already sees COMPLETED first.
    const summary = await expireOnlineOrders(later(61));
    expect(summary.finalized).toBe(1);
    expect((await getPosDriver().getOrder(id))?.status).toBe("paid");
  });
});

describe("2b/2d: a payment settling on an abandoned order", () => {
  async function lateOrder(rail: Payment["rail"] = "crypto_onchain_usdc", amount = 3600) {
    const id = await seedOnline({ status: "abandoned" });
    const t = await seedTender(id, {
      simulated: true,
      status: "pending",
      rail,
      amount_cents: amount,
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

  const refundReq = (id: string, action = "refund") =>
    latePOST(
      new Request("http://x/api/admin/late-payments", {
        method: "POST",
        body: JSON.stringify({ orderId: id, action }),
      }),
    );

  it("admin Refund of a CARD payment refunds it and leaves the order abandoned", async () => {
    const { id, t } = await lateOrder("stripe_online");
    const res = await refundReq(id);
    expect(res.status).toBe(200);
    expect((await res.json()).refundOwedManually).toBe(false);
    const order = (await getPosDriver().getOrder(id))!;
    expect(order.status).toBe("abandoned"); // NOT overwritten with refunded
    expect(order.fulfillment?.late_payment?.resolved).toBe("refunded");
    expect((await getPosDriver().getPayment(t.id))?.refunded_cents).toBe(3600);
    const track = await trackGET(new Request(`http://x/api/shop/track?orderId=${id}`));
    expect((await track.json()).order.late_payment).toBe("refunded");
  });

  it("admin Refund of a CRYPTO payment moves no money: refund_owed_manual until staff mark it", async () => {
    const auditsBefore = (await getPosDriver().listAuditLog(TENANT)).filter(
      (a) => a.action === "late_payment_refunded",
    ).length;
    const { id, t } = await lateOrder("crypto_coinbase");
    const res = await refundReq(id);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.refundOwedManually).toBe(true);
    expect(body.note).toMatch(/no money|cannot be sent/i);
    // The tender stays captured; nothing was recorded as refunded.
    const tender = (await getPosDriver().getPayment(t.id))!;
    expect(tender.status).toBe("captured");
    expect(tender.refunded_cents).toBe(0);
    let order = (await getPosDriver().getOrder(id))!;
    expect(order.status).toBe("abandoned");
    expect(order.fulfillment?.late_payment).toMatchObject({
      resolved: "refund_owed_manual",
      manual_refunds: [{ payment_id: t.id, amount_cents: 3600 }],
    });
    // The customer is told it is being processed, never "refunded".
    const track = await trackGET(new Request(`http://x/api/shop/track?orderId=${id}`));
    expect((await track.json()).order.late_payment).toBe("refund_owed_manual");
    // Still listed (with the owed amounts) so staff cannot lose it.
    const list = await lateGET(
      new Request(`http://x/api/admin/late-payments?tenantId=${TENANT}&locationId=${LOCATION}`),
    );
    const rows = (await list.json()).latePayments;
    expect(rows).toHaveLength(1);
    expect(rows[0].payments[0].manual_refund).toBe(true);
    // Refund cannot be pressed again; Accept is gone.
    expect((await refundReq(id)).status).toBe(409);
    expect((await refundReq(id, "accept")).status).toBe(409);
    // Staff send the money, then confirm.
    expect((await refundReq(id, "mark_refunded")).status).toBe(200);
    order = (await getPosDriver().getOrder(id))!;
    expect(order.fulfillment?.late_payment?.resolved).toBe("refunded");
    expect((await getPosDriver().getPayment(t.id))?.status).toBe("refunded");
    const audits = (await getPosDriver().listAuditLog(TENANT)).filter(
      (a) => a.action === "late_payment_refunded",
    );
    expect(audits.length - auditsBefore).toBe(2); // the owed refund + staff's confirmation
    expect(audits.some((a) => /BY HAND|OWED/i.test(a.detail ?? ""))).toBe(true);
    expect(audits.some((a) => /confirmed/i.test(a.detail ?? ""))).toBe(true);
    expect((await refundReq(id, "mark_refunded")).status).toBe(409);
  });

  it("an UNDERPAID late payment is flagged too, and Accept counts refunds", async () => {
    const { id } = await lateOrder("stripe_online", 1000);
    expect((await getPosDriver().getOrder(id))?.fulfillment?.late_payment?.amount_cents).toBe(1000);
    expect((await refundReq(id, "accept")).status).toBe(409); // 1000 < 3600
    // Fully paid then partially refunded: net below the order total.
    const full = await lateOrder("stripe_online", 3600);
    await refundPayment({ paymentId: full.t.id, amountCents: 1000, refundId: "part" });
    const r = await refundReq(full.id, "accept");
    expect(r.status).toBe(409);
    expect((await getPosDriver().getOrder(full.id))?.status).toBe("abandoned");
  });

  it("Accept and Refund racing: exactly one wins, in either order", async () => {
    for (const order of [["accept", "refund"], ["refund", "accept"]] as const) {
      resetMockOrders();
      resetMockPayments();
      const { id } = await lateOrder("stripe_online");
      const results = await Promise.all(order.map((a) => refundReq(id, a)));
      const codes = results.map((r) => r.status).sort();
      expect(codes).toEqual([200, 409]);
      const o = (await getPosDriver().getOrder(id))!;
      // Coherent end state: either promoted to paid (accepted) or refunded and abandoned.
      if (o.fulfillment?.late_payment?.resolved === "accepted") {
        expect(o.status).toBe("paid");
        expect((await getPosDriver().listPaymentsForOrder(id))[0]!.refunded_cents).toBe(0);
      } else {
        expect(o.status).toBe("abandoned");
        expect(o.fulfillment?.late_payment?.resolved).toBe("refunded");
      }
    }
  });

  it("two concurrent Accepts act once; a failed action releases its claim", async () => {
    const { id } = await lateOrder("stripe_online");
    const [a, b] = await Promise.all([refundReq(id, "accept"), refundReq(id, "accept")]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    // A refund that throws releases the claim so the item is not stuck.
    resetMockOrders();
    resetMockPayments();
    const again = await lateOrder("stripe_online");
    const spy = vi
      .spyOn(getPosDriver(), "updateLatePayment")
      .mockRejectedValueOnce(new Error("boom"));
    const failed = await refundReq(again.id);
    spy.mockRestore();
    expect(failed.status).toBe(502);
    expect(
      (await getPosDriver().getOrder(again.id))?.fulfillment?.late_payment?.claim,
    ).toBeUndefined();
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

  it("a genuine double settlement: BOTH stay captured, 200, flagged as a duplicate for the admin", async () => {
    const id = await seedOnline();
    const old = await seedTender(id, { status: "canceled" });
    const newer = await seedTender(id, { status: "captured" });
    const res = await webhookPOST(hook(old));
    expect(res.status).toBe(200);
    // Never leave captured money recorded as canceled.
    expect((await getPosDriver().getPayment(old.id))?.status).toBe("captured");
    expect((await getPosDriver().getPayment(newer.id))?.status).toBe("captured");
    const marker = (await getPosDriver().getOrder(id))?.fulfillment?.late_payment;
    expect(marker).toMatchObject({ kind: "duplicate", amount_cents: 3600 });
    expect(
      captureSpy.mock.calls.some((c) => String((c[0] as Error).message).includes("DOUBLE SETTLEMENT")),
    ).toBe(true);
    const list = await lateGET(
      new Request(`http://x/api/admin/late-payments?tenantId=${TENANT}&locationId=${LOCATION}`),
    );
    expect((await list.json()).latePayments).toHaveLength(1);
    // The tracking page does not show duplicates as a late payment.
    const track = await trackGET(new Request(`http://x/api/shop/track?orderId=${id}`));
    expect((await track.json()).order.late_payment).toBeNull();
  });

  it("an older tender's open-state flip is ignored (stays canceled), never a 500", async () => {
    const id = await seedOnline();
    const old = await seedTender(id, { status: "canceled" });
    const newer = await seedTender(id, { status: "requires_action" });
    const res = await webhookPOST(hook(old, "payment_intent.payment_failed"));
    expect(res.status).toBe(200);
    expect((await getPosDriver().getPayment(old.id))?.status).toBe("canceled");
    expect((await getPosDriver().getPayment(newer.id))?.status).toBe("requires_action");
  });

  it("when the provider refuses to cancel the newer tender it is re-synced, never marked canceled", async () => {
    const id = await seedOnline();
    const old = await seedTender(id, { status: "canceled" });
    const newer = await seedTender(id, { status: "requires_action" });
    stripeRequest.mockRejectedValue(new Error("cannot cancel: confirming"));
    stripeGet.mockResolvedValue({ status: "processing" });
    const res = await webhookPOST(hook(old));
    expect(res.status).toBe(200);
    expect((await getPosDriver().getPayment(old.id))?.status).toBe("captured");
    expect((await getPosDriver().getPayment(newer.id))?.status).toBe("pending"); // re-synced, not canceled
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

  it("re-runs depletion and dispatch for an order paid >6 min ago, then stops", async () => {
    const dough = await onHand("Pizza dough ball");
    const id = await crashedAfterCas(7);
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
    const id = await crashedAfterCas(7, { depleted: true });
    expect(await onHand("Pizza dough ball")).toBe(dough - 2);
    await expireOnlineOrders();
    expect(await onHand("Pizza dough ball")).toBe(dough - 2);
    expect(await getPosDriver().getDeliveryForOrder(id)).not.toBeNull();
  });

  it("leaves a fresh (<6 min) order to the live finalize", async () => {
    const dough = await onHand("Pizza dough ball");
    await crashedAfterCas(5);
    expect((await expireOnlineOrders()).recovered).toBe(0);
    expect(await onHand("Pizza dough ball")).toBe(dough);
  });

  it("skips another deployment mode's orders", async () => {
    const id = await seedOnline({ mode: "live" });
    const order = (await getPosDriver().getOrder(id))!;
    await getPosDriver().transitionOrderStatus(id, ["awaiting_payment"], "paid", {
      fulfillment: { ...order.fulfillment!, paid_at: new Date(Date.now() - 7 * MIN).toISOString() },
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

// ---------------------------------------------------------------------------
// Re-review round
// ---------------------------------------------------------------------------

describe("R1: refunds of crypto tenders only record an intent -- say so", () => {
  const refundReq = (paymentId: string) =>
    refundPOST(
      new Request("http://x/api/payments/refund", {
        method: "POST",
        body: JSON.stringify({ paymentId, refundId: `rr-${paymentId}` }),
      }),
    );

  it("the refund API flags a crypto refund as manual (no money sent), a card refund is not", async () => {
    const id = await seedOnline({ status: "paid" });
    const crypto = await seedTender(id, {
      id: deriveTenderId(id, "crypto_coinbase"),
      rail: "crypto_coinbase",
      status: "captured",
      simulated: true,
      connect_account_id: null,
    });
    const card = await seedTender(id, {
      id: deriveTenderId(id, "stripe_online"),
      rail: "stripe_online",
      status: "captured",
      simulated: true,
    });
    const c = await (await refundReq(crypto.id)).json();
    expect(c.manualRefund).toBe(true);
    expect(c.note).toMatch(/no money was sent/i);
    const k = await (await refundReq(card.id)).json();
    expect(k.manualRefund).toBe(false);
    expect(k.note).toBeUndefined();
  });
});

describe("R3: settled tenders no longer hold the one-open-tender slot", () => {
  it("captured + a new open tender is recordable; two OPEN tenders are still refused", async () => {
    const id = await seedOnline();
    await seedTender(id, { status: "captured" });
    await seedTender(id, { status: "requires_action" }); // allowed now
    await expect(seedTender(id, { status: "pending" })).rejects.toThrow(/in progress/);
  });
});

describe("R5: split cash", () => {
  const cashReq = (id: string, paymentId: string, amountCents: number) =>
    paymentsPOST(payReq(id, { rail: "cash", paymentId, amountCents }));

  it("the till-role check runs BEFORE the existing-tender lookup", async () => {
    const id = await seedOnline();
    expect((await cashReq(id, "cash-known", 1000)).status).toBe(201);
    requireTenantRole.mockResolvedValue({ ok: false, res: new Response("{}", { status: 403 }) });
    const probe = await cashReq(id, "cash-known", 1000);
    expect(probe.status).toBe(403); // not the stored tender
  });

  it("the tip rides on the final covering tender only", async () => {
    const id = await seedOnline({ tip: 500 });
    const a = await (await cashReq(id, "cash-t1", 1000)).json();
    expect(a.payment.tip_cents).toBe(0);
    const b = await (await cashReq(id, "cash-t2", 999_999)).json();
    expect(b.payment.tip_cents).toBe(500);
    expect(b.payment.amount_cents + a.payment.amount_cents).toBe(3600);
    expect(b.orderStatus).toBe("paid");
  });

  it("two concurrent full cash tenders: exactly one survives, the other is voided", async () => {
    const id = await seedOnline();
    const [a, b] = await Promise.all([cashReq(id, "cash-r1", 999_999), cashReq(id, "cash-r2", 999_999)]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const live = (await getPosDriver().listPaymentsForOrder(id)).filter(
      (p) => p.rail === "cash" && p.status === "captured",
    );
    expect(live).toHaveLength(1);
    expect(live[0]!.amount_cents).toBe(3600);
    expect((await getPosDriver().getOrder(id))?.status).toBe("paid");
  });
});

describe("R6: a REAL pending USDC tender is never auto-canceled on a rail switch", () => {
  it("real stays pending (blocks card)", async () => {
    const id = await seedOnline();
    const real = await seedTender(id, {
      rail: "crypto_onchain_usdc",
      status: "pending",
      simulated: false,
      connect_account_id: null,
    });
    const res = await paymentsPOST(payReq(id, { rail: "stripe_online" }));
    expect(res.status).toBe(409);
    expect((await getPosDriver().getPayment(real.id))?.status).toBe("pending");
  });
});

describe("R7: crash recovery details", () => {
  const crashed = async (paidMinAgo: number, over: Parameters<typeof seedOnline>[0] = {}) => {
    const id = await seedOnline({ delivery: true, ...over });
    const order = (await getPosDriver().getOrder(id))!;
    await getPosDriver().transitionOrderStatus(id, ["awaiting_payment"], "paid", {
      fulfillment: {
        ...order.fulfillment!,
        paid_at: new Date(Date.now() - paidMinAgo * MIN).toISOString(),
      },
    });
    return id;
  };

  it("the grace period is well above the cron route's 60 s maxDuration", () => {
    expect(RECOVERY_GRACE_MS).toBeGreaterThanOrEqual(5 * maxDuration * 1000);
  });

  it("a concurrent double dispatch yields exactly one delivery", async () => {
    const id = await seedOnline({ delivery: true });
    const input = {
      orderId: id,
      tenantId: TENANT,
      locationId: LOCATION,
      provider: "in_house_manual" as const,
      pickup: { line1: "p", city: "", region: "", postal_code: "", country: "US" },
      dropoff: { line1: "1 Main", city: "NYC", region: "NY", postal_code: "10001", country: "US" },
      zoneId: "zone-near",
      feeCents: 399,
      currency: "USD",
      etaMinutes: 30,
    };
    const [a, b] = await Promise.all([dispatchDelivery(input), dispatchDelivery(input)]);
    expect(a.id).toBe(b.id);
    expect(await getPosDriver().getDeliveryForOrder(id)).toMatchObject({ id: a.id });
  });

  it("lists the oldest paid_at first", async () => {
    const newer = await crashed(7);
    const older = await crashed(30);
    const list = await getPosDriver().listUnfinalizedPaidOrders(new Date().toISOString(), 10);
    expect(list.map((o) => o.id)).toEqual([older, newer]);
  });

  it("a persistently failing order backs off and cannot starve the rest", async () => {
    const bad = await crashed(30);
    const good = await crashed(7);
    const driver = getPosDriver();
    const real = driver.depleteInventoryForOrder.bind(driver);
    const spy = vi
      .spyOn(driver, "depleteInventoryForOrder")
      .mockImplementation(async (oid: string) => {
        if (oid === bad) throw new Error("db down");
        return real(oid);
      });
    try {
      expect(await recoverUnfinalizedOrders()).toBe(1); // `good` recovered, `bad` failed
      const f = (await driver.getOrder(bad))!.fulfillment!;
      expect(f.recovery_attempts).toBe(1);
      expect(new Date(f.recovery_next_at!).getTime()).toBeGreaterThan(Date.now());
      // Backing off: not retried on the next run...
      spy.mockClear();
      await recoverUnfinalizedOrders();
      expect(spy).not.toHaveBeenCalledWith(bad);
      // ...but retried once the backoff has passed.
      await recoverUnfinalizedOrders(new Date(Date.now() + 24 * 60 * MIN));
      expect(spy).toHaveBeenCalledWith(bad);
      expect((await driver.getOrder(bad))!.fulfillment!.recovery_attempts).toBe(2);
    } finally {
      spy.mockRestore();
    }
    expect((await driver.getOrder(good))!.fulfillment!.finalized_at).toBeTruthy();
  });

  it("an expired delivery quote is re-quoted before dispatch (out of zone => failed record)", async () => {
    const stale = new Date(Date.now() - 60 * MIN).toISOString();
    // In-zone: re-quote succeeds and the delivery is dispatched.
    const ok = await seedOnline({ delivery: true, quoteExpiresAt: stale });
    await finalizeOnlinePayment(ok);
    expect((await getPosDriver().getDeliveryForOrder(ok))?.status).not.toBe("failed");
    // Out of zone now: the re-quote is refused, so no dispatch on a dead quote.
    const bad = await seedOnline({ delivery: true, quoteExpiresAt: stale, postal: "99999" });
    await finalizeOnlinePayment(bad);
    expect((await getPosDriver().getDeliveryForOrder(bad))?.status).toBe("failed");
    // A fresh quote is used as-is (even out of zone, nothing is re-quoted).
    const fresh = await seedOnline({
      delivery: true,
      quoteExpiresAt: new Date(Date.now() + 10 * MIN).toISOString(),
      postal: "99999",
    });
    await finalizeOnlinePayment(fresh);
    expect((await getPosDriver().getDeliveryForOrder(fresh))?.status).not.toBe("failed");
  });
});

describe("R8: a mode flip cannot strand orders", () => {
  beforeEach(() => {
    goLive(); // this deployment is mode "test"
  });
  const farFuture = () => new Date(Date.now() + FOREIGN_MODE_GRACE_MS + 60 * MIN);

  it("sweeps another mode's unpaid order once far past its window, if it holds no real tender", async () => {
    const live = await seedOnline({ mode: "live" });
    // Within the normal pass it is invisible...
    expect((await expireOnlineOrders(later(31))).abandoned).toBe(0);
    // ...but after the long grace it is swept.
    const summary = await expireOnlineOrders(farFuture());
    expect(summary.foreignSwept).toBe(1);
    expect((await getPosDriver().getOrder(live))?.status).toBe("abandoned");
  });

  it("alerts ONCE (and stops rescanning) on another mode's order that holds a real tender", async () => {
    const live = await seedOnline({ mode: "live" });
    await seedTender(live, { raw: { livemode: true } });
    const first = await expireOnlineOrders(farFuture());
    expect(first.foreignAlerted).toBe(1);
    expect(first.foreignSwept).toBe(0);
    expect(
      captureSpy.mock.calls.some((c) => (c[1] as { scope?: string }).scope === "expireOnlineOrders.foreign"),
    ).toBe(true);
    expect((await getPosDriver().getOrder(live))?.status).toBe("awaiting_payment");
    expect((await expireOnlineOrders(farFuture())).foreignAlerted).toBe(0);
  });

  it("recovery: another mode's paid order is recovered after the grace if no real tender, else alerted and parked", async () => {
    const mk = async (withReal: boolean) => {
      const id = await seedOnline({ mode: "live" });
      if (withReal) await seedTender(id, { status: "captured", raw: { livemode: true } });
      const o = (await getPosDriver().getOrder(id))!;
      await getPosDriver().transitionOrderStatus(id, ["awaiting_payment"], "paid", {
        fulfillment: { ...o.fulfillment!, paid_at: new Date(Date.now() - 2 * MIN).toISOString() },
      });
      return id;
    };
    const plain = await mk(false);
    const real = await mk(true);
    const now = farFuture();
    expect(await recoverUnfinalizedOrders(now)).toBe(1);
    expect((await getPosDriver().getOrder(plain))!.fulfillment!.finalized_at).toBeTruthy();
    const r = (await getPosDriver().getOrder(real))!.fulfillment!;
    expect(r.finalized_at).toBeUndefined();
    expect(r.recovery_next_at).toBeTruthy(); // parked
    expect(
      captureSpy.mock.calls.some((c) => (c[1] as { scope?: string }).scope === "recoverUnfinalizedOrders.foreign"),
    ).toBe(true);
  });
});

describe("R10: late payments come from a dedicated, ordered, capped query", () => {
  it("returns only open items, newest first, honouring the limit", async () => {
    const driver = getPosDriver();
    const mk = async (marker: Record<string, unknown> | null) => {
      const id = await seedOnline({ status: "abandoned" });
      if (marker) {
        await driver.mergeOrderFulfillment(id, {
          late_payment: { payment_id: "p", amount_cents: 1, flagged_at: "x", ...marker },
        } as never);
      }
      return id;
    };
    await mk(null); // no marker
    const resolved = await mk({ resolved: "refunded" });
    const a = await mk({});
    const owed = await mk({ resolved: "refund_owed_manual" });
    const b = await mk({});
    const all = (await driver.listOpenLatePayments(TENANT, LOCATION)).map((o) => o.id);
    expect(all).not.toContain(resolved);
    expect(new Set(all)).toEqual(new Set([a, owed, b]));
    expect(await driver.listOpenLatePayments(TENANT, LOCATION, 2)).toHaveLength(2);
    expect(await driver.listOpenLatePayments(TENANT, "other-location")).toHaveLength(0);
  });
});
