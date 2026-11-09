/**
 * "Gift card instead": an order with an open card payment nobody is paying yet
 * (reader idle at the till, an unconfirmed intent online) can still be paid with
 * a gift card. The open payment is canceled first; it never double-pays.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { DEMO_LOCATION_DOWNTOWN_ID, DEMO_TENANT_ID, getPosDriver, type OrderItem, type Payment } from "@/lib/db";
import { resetMockOnline, resetMockOrders, resetMockPayments } from "@/lib/db/mock";
import { resetMockStoredValue } from "@/lib/giftcards/store-mock";
import { createGiftCardSale } from "@/lib/giftcards/service";
import { takePayment } from "@/lib/payments/service";

vi.mock("@/lib/auth/tenant-guard", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth/tenant-guard")>()),
  requireTenantAccess: async (tenantId: string | null) => ({
    ok: true,
    user: { id: "00000000-0000-4000-8000-0000000000aa", email: "s@example.com", memberships: [] },
    tenantId,
    locationId: null,
    role: "owner",
  }),
}));
vi.mock("@/lib/auth/active-staff", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth/active-staff")>()),
  effectiveTerminalRole: async () => ({ role: "cashier", staff: null }),
}));

import { POST as redeemPOST } from "./redeem/route";
import { POST as shopRedeemPOST } from "@/app/api/shop/gift-cards/redeem/route";

const TENANT = DEMO_TENANT_ID;
const LOCATION = DEMO_LOCATION_DOWNTOWN_ID;

const req = (url: string, body: unknown) =>
  new Request(`https://pos.test${url}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

function line(cents: number): OrderItem {
  return {
    id: randomUUID(), item_id: "30000000-0000-0000-0000-000000000001", item_name: "Margherita",
    size_id: "s1", size_name: "L", base_price_cents: cents, quantity: 1, modifiers: [], notes: null,
    voided: false, unit_price_cents: cents, line_total_cents: cents,
  };
}

async function order(total: number, online: boolean) {
  const now = new Date().toISOString();
  return getPosDriver().createOrder({
    id: randomUUID(), tenant_id: TENANT, location_id: LOCATION,
    channel: online ? "online_pickup" : "in_store", currency: "USD", items: [line(total)], discount_cents: 0,
    totals: { subtotal_cents: total, discount_cents: 0, taxable_cents: total, tax_cents: 0, tip_cents: 0, total_cents: total },
    notes: null, status: online ? "awaiting_payment" : "placed",
    ...(online ? { fulfillment: { type: "pickup" as const, scheduled_for: now, promised_at: now } } : {}),
  });
}

async function card(amount: number) {
  const sale = await createGiftCardSale({
    tenantId: TENANT, locationId: LOCATION, orderId: randomUUID(), amountCents: amount, channel: "in_store", currency: "USD",
  });
  await takePayment({
    paymentId: randomUUID(), orderId: sale.order.id, tenantId: TENANT, locationId: LOCATION,
    rail: "cash", amountCents: amount, tipCents: 0, currency: "USD",
  });
  return sale.code!;
}

beforeEach(() => {
  resetMockOrders();
  resetMockPayments();
  resetMockOnline();
  resetMockStoredValue();
});

describe("open card payment, then gift card instead", () => {
  it("at the till: an idle reader payment is canceled and the card pays the order", async () => {
    const code = await card(5000);
    const o = await order(2000, false);
    const reader: Payment = await getPosDriver().upsertPayment({
      id: randomUUID(), order_id: o.id, tenant_id: TENANT, location_id: LOCATION, rail: "stripe_terminal",
      status: "pending", amount_cents: 2000, tip_cents: 0, application_fee_cents: 0, currency: "USD",
      charge_id: `sim_pi_${randomUUID()}`, connect_account_id: "acct_sim_1", crypto_tx_hash: null, crypto_chain: null,
      cash_tendered_cents: null, cash_change_cents: null, refunded_cents: 0, simulated: true,
      raw: { reader_id: "tmr_sim_1" }, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    });
    const res = await redeemPOST(req("/api/gift-cards/redeem", { orderId: o.id, code, paymentId: randomUUID() }));
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(201);
    expect(body).toMatchObject({ payment: { amount_cents: 2000 }, balanceCents: 0, orderStatus: "paid" });
    expect((await getPosDriver().getPayment(reader.id))!.status).toBe("canceled");
  });

  it("online: an unconfirmed card intent is canceled and the card pays the rest", async () => {
    const code = await card(1500);
    const o = await order(4000, true);
    // An intent created but never confirmed (requires_payment_method -> requires_action).
    const opened = { payment: await getPosDriver().upsertPayment({
      id: randomUUID(), order_id: o.id, tenant_id: TENANT, location_id: LOCATION, rail: "stripe_online",
      status: "requires_action", amount_cents: 4000, tip_cents: 0, application_fee_cents: 0, currency: "USD",
      charge_id: `sim_pi_${randomUUID()}`, connect_account_id: "acct_sim_1", crypto_tx_hash: null, crypto_chain: null,
      cash_tendered_cents: null, cash_change_cents: null, refunded_cents: 0, simulated: true, raw: null,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }) };
    const res = await shopRedeemPOST(req("/api/shop/gift-cards/redeem", { orderId: o.id, code }));
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body).toMatchObject({ payment: { amount_cents: 1500 }, balanceCents: 2500 });
    expect((await getPosDriver().getPayment(opened.payment.id))!.status).toBe("canceled");
  });
});
