import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "@/lib/auth/session";

/**
 * Review follow-ups: ambiguous refunds stay pending, refunds need a settled
 * tender, stuck tenders can be voided (role-gated), provider status updates
 * never resurrect refunded tenders, and money-sensitive actions are gated on
 * the ACTIVE (PIN-switched) staff member in real mode.
 */
const session = vi.hoisted(() => ({ user: null as SessionUser | null }));
vi.mock("@/lib/auth/session", () => ({
  getCurrentUser: vi.fn(async () => session.user),
}));
// No request scope in tests: the sign-out route's Supabase client is stubbed.
vi.mock("@/lib/auth/supabase-server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/supabase-server")>()),
  getServerSupabase: async () => null,
}));

import {
  DEMO_LOCATION_DOWNTOWN_ID,
  DEMO_TENANT_ID,
  getPosDriver,
} from "@/lib/db";
import { requirePaymentRail } from "./registry";
import {
  PaymentOutcomeUnknownError,
  RefundRejectedError,
  refundPayment,
  takePayment,
} from "./service";
import { POST as voidPOST } from "@/app/api/payments/void/route";
import { POST as refundPOST } from "@/app/api/payments/refund/route";
import { POST as ordersPOST } from "@/app/api/orders/route";
import {
  ACTIVE_STAFF_COOKIE,
  openStaffSession,
} from "@/lib/auth/active-staff";

// Seed staff (Tony = owner, Christopher = cashier) — resolved by name below.
async function staffByRole(role: "owner" | "cashier") {
  const list = await getPosDriver().listStaff(DEMO_TENANT_ID);
  const s = list.find((x) => x.role === role && x.active);
  if (!s) throw new Error(`no seed ${role}`);
  return s;
}

function deviceOwner(): SessionUser {
  return {
    id: "device-owner",
    email: "device@example.com",
    memberships: [
      {
        id: "m1",
        user_id: "device-owner",
        tenant_id: DEMO_TENANT_ID,
        role: "owner",
        created_at: "2025-01-01T00:00:00.000Z",
      },
    ],
    isPlatformAdmin: false,
    real: true,
  };
}

/** A real server-side staff session for the mocked device login. */
async function staffCookieValue(staffId: string, userId = "device-owner") {
  const v = await openStaffSession({
    userId,
    tenantId: DEMO_TENANT_ID,
    staffId,
  });
  if (!v) throw new Error("no signing secret");
  return v;
}

let seq = 0;
const uid = (p: string) => `${p}-${Date.now().toString(36)}-${(seq += 1)}`;

async function seedOrder(total: number): Promise<string> {
  const id = crypto.randomUUID();
  await getPosDriver().createOrder({
    id,
    tenant_id: DEMO_TENANT_ID,
    location_id: DEMO_LOCATION_DOWNTOWN_ID,
    channel: "in_store",
    currency: "USD",
    items: [],
    discount_cents: 0,
    totals: {
      subtotal_cents: total,
      discount_cents: 0,
      taxable_cents: total,
      tax_cents: 0,
      tip_cents: 0,
      total_cents: total,
    },
    notes: null,
  });
  return id;
}

const tender = (orderId: string, paymentId: string, amountCents: number) => ({
  paymentId,
  orderId,
  tenantId: DEMO_TENANT_ID,
  locationId: DEMO_LOCATION_DOWNTOWN_ID,
  rail: "stripe_terminal" as const,
  amountCents,
  tipCents: 0,
  currency: "USD",
});

const post = (body: unknown, cookie?: string) =>
  new Request("http://localhost/x", {
    method: "POST",
    headers: cookie ? { cookie } : {},
    body: JSON.stringify(body),
  });

function realMode() {
  getPosDriver(); // keep the mock driver cached
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
  process.env.ONBOARDING_TOKEN_SECRET = "test-secret";
}

beforeEach(() => {
  session.user = deviceOwner();
});
afterEach(() => {
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  delete process.env.ONBOARDING_TOKEN_SECRET;
  vi.restoreAllMocks();
});

describe("refunds", () => {
  it("an ambiguous refund stays pending and a retry with the SAME id settles it once", async () => {
    const orderId = await seedOrder(1000);
    const paymentId = uid("p");
    await takePayment(tender(orderId, paymentId, 1000));
    const rail = requirePaymentRail("stripe_terminal");
    const spy = vi
      .spyOn(rail, "refund")
      .mockRejectedValueOnce(new TypeError("socket hang up"));
    const refundId = crypto.randomUUID();
    await expect(
      refundPayment({ paymentId, refundId, amountCents: 300 }),
    ).rejects.toBeInstanceOf(PaymentOutcomeUnknownError);
    expect((await getPosDriver().getRefund(refundId))?.status).toBe("pending");
    // The pending amount stays reserved: no over-refund via another id.
    await expect(
      refundPayment({ paymentId, refundId: crypto.randomUUID(), amountCents: 800 }),
    ).rejects.toBeInstanceOf(RefundRejectedError);
    const settled = await refundPayment({ paymentId, refundId, amountCents: 300 });
    expect(settled?.refunded_cents).toBe(300);
    const keys = new Set(spy.mock.calls.map((c) => c[0].context.idempotencyKey));
    expect(keys.size).toBe(1);
  });

  it("refuses to refund a tender that never settled", async () => {
    const orderId = await seedOrder(500);
    const paymentId = uid("unsettled");
    const rail = requirePaymentRail("stripe_terminal");
    vi.spyOn(rail, "createCharge").mockRejectedValueOnce(new TypeError("timeout"));
    await expect(takePayment(tender(orderId, paymentId, 500))).rejects.toBeInstanceOf(
      PaymentOutcomeUnknownError,
    );
    await expect(
      refundPayment({ paymentId, refundId: crypto.randomUUID(), amountCents: 100 }),
    ).rejects.toThrow(/settled/);
  });
});

describe("void tender", () => {
  it("cancels a stuck pending tender and frees the balance; refuses settled ones", async () => {
    const orderId = await seedOrder(700);
    const stuck = uid("stuck");
    const rail = requirePaymentRail("cash");
    vi.spyOn(rail, "createCharge").mockRejectedValueOnce(new TypeError("crash"));
    await expect(
      takePayment({ ...tender(orderId, stuck, 700), rail: "cash" }),
    ).rejects.toBeInstanceOf(PaymentOutcomeUnknownError);

    const res = await voidPOST(post({ paymentId: stuck }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { balanceCents: number; payment: { status: string } };
    expect(body.payment.status).toBe("canceled");
    expect(body.balanceCents).toBe(700);

    const paid = uid("paid");
    await takePayment({ ...tender(orderId, paid, 700), rail: "cash" });
    expect((await voidPOST(post({ paymentId: paid }))).status).toBe(409);
  });

  it("is tenant-guarded and gated on the active staff role in real mode", async () => {
    const orderId = await seedOrder(400);
    const stuck = uid("stuck2");
    const rail = requirePaymentRail("cash");
    vi.spyOn(rail, "createCharge").mockRejectedValueOnce(new TypeError("crash"));
    await expect(
      takePayment({ ...tender(orderId, stuck, 400), rail: "cash" }),
    ).rejects.toBeInstanceOf(PaymentOutcomeUnknownError);

    session.user = null;
    expect((await voidPOST(post({ paymentId: stuck }))).status).toBe(401);

    realMode();
    session.user = deviceOwner();
    // Device is logged in as owner, but no staff switched in → refused.
    expect((await voidPOST(post({ paymentId: stuck }))).status).toBe(403);
    // A cashier switched in → refused.
    const cashier = await staffByRole("cashier");
    const cashierCookie = `${ACTIVE_STAFF_COOKIE}=${encodeURIComponent(
      (await staffCookieValue(cashier.id)),
    )}`;
    expect((await voidPOST(post({ paymentId: stuck }, cashierCookie))).status).toBe(403);
    // The owner switched in → allowed.
    const owner = await staffByRole("owner");
    const ownerCookie = `${ACTIVE_STAFF_COOKIE}=${encodeURIComponent(
      (await staffCookieValue(owner.id)),
    )}`;
    expect((await voidPOST(post({ paymentId: stuck }, ownerCookie))).status).toBe(200);
  });
});

describe("active-staff gating (real mode)", () => {
  it("discounts follow the PIN-switched staff role, not the device login", async () => {
    realMode();
    session.user = deviceOwner();
    const order = (cookie?: string) =>
      ordersPOST(
        post(
          {
            id: crypto.randomUUID(),
            tenant_id: DEMO_TENANT_ID,
            location_id: DEMO_LOCATION_DOWNTOWN_ID,
            items: [
              {
                id: "l1",
                item_id: "30000000-0000-0000-0000-000000000010",
                size_id: "40000000-0000-0000-0000-000000000021",
                quantity: 1,
                modifiers: [],
              },
            ],
            discount_cents: 100,
          },
          cookie,
        ),
      );
    const cashier = await staffByRole("cashier");
    const owner = await staffByRole("owner");
    const cookieFor = async (id: string, userId?: string) =>
      `${ACTIVE_STAFF_COOKIE}=${encodeURIComponent(await staffCookieValue(id, userId))}`;

    expect((await order()).status).toBe(403); // no active staff
    expect((await order(await cookieFor(cashier.id))).status).toBe(403);
    const ownerCookie = await cookieFor(owner.id);
    expect((await order(ownerCookie)).status).toBe(201);
    // A forged cookie is ignored.
    expect(
      (await order(`${ACTIVE_STAFF_COOKIE}=${DEMO_TENANT_ID}.${owner.id}.u.s.9999999999999.00`)).status,
    ).toBe(403);
    // A cookie opened by ANOTHER device login is useless here.
    expect(
      (await order(await cookieFor(owner.id, "some-other-device-user"))).status,
    ).toBe(403);
    // Switch-out revokes it server-side: the same (copied) cookie dies.
    const { DELETE: pinDELETE } = await import("@/app/api/terminal/pin/route");
    await pinDELETE(post({}, ownerCookie));
    expect((await order(ownerCookie)).status).toBe(403);
    // Sign-out revokes every session of the device login.
    const again = await cookieFor(owner.id);
    expect((await order(again)).status).toBe(201);
    const { POST: signoutPOST } = await import("@/app/auth/signout/route");
    await signoutPOST(new Request("http://localhost/auth/signout", { method: "POST" }));
    expect((await order(again)).status).toBe(403);
  });

  it("refunds need an active staff member who may refund", async () => {
    const orderId = await seedOrder(900);
    const paymentId = crypto.randomUUID();
    await takePayment({ ...tender(orderId, paymentId, 900), rail: "cash" });
    realMode();
    session.user = deviceOwner();
    const r = (cookie?: string) =>
      refundPOST(post({ paymentId, refundId: crypto.randomUUID(), amountCents: 100 }, cookie));
    expect((await r()).status).toBe(403);
    const cashier = await staffByRole("cashier");
    const cookie = `${ACTIVE_STAFF_COOKIE}=${encodeURIComponent(
      (await staffCookieValue(cashier.id)),
    )}`;
    expect((await r(cookie)).status).toBe(200);
  });
});

describe("provider status updates", () => {
  it("never move a refunded / partially refunded tender back", async () => {
    const orderId = await seedOrder(1000);
    const paymentId = uid("pp");
    await takePayment(tender(orderId, paymentId, 1000));
    await refundPayment({ paymentId, refundId: crypto.randomUUID(), amountCents: 200 });
    const after = await getPosDriver().updatePaymentStatusFromProvider(
      paymentId,
      "authorized",
    );
    expect(after?.status).toBe("captured");
    expect(after?.refunded_cents).toBe(200);
  });
});
