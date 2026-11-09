/**
 * POST /api/admin/refunds/resolve: owner / manager behind the back-office gate,
 * input validated, the outcome audited. (The lookup itself is covered in
 * src/lib/adjustments/service.test.ts.)
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import {
  DEMO_LOCATION_DOWNTOWN_ID as LOCATION,
  DEMO_TENANT_ID as TENANT,
  getPosDriver,
  type Payment,
} from "@/lib/db";
import { resetMockOrders, resetMockPayments } from "@/lib/db/mock";

const stripeGet = vi.fn();
vi.mock("@/lib/payments/providers/stripe-client", async (orig) => ({
  ...(await orig<typeof import("@/lib/payments/providers/stripe-client")>()),
  stripeGet: (...a: unknown[]) => stripeGet(...a),
}));

const gate = vi.hoisted(() => ({ role: "manager" as string | null, ok: true }));
vi.mock("@/lib/auth/admin-gate", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth/admin-gate")>()),
  requireAdminAccess: async (_req: Request, tenantId: string | null) => {
    if (!gate.ok) {
      const { NextResponse } = await import("next/server");
      return { ok: false, res: NextResponse.json({ error: "admin_pin_required" }, { status: 401 }) };
    }
    return {
      ok: true,
      tenantId,
      locationId: null,
      role: "owner",
      user: { id: "device-1", email: "till@example.com", memberships: [] },
      actor: { role: gate.role, staff: null, gated: true, expiresAt: null },
    };
  },
}));

const recordAudit = vi.fn();
vi.mock("@/lib/security", async (orig) => ({
  ...(await orig<typeof import("@/lib/security")>()),
  recordAudit: (...a: unknown[]) => recordAudit(...a),
}));

import { POST } from "./route";

function post(body: Record<string, unknown>) {
  return POST(
    new Request("http://localhost/api/admin/refunds/resolve", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": `10.8.0.${Math.floor(Math.random() * 250)}` },
      body: JSON.stringify(body),
    }),
  );
}

async function stuckCardRefund(): Promise<{ payment: Payment; refundId: string }> {
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_resolve");
  const driver = getPosDriver();
  const order = await driver.createOrder({
    id: randomUUID(),
    tenant_id: TENANT,
    location_id: LOCATION,
    channel: "in_store",
    currency: "USD",
    items: [],
    discount_cents: 0,
    totals: { subtotal_cents: 1000, discount_cents: 0, taxable_cents: 1000, tax_cents: 0, tip_cents: 0, total_cents: 1000 },
    notes: null,
    status: "paid",
  });
  const at = new Date(Date.now() - 60 * 60_000).toISOString();
  const payment = await driver.upsertPayment({
    id: randomUUID(), order_id: order.id, tenant_id: TENANT, location_id: LOCATION, rail: "stripe_terminal",
    status: "captured", amount_cents: 1000, tip_cents: 0, application_fee_cents: 0, currency: "USD",
    charge_id: "pi_route", connect_account_id: "acct_route", crypto_tx_hash: null, crypto_chain: null,
    cash_tendered_cents: null, cash_change_cents: null, refunded_cents: 0, simulated: false, raw: null,
    created_at: at, updated_at: at,
  });
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(at));
  try {
    await driver.reservePaymentRefund(payment.id, 400, "legacy-route-refund-1", { reason: null, pending: true });
  } finally {
    vi.useRealTimers();
  }
  return { payment, refundId: "legacy-route-refund-1" };
}

beforeEach(() => {
  resetMockOrders();
  resetMockPayments();
  stripeGet.mockReset();
  recordAudit.mockReset();
  gate.role = "manager";
  gate.ok = true;
  vi.unstubAllEnvs();
});

describe("POST /api/admin/refunds/resolve", () => {
  it("is refused without the back-office unlock, and for a cashier", async () => {
    gate.ok = false;
    expect((await post({ tenantId: TENANT, paymentId: randomUUID(), refundId: "abcdefgh" })).status).toBe(401);
    gate.ok = true;
    gate.role = "cashier";
    expect((await post({ tenantId: TENANT, paymentId: randomUUID(), refundId: "abcdefgh" })).status).toBe(403);
  });

  it("validates its input", async () => {
    expect((await post({ tenantId: TENANT, paymentId: "nope", refundId: "abcdefgh" })).status).toBe(422);
    expect(
      (await post({ tenantId: TENANT, paymentId: randomUUID(), refundId: "abcdefgh", stripeRefundId: "pi_123" })).status,
    ).toBe(422);
    expect((await post({ tenantId: TENANT, paymentId: randomUUID(), refundId: "abcdefgh" })).status).toBe(404);
  });

  it("confirms a stuck refund Stripe has, and audits it", async () => {
    const { payment, refundId } = await stuckCardRefund();
    stripeGet.mockResolvedValue({
      data: [{ id: "re_route", status: "succeeded", amount: 400, payment_intent: "pi_route", metadata: { refund_id: refundId } }],
      has_more: false,
    });
    const res = await post({ tenantId: TENANT, paymentId: payment.id, refundId });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ outcome: "confirmed", stripeRefund: { id: "re_route" } });
    expect((await getPosDriver().getPayment(payment.id))!).toMatchObject({ refunded_cents: 400, refund_reserved_cents: 0 });
    expect(recordAudit).toHaveBeenCalledTimes(1);
    expect(recordAudit.mock.calls[0]![0]).toMatchObject({ action: "payment_refund", tenantId: TENANT });
    expect(recordAudit.mock.calls[0]![0].detail).toContain("re_route");
  });

  it("a Stripe outage changes nothing (502)", async () => {
    const { payment, refundId } = await stuckCardRefund();
    stripeGet.mockRejectedValue(new Error("socket hang up"));
    const res = await post({ tenantId: TENANT, paymentId: payment.id, refundId });
    expect(res.status).toBe(502);
    expect((await getPosDriver().getPayment(payment.id))!.refunds![0]!.state).toBe("pending");
    expect(recordAudit).not.toHaveBeenCalled();
  });
});
