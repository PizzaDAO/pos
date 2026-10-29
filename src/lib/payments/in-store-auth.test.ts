import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextResponse } from "next/server";
import {
  getPosDriver,
  type CreateOrderInput,
  type OrderChannel,
} from "@/lib/db";
import { resetMockOrders, resetMockPayments } from "@/lib/db/mock";

const requireTenantMember = vi.fn();
const requireTenantRole = vi.fn();
vi.mock("@/lib/auth/api", () => ({
  requireTenantMember: (...a: unknown[]) => requireTenantMember(...a),
  requireTenantRole: (...a: unknown[]) => requireTenantRole(...a),
}));

import { POST as paymentsPOST } from "@/app/api/payments/route";

const TENANT = "10000000-0000-0000-0000-000000000001";
const LOCATION = "10000000-0000-0000-0000-000000000101";
const ROLES = ["owner", "manager", "cashier"];

let seq = 0;

async function seedOrder(channel: OrderChannel): Promise<string> {
  seq += 1;
  const id = `instore-auth-${seq}`;
  const input: CreateOrderInput = {
    id,
    tenant_id: TENANT,
    location_id: LOCATION,
    channel,
    currency: "USD",
    items: [
      {
        id: "l1",
        item_id: "i1",
        item_name: "Pizza",
        size_id: null,
        size_name: null,
        base_price_cents: 1000,
        quantity: 1,
        modifiers: [],
        notes: null,
        voided: false,
        unit_price_cents: 1000,
        line_total_cents: 1000,
      },
    ],
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
    status: "placed",
  };
  await getPosDriver().createOrder(input);
  return id;
}

/** Mimic requireTenantRole: pass only when the session role is allowed. */
function sessionRole(role: string | null) {
  requireTenantRole.mockImplementation(async (_t: string, roles: string[]) => {
    if (!role) {
      return {
        ok: false,
        res: NextResponse.json({ error: "Not signed in." }, { status: 401 }),
      };
    }
    if (!roles.includes(role)) {
      return {
        ok: false,
        res: NextResponse.json({ error: "Not authorized." }, { status: 403 }),
      };
    }
    return { ok: true, user: { id: "u1", email: "s@x" } };
  });
}

function payReq(orderId: string, body: Record<string, unknown>) {
  return new Request("http://localhost/api/payments", {
    method: "POST",
    headers: { "x-forwarded-for": "4.4.4.4" },
    body: JSON.stringify({
      orderId,
      tenantId: TENANT,
      locationId: LOCATION,
      currency: "USD",
      amountCents: 1000,
      ...body,
    }),
  });
}

beforeEach(() => {
  resetMockOrders();
  resetMockPayments();
  requireTenantMember.mockReset();
  requireTenantRole.mockReset();
  requireTenantMember.mockResolvedValue({ ok: true, user: { id: "u1", email: "s@x" } });
  vi.stubEnv("STRIPE_SECRET_KEY", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("in_store payments require a till role", () => {
  for (const rail of ["cash", "stripe_terminal", "crypto_onchain_usdc"]) {
    it(`${rail}: anonymous -> 401, kitchen -> 403, nothing recorded`, async () => {
      const orderId = await seedOrder("in_store");
      const paymentId = `is-${rail}`;
      sessionRole(null);
      expect((await paymentsPOST(payReq(orderId, { paymentId, rail }))).status).toBe(401);
      sessionRole("kitchen");
      expect((await paymentsPOST(payReq(orderId, { paymentId, rail }))).status).toBe(403);
      expect(requireTenantRole).toHaveBeenLastCalledWith(TENANT, ROLES);
      expect(await getPosDriver().getPayment(paymentId)).toBeNull();
    });
  }

  it("a cashier can take a tender", async () => {
    const orderId = await seedOrder("in_store");
    sessionRole("cashier");
    const res = await paymentsPOST(
      payReq(orderId, { paymentId: "is-ok", rail: "cash" }),
    );
    expect(res.status).toBe(201);
    expect((await res.json()).orderStatus).toBe("paid");
  });

  it("the shop flow (online card) stays anonymous", async () => {
    const orderId = await seedOrder("online_pickup");
    sessionRole(null);
    const res = await paymentsPOST(
      payReq(orderId, { paymentId: "shop-anon", rail: "stripe_online" }),
    );
    expect(res.status).toBe(201);
    expect(requireTenantRole).not.toHaveBeenCalled();
  });
});
