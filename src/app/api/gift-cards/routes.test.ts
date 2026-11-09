/**
 * Gift card HTTP surface: till sale -> pay -> balance -> redeem, role gates on
 * void / store credit, uniform 404s for unknown codes, and the storefront's
 * anonymous balance check + checkout redemption.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import {
  DEMO_LOCATION_DOWNTOWN_ID,
  DEMO_TENANT_ID,
  getPosDriver,
  type OrderItem,
} from "@/lib/db";
import { resetMockOnline, resetMockOrders, resetMockPayments } from "@/lib/db/mock";
import { resetMockStoredValue } from "@/lib/giftcards/store-mock";
import { takePayment } from "@/lib/payments/service";

const auth = vi.hoisted(() => ({ role: "cashier" as string | null }));
vi.mock("@/lib/auth/tenant-guard", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth/tenant-guard")>()),
  requireTenantAccess: async (tenantId: string | null, _roles: unknown, opts?: { locationId?: string | null }) => ({
    ok: true,
    user: { id: "00000000-0000-4000-8000-0000000000aa", email: "staff@example.com", memberships: [] },
    tenantId,
    locationId: opts?.locationId ?? null,
    role: "owner",
  }),
}));
vi.mock("@/lib/auth/active-staff", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth/active-staff")>()),
  effectiveTerminalRole: async () => ({ role: auth.role, staff: null }),
}));

import { POST as salePOST } from "./sales/route";
import { POST as balancePOST } from "./balance/route";
import { POST as redeemPOST } from "./redeem/route";
import { POST as voidPOST } from "./[id]/void/route";
import { POST as creditPOST } from "./store-credit/route";
import { POST as shopBalancePOST } from "@/app/api/shop/gift-cards/balance/route";
import { POST as shopRedeemPOST } from "@/app/api/shop/gift-cards/redeem/route";
import { POST as shopBuyPOST } from "@/app/api/shop/gift-cards/route";

const TENANT = DEMO_TENANT_ID;
const LOCATION = DEMO_LOCATION_DOWNTOWN_ID;

function req(body: unknown): Request {
  return new Request("https://pos.test/api", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function line(cents: number): OrderItem {
  return {
    id: randomUUID(),
    item_id: "30000000-0000-0000-0000-000000000001",
    item_name: "Margherita",
    size_id: "s1",
    size_name: "L",
    base_price_cents: cents,
    quantity: 1,
    modifiers: [],
    notes: null,
    voided: false,
    unit_price_cents: cents,
    line_total_cents: cents,
  };
}

async function order(total: number, online = false) {
  return getPosDriver().createOrder({
    id: randomUUID(),
    tenant_id: TENANT,
    location_id: LOCATION,
    channel: online ? "online_pickup" : "in_store",
    currency: "USD",
    items: [line(total)],
    discount_cents: 0,
    totals: { subtotal_cents: total, discount_cents: 0, taxable_cents: total, tax_cents: 0, tip_cents: 0, total_cents: total },
    notes: null,
    status: online ? "awaiting_payment" : "placed",
    ...(online
      ? { fulfillment: { type: "pickup" as const, scheduled_for: new Date().toISOString(), promised_at: new Date().toISOString() } }
      : {}),
  });
}

async function sellAndPay(amountCents: number) {
  const res = await salePOST(req({ tenantId: TENANT, locationId: LOCATION, orderId: randomUUID(), amountCents }));
  expect(res.status).toBe(201);
  const sale = (await res.json()) as { order: { id: string }; code: string; account: { id: string } };
  await takePayment({
    paymentId: randomUUID(),
    orderId: sale.order.id,
    tenantId: TENANT,
    locationId: LOCATION,
    rail: "cash",
    amountCents,
    tipCents: 0,
    currency: "USD",
  });
  return sale;
}

beforeEach(() => {
  auth.role = "cashier";
  resetMockOrders();
  resetMockPayments();
  resetMockOnline();
  resetMockStoredValue();
});

describe("till routes", () => {
  it("sell -> pay -> check balance -> redeem", async () => {
    const sale = await sellAndPay(3000);
    const bal = await balancePOST(req({ tenantId: TENANT, code: sale.code }));
    expect(await bal.json()).toMatchObject({ account: { status: "active", balance_cents: 3000 } });
    expect(JSON.stringify(await (await balancePOST(req({ tenantId: TENANT, code: sale.code }))).json())).not.toContain(sale.code);

    const food = await order(2000);
    const pid = randomUUID();
    const r = await redeemPOST(req({ orderId: food.id, code: sale.code, paymentId: pid }));
    expect(r.status).toBe(201);
    expect(await r.json()).toMatchObject({
      payment: { id: pid, rail: "gift_card", amount_cents: 2000, raw: { code_last4: sale.code.slice(-4) } },
      account: { balance_cents: 1000 },
      balanceCents: 0,
      orderStatus: "paid",
    });
    const again = await redeemPOST(req({ orderId: food.id, code: sale.code, paymentId: pid }));
    expect(again.status).toBe(200);
  });

  it("answers an unknown code with a uniform 404", async () => {
    const res = await balancePOST(req({ tenantId: TENANT, code: "ZZZZ-ZZZZ-ZZZZ-ZZZZ" }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "That code was not found.", code: "not_found" });
  });

  it("only an owner/manager can void; store credit above the threshold needs one", async () => {
    const sale = await sellAndPay(2000);
    const v = () => voidPOST(req({ tenantId: TENANT, reason: "mistake" }), { params: Promise.resolve({ id: sale.account.id }) });
    expect((await v()).status).toBe(403);
    auth.role = "manager";
    const ok = await v();
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ account: { status: "voided" }, refunds: [{ refundedCents: 2000 }] });

    auth.role = "cashier";
    const big = await creditPOST(req({ tenantId: TENANT, locationId: LOCATION, accountId: randomUUID(), amountCents: 3000, reason: "late" }));
    expect(big.status).toBe(403);
    expect((await big.json()).code).toBe("approval_required");
    const noReason = await creditPOST(req({ tenantId: TENANT, accountId: randomUUID(), amountCents: 300 }));
    expect(noReason.status).toBe(422);
    const small = await creditPOST(req({ tenantId: TENANT, locationId: LOCATION, accountId: randomUUID(), amountCents: 1000, reason: "late" }));
    expect(small.status).toBe(201);
    expect((await small.json()).code).toMatch(/^.{4}-.{4}-.{4}-.{4}$/);
  });

  it("refuses online orders at the till redeem route", async () => {
    const sale = await sellAndPay(2000);
    const online = await order(1000, true);
    const res = await redeemPOST(req({ orderId: online.id, code: sale.code, paymentId: randomUUID() }));
    expect(res.status).toBe(422);
  });
});

describe("storefront routes", () => {
  it("buy online (anonymous, device cookie, pending hidden), then apply the card to a checkout", async () => {
    const loc = (await getPosDriver().listLocations(TENANT)).find((l) => l.id === LOCATION)!;
    const tenant = (await getPosDriver().getTenant(TENANT))!;
    const buy = await shopBuyPOST(
      req({ orderId: randomUUID(), tenantSlug: tenant.slug, locationSlug: loc.slug, amountCents: 1500, email: "buyer@example.com" }),
    );
    expect(buy.status).toBe(201);
    const bought = (await buy.json()) as { order: { id: string; status: string; totals: { tax_cents: number } }; code: string };
    expect(bought.order.status).toBe("awaiting_payment");
    expect(bought.order.totals.tax_cents).toBe(0);

    // Unpaid: the storefront cannot see or use it.
    const pending = await shopBalancePOST(req({ tenantSlug: tenant.slug, locationSlug: loc.slug, code: bought.code }));
    expect(pending.status).toBe(404);
    expect(pending.headers.get("set-cookie")).toContain("gc_device=");

    await takePayment({
      paymentId: randomUUID(),
      orderId: bought.order.id,
      tenantId: TENANT,
      locationId: LOCATION,
      rail: "cash",
      amountCents: 1500,
      tipCents: 0,
      currency: "USD",
    });
    const bal = await shopBalancePOST(req({ tenantSlug: tenant.slug, locationSlug: loc.slug, code: bought.code }));
    expect(await bal.json()).toMatchObject({ balanceCents: 1500, kind: "gift_card", status: "active" });

    const checkout = await order(4000, true);
    const applied = await shopRedeemPOST(req({ orderId: checkout.id, code: bought.code }));
    expect(applied.status).toBe(200);
    expect(await applied.json()).toMatchObject({
      payment: { amount_cents: 1500, rail: "gift_card" },
      balanceCents: 2500,
      orderStatus: "awaiting_payment",
    });
    // Applying the same card again is the same tender (nothing more taken).
    const again = await shopRedeemPOST(req({ orderId: checkout.id, code: bought.code }));
    expect((await again.json()).payment.amount_cents).toBe(1500);
    expect((await getPosDriver().listPaymentsForOrder(checkout.id)).length).toBe(1);
  });
});
