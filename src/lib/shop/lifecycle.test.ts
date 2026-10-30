/**
 * Online-order lifecycle (slice 1): awaiting_payment -> paid | abandoned.
 *
 * Mock driver, zero env. Stripe calls are mocked where a real (non-simulated)
 * card tender is needed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getPosDriver,
  DEMO_TENANT_ID,
  DEMO_LOCATION_DOWNTOWN_ID,
  type CreateOrderInput,
  type OrderItem,
  type OrderStatus,
  type Payment,
} from "@/lib/db";
import { LiveTenderConflictError } from "@/lib/db/payment-types";
import { resetMockOnline, resetMockOrders, resetMockPayments } from "@/lib/db/mock";
import { buildTickets } from "@/lib/kds/board";

const stripeRequest = vi.fn();
const stripeGet = vi.fn();
vi.mock("@/lib/payments/providers/stripe-client", async (orig) => ({
  ...(await orig<typeof import("@/lib/payments/providers/stripe-client")>()),
  stripeRequest: (...a: unknown[]) => stripeRequest(...a),
  stripeGet: (...a: unknown[]) => stripeGet(...a),
}));

import { applyRailStatus } from "@/lib/payments/service";
import { deriveTenderId } from "@/lib/payments/ids";
import { finalizeOnlinePayment } from "./finalize";
import {
  cancelOnlineCheckout,
  expireOnlineOrders,
  orderExpiresAt,
} from "./lifecycle";
import { POST as cancelPOST } from "@/app/api/shop/orders/cancel/route";
import { POST as syncPOST } from "@/app/api/shop/orders/[id]/pay/sync/route";
import { GET as cronGET } from "@/app/api/cron/expire-online-orders/route";
import { POST as paymentsPOST } from "@/app/api/payments/route";

const TENANT = DEMO_TENANT_ID;
const LOCATION = DEMO_LOCATION_DOWNTOWN_ID;
const ITEM_MARGHERITA = "30000000-0000-0000-0000-000000000001";
const ACCT = "acct_real_1";
const MIN = 60_000;

let seq = 0;

function line(qty = 1): OrderItem {
  return {
    id: `l-${qty}`,
    item_id: ITEM_MARGHERITA,
    item_name: "Margherita",
    size_id: "s1",
    size_name: "L",
    base_price_cents: 1800,
    quantity: qty,
    modifiers: [],
    notes: null,
    voided: false,
    unit_price_cents: 1800,
    line_total_cents: 1800 * qty,
  };
}

async function seedOnline(
  opts: {
    status?: OrderStatus;
    delivery?: boolean;
    asap?: boolean;
    promisedAt?: string;
  } = {},
): Promise<string> {
  seq += 1;
  const id = `life-order-${seq}`;
  const delivery = opts.delivery ?? false;
  const input: CreateOrderInput = {
    id,
    tenant_id: TENANT,
    location_id: LOCATION,
    channel: delivery ? "online_delivery" : "online_pickup",
    currency: "USD",
    items: [line(2)],
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
      scheduled_for: opts.asap === false ? "2030-01-01T18:00:00.000Z" : "asap",
      promised_at: opts.promisedAt ?? "2026-01-01T00:00:00.000Z",
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
    id: `life-tender-${seq}`,
    order_id: orderId,
    tenant_id: TENANT,
    location_id: LOCATION,
    rail: "stripe_online",
    status: "requires_action",
    amount_cents: 3600,
    tip_cents: 0,
    application_fee_cents: 0,
    currency: "USD",
    charge_id: `pi_life_${seq}`,
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
  return buildTickets(orders, new Date(), { warn_seconds: 300, urgent_seconds: 600 }).map(
    (t) => t.order.id,
  );
}

function jsonReq(url: string, body: unknown) {
  return new Request(url, {
    method: "POST",
    headers: { "x-forwarded-for": "9.9.9.9" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  resetMockOrders();
  resetMockPayments();
  resetMockOnline();
  stripeRequest.mockReset();
  stripeGet.mockReset();
  vi.unstubAllEnvs();
  vi.stubEnv("STRIPE_SECRET_KEY", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("awaiting_payment is invisible until paid", () => {
  it("is off the KDS board, depletes nothing and dispatches nothing", async () => {
    const dough = await onHand("Pizza dough ball");
    const id = await seedOnline({ delivery: true });
    expect(await boardIds()).not.toContain(id);
    expect(await onHand("Pizza dough ball")).toBe(dough);
    expect(await getPosDriver().getDeliveryForOrder(id)).toBeNull();
  });

  it("finalize puts it on the board, depletes once and dispatches the quoted delivery", async () => {
    const dough = await onHand("Pizza dough ball");
    const id = await seedOnline({ delivery: true });
    const { won, order } = await finalizeOnlinePayment(id);
    expect(won).toBe(true);
    expect(order?.status).toBe("paid");
    expect(await boardIds()).toContain(id);
    // Margherita: 1 dough per pizza, 2 pizzas.
    expect(await onHand("Pizza dough ball")).toBe(dough - 2);
    const delivery = await getPosDriver().getDeliveryForOrder(id);
    expect(delivery?.provider).toBe("in_house_manual");
    expect(delivery?.eta_minutes).toBe(30);
  });

  it("concurrent finalizes give exactly one depletion and one dispatch", async () => {
    const dough = await onHand("Pizza dough ball");
    const id = await seedOnline({ delivery: true });
    const results = await Promise.all(
      Array.from({ length: 6 }, () => finalizeOnlinePayment(id)),
    );
    expect(results.filter((r) => r.won)).toHaveLength(1);
    expect(await onHand("Pizza dough ball")).toBe(dough - 2);
    const moves = (
      await getPosDriver().listInventoryMovements(TENANT, LOCATION)
    ).filter((m) => m.order_id === id);
    expect(moves.length).toBeGreaterThan(0);
    const again = await finalizeOnlinePayment(id);
    expect(again.won).toBe(false);
    expect(await onHand("Pizza dough ball")).toBe(dough - 2);
  });

  it("recomputes an ASAP promised_at from payment time; a scheduled slot is kept", async () => {
    const asap = await seedOnline({ asap: true });
    const before = Date.now();
    await finalizeOnlinePayment(asap);
    const promised = new Date(
      (await getPosDriver().getOrder(asap))!.fulfillment!.promised_at,
    ).getTime();
    expect(promised).toBeGreaterThanOrEqual(before + 20 * MIN - 1000);

    const scheduled = await seedOnline({
      asap: false,
      promisedAt: "2030-01-01T18:00:00.000Z",
    });
    await finalizeOnlinePayment(scheduled);
    expect(
      (await getPosDriver().getOrder(scheduled))!.fulfillment!.promised_at,
    ).toBe("2030-01-01T18:00:00.000Z");
  });

  it("a settled tender finalizes the order through the payment service", async () => {
    const id = await seedOnline();
    const t = await seedTender(id, { simulated: true });
    await applyRailStatus(t.id, "captured");
    expect((await getPosDriver().getOrder(id))?.status).toBe("paid");
    expect(await boardIds()).toContain(id);
  });

  it("money arriving for an ABANDONED order does not promote it", async () => {
    const id = await seedOnline({ status: "abandoned" });
    const t = await seedTender(id, { simulated: true, status: "pending" });
    await applyRailStatus(t.id, "captured");
    expect((await getPosDriver().getOrder(id))?.status).toBe("abandoned");
    expect(await boardIds()).not.toContain(id);
  });

  it("an in-store order still goes placed -> paid", async () => {
    seq += 1;
    const id = `life-store-${seq}`;
    await getPosDriver().createOrder({
      id,
      tenant_id: TENANT,
      location_id: LOCATION,
      channel: "in_store",
      currency: "USD",
      items: [line()],
      discount_cents: 0,
      totals: {
        subtotal_cents: 1800,
        discount_cents: 0,
        taxable_cents: 1800,
        tax_cents: 0,
        tip_cents: 0,
        total_cents: 1800,
      },
      notes: null,
      status: "placed",
    });
    const t = await seedTender(id, {
      rail: "cash",
      status: "captured",
      amount_cents: 1800,
      simulated: false,
    });
    await applyRailStatus(t.id, "captured");
    expect((await getPosDriver().getOrder(id))?.status).toBe("paid");
  });
});

describe("transitionOrderStatus (shared compare-and-set)", () => {
  it("moves only from an allowed status, and reports the loser", async () => {
    const driver = getPosDriver();
    const id = await seedOnline();
    expect(await driver.transitionOrderStatus(id, ["placed"], "paid")).toBeNull();
    const won = await driver.transitionOrderStatus(id, ["awaiting_payment"], "abandoned");
    expect(won?.status).toBe("abandoned");
    expect(
      await driver.transitionOrderStatus(id, ["awaiting_payment"], "paid"),
    ).toBeNull();
    expect((await driver.getOrder(id))?.status).toBe("abandoned");
  });
});

describe("one live card tender per order (mock mirrors the unique index)", () => {
  it("refuses a second live stripe_online tender; a canceled one frees the slot", async () => {
    const id = await seedOnline();
    const first = await seedTender(id);
    await expect(seedTender(id)).rejects.toBeInstanceOf(LiveTenderConflictError);
    // Another rail is unaffected.
    await seedTender(id, { rail: "crypto_onchain_usdc", status: "pending" });
    await applyRailStatus(first.id, "canceled");
    await expect(seedTender(id)).resolves.toBeTruthy();
  });
});

describe("expiry windows", () => {
  it("card 30 min, USDC and Coinbase 60 min, from the live tender's rail", async () => {
    const id = await seedOnline();
    const order = (await getPosDriver().getOrder(id))!;
    const created = new Date(order.created_at).getTime();
    expect(orderExpiresAt(order, []).getTime()).toBe(created + 30 * MIN);
    const usdc = await seedTender(id, { rail: "crypto_onchain_usdc", status: "pending" });
    expect(orderExpiresAt(order, [usdc]).getTime()).toBe(created + 60 * MIN);
    const cb = { ...usdc, rail: "crypto_coinbase" as const };
    expect(orderExpiresAt(order, [cb]).getTime()).toBe(created + 60 * MIN);
    // A canceled tender no longer decides the window.
    expect(
      orderExpiresAt(order, [{ ...usdc, status: "canceled" }]).getTime(),
    ).toBe(created + 30 * MIN);
  });

  it("windows are overridable from env", async () => {
    vi.stubEnv("ONLINE_CHECKOUT_WINDOW_CARD_MIN", "5");
    const id = await seedOnline();
    const order = (await getPosDriver().getOrder(id))!;
    expect(orderExpiresAt(order, []).getTime()).toBe(
      new Date(order.created_at).getTime() + 5 * MIN,
    );
  });
});

describe("abandonment sweeper", () => {
  beforeEach(() => {
    // A live (Supabase-shaped) driver with a real test key, like staging.
    getPosDriver();
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://localhost:54321");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service-key");
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
  });

  const later = (min: number) => new Date(Date.now() + min * MIN);

  it("leaves an unexpired order alone and abandons an expired one", async () => {
    const id = await seedOnline();
    const t = await seedTender(id);
    stripeRequest.mockResolvedValue({ id: t.charge_id, status: "canceled" });

    expect((await expireOnlineOrders(later(10))).abandoned).toBe(0);
    expect((await getPosDriver().getOrder(id))?.status).toBe("awaiting_payment");

    const summary = await expireOnlineOrders(later(31));
    expect(summary.abandoned).toBe(1);
    expect((await getPosDriver().getOrder(id))?.status).toBe("abandoned");
    expect((await getPosDriver().getPayment(t.id))?.status).toBe("canceled");
    expect(stripeRequest.mock.calls[0]![0]).toBe(`/payment_intents/${t.charge_id}/cancel`);
    expect(await boardIds()).not.toContain(id);
  });

  it("finalizes instead when the card had actually succeeded", async () => {
    const id = await seedOnline();
    const t = await seedTender(id);
    stripeGet.mockResolvedValue({ status: "succeeded" });
    const summary = await expireOnlineOrders(later(31));
    expect(summary.finalized).toBe(1);
    expect(summary.abandoned).toBe(0);
    expect((await getPosDriver().getOrder(id))?.status).toBe("paid");
    expect((await getPosDriver().getPayment(t.id))?.status).toBe("captured");
    expect(await boardIds()).toContain(id);
  });

  it("skips a card that is still processing", async () => {
    const id = await seedOnline();
    await seedTender(id, { status: "pending" });
    stripeGet.mockResolvedValue({ status: "processing" });
    const summary = await expireOnlineOrders(later(31));
    expect(summary.skipped).toBe(1);
    expect((await getPosDriver().getOrder(id))?.status).toBe("awaiting_payment");
  });

  it("only touches tenders of its own Stripe mode", async () => {
    const id = await seedOnline();
    await seedTender(id, { raw: { livemode: true } }); // deployment key is sk_test_
    const summary = await expireOnlineOrders(later(31));
    expect(summary.skipped).toBe(1);
    expect(stripeRequest).not.toHaveBeenCalled();
    expect(stripeGet).not.toHaveBeenCalled();
    expect((await getPosDriver().getOrder(id))?.status).toBe("awaiting_payment");
  });

  it("USDC uses its own 60 min window, then cancels the pending tender", async () => {
    const id = await seedOnline();
    const t = await seedTender(id, {
      rail: "crypto_onchain_usdc",
      status: "pending",
      simulated: true,
      connect_account_id: null,
    });
    expect((await expireOnlineOrders(later(45))).checked).toBe(0);
    expect((await expireOnlineOrders(later(61))).abandoned).toBe(1);
    expect((await getPosDriver().getPayment(t.id))?.status).toBe("canceled");
  });

  it("an order with no tender at all expires on the card window", async () => {
    const id = await seedOnline();
    expect((await expireOnlineOrders(later(31))).abandoned).toBe(1);
    expect((await getPosDriver().getOrder(id))?.status).toBe("abandoned");
  });

  it("a deployment that simulates cards never touches a real tender", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    const id = await seedOnline();
    await seedTender(id);
    const summary = await expireOnlineOrders(later(31));
    expect(summary.skipped).toBe(1);
    expect((await getPosDriver().getOrder(id))?.status).toBe("awaiting_payment");
  });
});

describe("cancelOnlineCheckout", () => {
  it("abandons an unpaid order and is idempotent", async () => {
    const id = await seedOnline();
    const r = await cancelOnlineCheckout(id);
    expect(r.ok && r.order.status).toBe("abandoned");
    expect((await cancelOnlineCheckout(id)).ok).toBe(true);
  });

  it("refuses when a real crypto payment may be in flight", async () => {
    const id = await seedOnline();
    await seedTender(id, {
      rail: "crypto_onchain_usdc",
      status: "pending",
      simulated: false,
    });
    const r = await cancelOnlineCheckout(id);
    expect(r).toEqual({ ok: false, reason: "has_payment" });
    expect((await getPosDriver().getOrder(id))?.status).toBe("awaiting_payment");
  });

  it("refuses a paid order", async () => {
    const id = await seedOnline({ status: "paid" });
    expect(await cancelOnlineCheckout(id)).toEqual({ ok: false, reason: "not_awaiting" });
  });
});

describe("routes", () => {
  it("cancel route abandons awaiting_payment (200, idempotent) and 409s a paid order", async () => {
    const id = await seedOnline();
    const res = await cancelPOST(jsonReq("http://x/api/shop/orders/cancel", { orderId: id }));
    expect(res.status).toBe(200);
    expect((await res.json()).order.status).toBe("abandoned");
    const again = await cancelPOST(jsonReq("http://x/api/shop/orders/cancel", { orderId: id }));
    expect(again.status).toBe(200);
    const paid = await seedOnline({ status: "paid" });
    expect(
      (await cancelPOST(jsonReq("http://x/api/shop/orders/cancel", { orderId: paid }))).status,
    ).toBe(409);
  });

  it("sync reports the order status and confirms a sim crypto payment once it settles", async () => {
    const id = await seedOnline({ asap: false });
    const res = await paymentsPOST(
      jsonReq("http://x/api/payments", {
        paymentId: "ignored",
        orderId: id,
        tenantId: TENANT,
        locationId: LOCATION,
        rail: "crypto_onchain_usdc",
        amountCents: 3600,
        currency: "USD",
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    // Pending crypto is NOT paid: the order stays off the board.
    expect(body.orderStatus).toBe("awaiting_payment");
    expect(body.payment.id).toBe(deriveTenderId(id, "crypto_onchain_usdc"));
    expect(await boardIds()).not.toContain(id);

    const sync = await syncPOST(jsonReq("http://x/sync", {}), {
      params: Promise.resolve({ id }),
    });
    expect(sync.status).toBe(200);
    expect((await sync.json()).orderStatus).toBe("awaiting_payment");

    // Fast-forward the simulated chain confirmation (6s).
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 7_000);
    try {
      const done = await syncPOST(jsonReq("http://x/sync", {}), {
        params: Promise.resolve({ id }),
      });
      expect((await done.json()).orderStatus).toBe("paid");
    } finally {
      vi.useRealTimers();
    }
    expect(await boardIds()).toContain(id);
  });

  it("/api/payments: a replay is the SAME derived tender, never a second charge", async () => {
    const id = await seedOnline({ asap: false });
    const send = (paymentId: string) =>
      paymentsPOST(
        jsonReq("http://x/api/payments", {
          paymentId,
          orderId: id,
          tenantId: TENANT,
          locationId: LOCATION,
          rail: "stripe_online",
          amountCents: 1,
          currency: "USD",
        }),
      );
    const a = await (await send("client-a")).json();
    const b = await (await send("client-b")).json();
    expect(a.payment.id).toBe(deriveTenderId(id, "stripe_online"));
    expect(b.payment.id).toBe(a.payment.id);
    expect(a.payment.charge_id).toBe(b.payment.charge_id);
    expect(a.orderStatus).toBe("paid"); // simulated card settles instantly
  });

  it("/api/payments: 409 once the rail's window has passed, and the order is abandoned", async () => {
    const id = await seedOnline({ asap: false });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 31 * MIN);
    try {
      const res = await paymentsPOST(
        jsonReq("http://x/api/payments", {
          paymentId: "p",
          orderId: id,
          tenantId: TENANT,
          locationId: LOCATION,
          rail: "stripe_online",
          amountCents: 1,
          currency: "USD",
        }),
      );
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe("checkout_abandoned");
    } finally {
      vi.useRealTimers();
    }
    expect((await getPosDriver().getOrder(id))?.status).toBe("abandoned");
  });

  it("/api/payments: an abandoned order cannot be paid", async () => {
    const id = await seedOnline({ status: "abandoned" });
    const res = await paymentsPOST(
      jsonReq("http://x/api/payments", {
        paymentId: "p",
        orderId: id,
        tenantId: TENANT,
        locationId: LOCATION,
        rail: "stripe_online",
        amountCents: 1,
        currency: "USD",
      }),
    );
    expect(res.status).toBe(409);
    expect(await getPosDriver().getPayment(deriveTenderId(id, "stripe_online"))).toBeNull();
  });

  it("cron: secret required on a live driver; open on the mock driver", async () => {
    // Zero env => mock driver => callable without a secret.
    expect((await cronGET(new Request("http://x/cron"))).status).toBe(200);
    vi.stubEnv("CRON_SECRET", "s3cret");
    expect((await cronGET(new Request("http://x/cron"))).status).toBe(401);
    expect(
      (
        await cronGET(
          new Request("http://x/cron", { headers: { authorization: "Bearer nope" } }),
        )
      ).status,
    ).toBe(401);
    const ok = await cronGET(
      new Request("http://x/cron", { headers: { authorization: "Bearer s3cret" } }),
    );
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ errors: 0 });
    vi.stubEnv("CRON_SECRET", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://localhost:54321");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "k");
    expect((await cronGET(new Request("http://x/cron"))).status).toBe(401);
  });
});

describe("reports and health ignore unpaid online orders", () => {
  it("excludes awaiting_payment and abandoned from the sales report and tenant health", async () => {
    const driver = getPosDriver();
    const range = {
      from: new Date(Date.now() - 86_400_000).toISOString(),
      to: new Date(Date.now() + 86_400_000).toISOString(),
    };
    const before = await driver.getSalesReport(TENANT, LOCATION, range);
    const healthBefore = (await driver.listTenantHealth()).find(
      (t) => t.tenant_id === TENANT,
    )!;
    await seedOnline();
    await seedOnline({ status: "abandoned" });
    const after = await driver.getSalesReport(TENANT, LOCATION, range);
    expect(after.order_count).toBe(before.order_count);
    expect(after.gross_cents).toBe(before.gross_cents);
    const healthAfter = (await driver.listTenantHealth()).find(
      (t) => t.tenant_id === TENANT,
    )!;
    expect(healthAfter.recent_order_count).toBe(healthBefore.recent_order_count);
    // ...and a paid one counts.
    await seedOnline({ status: "paid" });
    const paid = await driver.getSalesReport(TENANT, LOCATION, range);
    expect(paid.order_count).toBe(before.order_count + 1);
  });
});
