import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { NextResponse } from "next/server";
import {
  getPosDriver,
  type CreateOrderInput,
  type OrderChannel,
  type OrderItem,
  type OrderStatus,
  type Payment,
} from "@/lib/db";
import { resetMockOrders, resetMockPayments } from "@/lib/db/mock";

const stripeRequest = vi.fn();
const stripeGet = vi.fn();
vi.mock("@/lib/payments/providers/stripe-client", async (orig) => ({
  ...(await orig<typeof import("@/lib/payments/providers/stripe-client")>()),
  stripeRequest: (...a: unknown[]) => stripeRequest(...a),
  stripeGet: (...a: unknown[]) => stripeGet(...a),
}));

const requireTenantMember = vi.fn();
const requireTenantRole = vi.fn();
vi.mock("@/lib/auth/api", () => ({
  requireTenantMember: (...a: unknown[]) => requireTenantMember(...a),
  requireTenantRole: (...a: unknown[]) => requireTenantRole(...a),
}));

import { GET as paymentsGET, POST as paymentsPOST } from "@/app/api/payments/route";
import { POST as webhookPOST } from "@/app/api/payments/stripe/webhook/route";
import { POST as refundPOST } from "@/app/api/payments/refund/route";
import {
  applyRailStatus,
  getOrderBalance,
  orderDueCents,
  refundPayment,
} from "@/lib/payments/service";
import { stripeRefundParams } from "@/lib/payments/fees";
import { verifyStripeWebhook } from "@/lib/payments/providers/stripe-client";

const TENANT = "10000000-0000-0000-0000-000000000001";
const LOCATION = "10000000-0000-0000-0000-000000000101";
const ACCT = "acct_real_1";
const SECRET = "whsec_test_secret";

let seq = 0;

async function seedOrder(opts: {
  subtotal?: number;
  tip?: number;
  channel?: OrderChannel;
  status?: OrderStatus;
}): Promise<string> {
  seq += 1;
  const subtotal = opts.subtotal ?? 1000;
  const tip = opts.tip ?? 0;
  const id = `settle-order-${seq}`;
  const line: OrderItem = {
    id: "l1",
    item_id: "i1",
    item_name: "Pizza",
    size_id: "s1",
    size_name: "L",
    base_price_cents: subtotal,
    quantity: 1,
    modifiers: [],
    notes: null,
    voided: false,
    unit_price_cents: subtotal,
    line_total_cents: subtotal,
  };
  const input: CreateOrderInput = {
    id,
    tenant_id: TENANT,
    location_id: LOCATION,
    channel: opts.channel ?? "online_pickup",
    currency: "USD",
    items: [line],
    discount_cents: 0,
    totals: {
      subtotal_cents: subtotal,
      discount_cents: 0,
      taxable_cents: subtotal,
      tax_cents: 0,
      tip_cents: tip,
      total_cents: subtotal + tip,
    },
    notes: null,
    status: opts.status ?? "placed",
  };
  await getPosDriver().createOrder(input);
  return id;
}

async function seedTender(
  orderId: string,
  over: Partial<Payment> = {},
): Promise<Payment> {
  seq += 1;
  const p: Payment = {
    id: `tender-${seq}`,
    order_id: orderId,
    tenant_id: TENANT,
    location_id: LOCATION,
    rail: "stripe_online",
    status: "requires_action",
    amount_cents: 1000,
    tip_cents: 0,
    application_fee_cents: 0,
    currency: "USD",
    charge_id: `pi_${seq}`,
    connect_account_id: ACCT,
    crypto_tx_hash: null,
    crypto_chain: null,
    cash_tendered_cents: null,
    cash_change_cents: null,
    refunded_cents: 0,
    simulated: false,
    raw: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...over,
  };
  return getPosDriver().upsertPayment(p);
}

beforeEach(() => {
  resetMockOrders();
  resetMockPayments();
  stripeRequest.mockReset();
  stripeGet.mockReset();
  requireTenantMember.mockReset();
  requireTenantRole.mockReset();
  requireTenantMember.mockResolvedValue({ ok: true, user: { id: "u1", email: "s@x" } });
  requireTenantRole.mockResolvedValue({ ok: true, user: { id: "u1", email: "s@x" } });
  vi.unstubAllEnvs();
  vi.stubEnv("STRIPE_SECRET_KEY", "");
  getPosDriver(); // memoize the mock before pretending to be a live driver
  // Behave like a LIVE driver (Supabase env present). The in-memory mock is
  // already memoized by the call above, so storage still works; this only stops
  // card rails from taking the mock-driver training-mode simulated path.
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://localhost:54321");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service-key");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function payReq(orderId: string, body: Record<string, unknown>, ip = "5.5.5.5") {
  return new Request("http://localhost/api/payments", {
    method: "POST",
    headers: { "x-forwarded-for": ip },
    body: JSON.stringify({
      orderId,
      tenantId: TENANT,
      locationId: LOCATION,
      currency: "USD",
      ...body,
    }),
  });
}

describe("S4/S6: online tip is charged once, derived from the order", () => {
  it("ignores the client's amount/tip and charges the order total exactly once", async () => {
    const orderId = await seedOrder({ subtotal: 1000, tip: 150 });
    // A hostile/buggy client sends total + tip (the old double charge).
    const res = await paymentsPOST(
      payReq(orderId, {
        paymentId: "shop-pay-1",
        rail: "stripe_online",
        amountCents: 1150,
        tipCents: 150,
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.payment.amount_cents).toBe(1000);
    expect(body.payment.tip_cents).toBe(150);
    expect(body.payment.amount_cents + body.payment.tip_cents).toBe(1150);
    expect(body.balanceCents).toBe(0);
    expect(body.orderStatus).toBe("paid");
    // The client secret is in this response only, never on the stored tender.
    expect(typeof body.clientSecret).toBe("string");
    const stored = await getPosDriver().getPayment("shop-pay-1");
    expect(JSON.stringify(stored)).not.toContain("secret");
    expect(JSON.stringify(body.payment)).not.toContain(body.clientSecret);
  });

  it("refuses a second online tender once nothing is left to pay", async () => {
    const orderId = await seedOrder({ subtotal: 1000, tip: 100 });
    await paymentsPOST(
      payReq(orderId, { paymentId: "p-a", rail: "stripe_online", amountCents: 1 }),
    );
    const again = await paymentsPOST(
      payReq(orderId, { paymentId: "p-b", rail: "stripe_online", amountCents: 1 }),
    );
    expect(again.status).toBe(409);
  });

  it("an anonymous caller cannot settle an online order with cash", async () => {
    requireTenantMember.mockResolvedValue({
      ok: false,
      res: NextResponse.json({ error: "Not signed in." }, { status: 401 }),
    });
    const orderId = await seedOrder({});
    const res = await paymentsPOST(
      payReq(orderId, { paymentId: "p-cash", rail: "cash", amountCents: 1000 }),
    );
    expect(res.status).toBe(401);
  });

  it("orderDueCents excludes the order tip; terminal orders are unchanged", async () => {
    const online = await getPosDriver().getOrder(
      await seedOrder({ subtotal: 1000, tip: 200 }),
    );
    expect(orderDueCents(online!)).toBe(1000);
    const terminal = await getPosDriver().getOrder(
      await seedOrder({ subtotal: 1000, channel: "in_store" }),
    );
    expect(orderDueCents(terminal!)).toBe(1000);
  });
});

describe("S6: unpaid intents do not cover the balance", () => {
  it("a requires_action tender leaves the balance equal to the due amount", async () => {
    const orderId = await seedOrder({ subtotal: 1000, tip: 100 });
    await seedTender(orderId, { status: "requires_action" });
    const order = (await getPosDriver().getOrder(orderId))!;
    expect(await getOrderBalance(order)).toBe(1000);
  });
});

describe("S5/S7: applyRailStatus", () => {
  it("captured marks the order paid; a replay is a no-op", async () => {
    const orderId = await seedOrder({});
    const t = await seedTender(orderId, { status: "pending" });
    await applyRailStatus(t.id, "captured");
    expect((await getPosDriver().getOrder(orderId))?.status).toBe("paid");
    const first = await getPosDriver().getPayment(t.id);
    await applyRailStatus(t.id, "captured");
    const second = await getPosDriver().getPayment(t.id);
    expect(second?.status).toBe("captured");
    expect(second?.updated_at).toBe(first?.updated_at);
    expect((await getPosDriver().getOrder(orderId))?.status).toBe("paid");
  });

  it("never downgrades a captured tender", async () => {
    const orderId = await seedOrder({});
    const t = await seedTender(orderId, { status: "captured" });
    for (const s of ["failed", "canceled", "requires_action", "pending"] as const) {
      await applyRailStatus(t.id, s);
      expect((await getPosDriver().getPayment(t.id))?.status).toBe("captured");
    }
  });

  it("marks the order paid even if the tender was already captured", async () => {
    const orderId = await seedOrder({});
    const t = await seedTender(orderId, { status: "captured" });
    expect((await getPosDriver().getOrder(orderId))?.status).toBe("placed");
    await applyRailStatus(t.id, "captured");
    expect((await getPosDriver().getOrder(orderId))?.status).toBe("paid");
  });

  it("S7: a late settlement leaves an in_kitchen order in_kitchen", async () => {
    const orderId = await seedOrder({ status: "in_kitchen" });
    const t = await seedTender(orderId, { status: "pending" });
    await applyRailStatus(t.id, "captured");
    expect((await getPosDriver().getOrder(orderId))?.status).toBe("in_kitchen");
  });
});

describe("S5: Stripe Connect webhook", () => {
  const NOW = () => Math.floor(Date.now() / 1000);

  function sign(payload: string, t = NOW(), secrets = [SECRET]) {
    const sigs = secrets.map(
      (s) => `v1=${createHmac("sha256", s).update(`${t}.${payload}`).digest("hex")}`,
    );
    return `t=${t},${sigs.join(",")}`;
  }

  function hook(
    event: Record<string, unknown>,
    opts: { header?: string; t?: number; secrets?: string[] } = {},
  ) {
    const payload = JSON.stringify(event);
    return new Request("http://localhost/api/payments/stripe/webhook", {
      method: "POST",
      headers: {
        "stripe-signature": opts.header ?? sign(payload, opts.t, opts.secrets),
      },
      body: payload,
    });
  }

  function intentEvent(
    t: Payment,
    type = "payment_intent.succeeded",
    over: { account?: string | null; amount?: number; currency?: string } = {},
  ) {
    return {
      id: "evt_1",
      type,
      ...(over.account === null ? {} : { account: over.account ?? ACCT }),
      data: {
        object: {
          id: t.charge_id,
          amount: over.amount ?? t.amount_cents + t.tip_cents,
          currency: over.currency ?? "usd",
          metadata: { payment_id: t.id },
          last_payment_error: { message: "Your card was declined." },
        },
      },
    };
  }

  beforeEach(() => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", SECRET);
  });

  async function setup() {
    const orderId = await seedOrder({});
    const tender = await seedTender(orderId, { status: "requires_action" });
    return { orderId, tender };
  }

  it("rejects a bad signature (400)", async () => {
    const { tender } = await setup();
    const res = await webhookPOST(
      hook(intentEvent(tender), { secrets: ["whsec_wrong"] }),
    );
    expect(res.status).toBe(400);
    expect((await getPosDriver().getPayment(tender.id))?.status).toBe("requires_action");
  });

  it("rejects a stale timestamp (400)", async () => {
    const { tender } = await setup();
    const res = await webhookPOST(hook(intentEvent(tender), { t: NOW() - 3600 }));
    expect(res.status).toBe(400);
  });

  it("accepts a rotated secret (second v1 entry) and settles", async () => {
    const { orderId, tender } = await setup();
    const res = await webhookPOST(
      hook(intentEvent(tender), { secrets: ["whsec_old_one", SECRET] }),
    );
    expect(res.status).toBe(200);
    expect((await getPosDriver().getPayment(tender.id))?.status).toBe("captured");
    expect((await getPosDriver().getOrder(orderId))?.status).toBe("paid");
  });

  it("ignores an event for a different account", async () => {
    const { orderId, tender } = await setup();
    const res = await webhookPOST(
      hook(intentEvent(tender, "payment_intent.succeeded", { account: "acct_other" })),
    );
    expect(res.status).toBe(200);
    expect((await getPosDriver().getPayment(tender.id))?.status).toBe("requires_action");
    expect((await getPosDriver().getOrder(orderId))?.status).toBe("placed");
  });

  it("ignores an event with no account", async () => {
    const { tender } = await setup();
    await webhookPOST(
      hook(intentEvent(tender, "payment_intent.succeeded", { account: null })),
    );
    expect((await getPosDriver().getPayment(tender.id))?.status).toBe("requires_action");
  });

  it("does not settle on an amount or currency mismatch", async () => {
    const { orderId, tender } = await setup();
    await webhookPOST(
      hook(intentEvent(tender, "payment_intent.succeeded", { amount: 1 })),
    );
    await webhookPOST(
      hook(intentEvent(tender, "payment_intent.succeeded", { currency: "eur" })),
    );
    expect((await getPosDriver().getPayment(tender.id))?.status).toBe("requires_action");
    expect((await getPosDriver().getOrder(orderId))?.status).toBe("placed");
  });

  it("payment_failed -> requires_action with last_error", async () => {
    const orderId = await seedOrder({});
    const tender = await seedTender(orderId, { status: "pending" });
    await webhookPOST(hook(intentEvent(tender, "payment_intent.payment_failed")));
    const after = await getPosDriver().getPayment(tender.id);
    expect(after?.status).toBe("requires_action");
    expect(after?.raw?.last_error).toBe("Your card was declined.");
  });

  it("processing -> pending, canceled -> canceled, other types are no-ops", async () => {
    const { tender } = await setup();
    await webhookPOST(hook(intentEvent(tender, "payment_intent.processing")));
    expect((await getPosDriver().getPayment(tender.id))?.status).toBe("pending");
    await webhookPOST(hook(intentEvent(tender, "payment_intent.canceled")));
    expect((await getPosDriver().getPayment(tender.id))?.status).toBe("canceled");
    const res = await webhookPOST(hook(intentEvent(tender, "charge.refunded")));
    expect(res.status).toBe(200);
    expect((await getPosDriver().getPayment(tender.id))?.status).toBe("canceled");
  });

  it("an unknown tender is acknowledged with 200", async () => {
    const { tender } = await setup();
    const ghost = { ...tender, id: "nope", charge_id: "pi_ghost" };
    const ev = intentEvent(ghost);
    (ev.data.object as { metadata: Record<string, string> }).metadata = {};
    expect((await webhookPOST(hook(ev))).status).toBe(200);
  });
});

describe("verifyStripeWebhook", () => {
  it("honours toleranceSec and multiple v1 entries", () => {
    const body = "{}";
    const t = 1_000_000;
    const good = createHmac("sha256", SECRET).update(`${t}.${body}`).digest("hex");
    const header = `t=${t},v1=deadbeef,v1=${good}`;
    expect(verifyStripeWebhook(body, header, SECRET, { nowSec: t + 10 })).toBe(true);
    expect(verifyStripeWebhook(body, header, SECRET, { nowSec: t + 301 })).toBe(false);
    expect(verifyStripeWebhook(body, header, "other", { nowSec: t })).toBe(false);
    expect(verifyStripeWebhook(body, null, SECRET)).toBe(false);
  });
});

describe("S3: GET /api/payments is staff-only and hides rail internals", () => {
  it("is denied without a tenant session", async () => {
    requireTenantMember.mockResolvedValue({
      ok: false,
      res: NextResponse.json({ error: "Not signed in." }, { status: 401 }),
    });
    const orderId = await seedOrder({});
    const res = await paymentsGET(
      new Request(`http://localhost/api/payments?orderId=${orderId}`),
    );
    expect(res.status).toBe(401);
    expect(requireTenantMember).toHaveBeenCalledWith(TENANT);
  });

  it("strips raw / clientSecret from tenders for staff", async () => {
    const orderId = await seedOrder({});
    await seedTender(orderId, {
      status: "requires_action",
      raw: { clientSecret: "pi_x_secret_leak", applicationFeeCents: 55, stripeStatus: "x" },
    });
    const res = await paymentsGET(
      new Request(`http://localhost/api/payments?orderId=${orderId}`),
    );
    expect(res.status).toBe(200);
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain("pi_x_secret_leak");
    expect(text).not.toContain("clientSecret");
    expect(text).not.toContain("applicationFeeCents");
  });
});

describe("S9: refunds are owner|manager only", () => {
  it("authorizes with exactly owner+manager and returns the guard's denial", async () => {
    const orderId = await seedOrder({});
    const t = await seedTender(orderId, { status: "captured", id: "11111111-1111-4111-8111-111111111111" });
    requireTenantRole.mockResolvedValue({
      ok: false,
      res: NextResponse.json({ error: "Not authorized for this tenant." }, { status: 403 }),
    });
    const res = await refundPOST(
      new Request("http://localhost/api/payments/refund", {
        method: "POST",
        headers: { "x-forwarded-for": "6.6.6.6" },
        body: JSON.stringify({ paymentId: t.id }),
      }),
    );
    expect(res.status).toBe(403);
    expect(requireTenantRole).toHaveBeenCalledWith(TENANT, ["owner", "manager"]);
    expect((await getPosDriver().getPayment(t.id))?.status).toBe("captured");
  });
});

describe("S8: direct-charge refunds", () => {
  it("stripeRefundParams never sends reverse_transfer; fee refund only on a full refund", () => {
    const full = stripeRefundParams({ chargeId: "pi_1", fullRefund: true });
    expect(full).not.toHaveProperty("reverse_transfer");
    expect(full.refund_application_fee).toBe(true);
    const partial = stripeRefundParams({ chargeId: "pi_1", amountCents: 100, fullRefund: false });
    expect(partial.refund_application_fee).toBeUndefined();
    expect(partial.amount).toBe(100);
  });

  for (const rail of ["stripe_terminal", "stripe_online"] as const) {
    it(`${rail}: refunds on the connected account without reverse_transfer`, async () => {
      vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
      stripeRequest.mockResolvedValue({ id: "re_1", status: "succeeded" });
      const orderId = await seedOrder({ channel: "in_store" });
      const t = await seedTender(orderId, { rail, status: "captured", tip_cents: 0 });

      await refundPayment({ paymentId: t.id, amountCents: 400 });
      let [path, body, opts] = stripeRequest.mock.calls[0]!;
      expect(path).toBe("/refunds");
      expect(body).not.toHaveProperty("reverse_transfer");
      expect(body.refund_application_fee).toBeUndefined();
      expect(opts.stripeAccount).toBe(ACCT);

      await refundPayment({ paymentId: t.id, amountCents: 600 });
      [path, body, opts] = stripeRequest.mock.calls[1]!;
      expect(body.refund_application_fee).toBe(true);
      expect(body).not.toHaveProperty("reverse_transfer");
    });
  }
});
