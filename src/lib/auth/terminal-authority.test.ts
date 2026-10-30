import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "./session";

/**
 * REAL mode: who may discount / refund at a shared terminal.
 *   - Tenant uses PINs → the PIN-switched staff member's role decides; the
 *     device login alone is not enough.
 *   - Tenant never set up PINs → the device login's role decides (owners keep
 *     discounts without a PIN step).
 *   - An offline-queued order may name the staff session it was queued under;
 *     honoured only while that session is still live for this device login.
 */
const session = vi.hoisted(() => ({ user: null as SessionUser | null }));
vi.mock("./session", () => ({
  getCurrentUser: vi.fn(async () => session.user),
}));
// Real auth configured (mock driver) → isRealMode() is true.
vi.mock("./supabase-server", () => ({
  isSupabaseAuthConfigured: () => true,
  getServerSupabase: vi.fn(async () => null),
}));

import {
  DEMO_LOCATION_DOWNTOWN_ID,
  DEMO_TENANT_ID,
  getPosDriver,
  type MembershipRole,
  type Payment,
} from "@/lib/db";
import { POST as ordersPOST } from "@/app/api/orders/route";
import { POST as refundPOST } from "@/app/api/payments/refund/route";
import {
  DELETE as pinDELETE,
  POST as pinPOST,
} from "@/app/api/terminal/pin/route";
import { effectiveTerminalRole, requiresPinStaff } from "./active-staff";

const TONY = "80000000-0000-0000-0000-000000000001"; // owner, 1111
const CARMELA = "80000000-0000-0000-0000-000000000002"; // manager, 2222
const CHRIS = "80000000-0000-0000-0000-000000000003"; // cashier, 3333
const MARGHERITA = "30000000-0000-0000-0000-000000000001";
const MARGHERITA_SMALL = "40000000-0000-0000-0000-000000000001";

function device(role: MembershipRole, tenantId = DEMO_TENANT_ID): SessionUser {
  return {
    id: `device-${role}`,
    email: `${role}@device.example`,
    memberships: [
      {
        id: `m-${role}`,
        user_id: `device-${role}`,
        tenant_id: tenantId,
        role,
        created_at: "2025-01-01T00:00:00.000Z",
      },
    ],
    isPlatformAdmin: false,
    real: true,
  };
}

beforeAll(() => {
  process.env.ONBOARDING_TOKEN_SECRET = "terminal-authority-test-secret";
});
afterAll(() => {
  delete process.env.ONBOARDING_TOKEN_SECRET;
});
beforeEach(() => {
  session.user = device("owner");
});

/** PIN-switch in; returns the cookie header + the session id. */
async function switchIn(
  staffId: string,
  pin: string,
  opts: { cookie?: string; previousSessionId?: string } = {},
) {
  const res = await pinPOST(
    new Request("http://localhost/api/terminal/pin", {
      method: "POST",
      headers: opts.cookie ? { cookie: opts.cookie } : {},
      body: JSON.stringify({
        staffId,
        pin,
        ...(opts.previousSessionId
          ? { previousSessionId: opts.previousSessionId }
          : {}),
      }),
    }),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { activeStaff: { session_id: string } };
  const setCookie = res.headers.get("set-cookie") ?? "";
  const cookie = setCookie.split(";")[0]!;
  return { cookie, sessionId: body.activeStaff.session_id };
}

let seq = 0;
function order(opts: {
  discount: number;
  cookie?: string;
  queuedSession?: string;
  staffId?: string;
}) {
  seq += 1;
  return ordersPOST(
    new Request("http://localhost/api/orders", {
      method: "POST",
      headers: opts.cookie ? { cookie: opts.cookie } : {},
      body: JSON.stringify({
        id: `authority-order-${Date.now()}-${seq}`,
        tenant_id: DEMO_TENANT_ID,
        location_id: DEMO_LOCATION_DOWNTOWN_ID,
        items: [
          {
            id: "l1",
            item_id: MARGHERITA,
            item_name: "x",
            size_id: MARGHERITA_SMALL,
            size_name: "x",
            base_price_cents: 0,
            quantity: 1,
            modifiers: [],
            notes: null,
            voided: false,
            unit_price_cents: 0,
            line_total_cents: 0,
          },
        ],
        discount_cents: opts.discount,
        ...(opts.staffId ? { staff_id: opts.staffId } : {}),
        ...(opts.queuedSession
          ? { queued_staff_session_id: opts.queuedSession }
          : {}),
      }),
    }),
  );
}

describe("discounts: PIN tenant", () => {
  it("the demo tenant uses PINs", async () => {
    expect(await requiresPinStaff(DEMO_TENANT_ID)).toBe(true);
  });

  it("an owner device login alone cannot discount; a PIN-switched manager can", async () => {
    const denied = await order({ discount: 100 });
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as { code?: string }).code).toBe("discount_forbidden");
    // No discount: fine without a PIN.
    expect((await order({ discount: 0 })).status).toBe(201);

    const { cookie } = await switchIn(CARMELA, "2222");
    expect((await order({ discount: 100, cookie })).status).toBe(201);
    await pinDELETE(new Request("http://localhost/api/terminal/pin", { method: "DELETE", headers: { cookie } }));
  });

  it("a PIN-switched cashier cannot discount even on an owner device", async () => {
    const { cookie } = await switchIn(CHRIS, "3333");
    expect((await order({ discount: 100, cookie })).status).toBe(403);
    await pinDELETE(new Request("http://localhost/api/terminal/pin", { method: "DELETE", headers: { cookie } }));
  });

  it("a queued order's staff session counts only while it is still live", async () => {
    const { cookie, sessionId } = await switchIn(TONY, "1111");
    const queued = { discount: 100, queuedSession: sessionId, staffId: TONY };
    // Cookie lost (terminal restarted) but the session is live → honoured.
    expect((await order(queued)).status).toBe(201);
    // Another device login can't use it.
    session.user = { ...device("owner"), id: "someone-else" };
    session.user.memberships[0]!.user_id = "someone-else";
    expect((await order(queued)).status).toBe(403);
    session.user = device("owner");
    // Switched out → revoked → refused (the queue asks staff to resolve it).
    await pinDELETE(new Request("http://localhost/api/terminal/pin", { method: "DELETE", headers: { cookie } }));
    expect((await order(queued)).status).toBe(403);
    // Garbage session ids are just ignored.
    expect((await order({ ...queued, queuedSession: "nope" })).status).toBe(403);
  });

  it("a queued session is honoured only for the staff member the order names", async () => {
    const { cookie, sessionId } = await switchIn(TONY, "1111");
    // Tony's live session attached to an order attributed to Chris → refused.
    expect(
      (await order({ discount: 100, queuedSession: sessionId, staffId: CHRIS })).status,
    ).toBe(403);
    // ...or to an order naming no staff at all.
    expect((await order({ discount: 100, queuedSession: sessionId })).status).toBe(403);
    // Matching staff_id → honoured.
    expect(
      (await order({ discount: 100, queuedSession: sessionId, staffId: TONY })).status,
    ).toBe(201);
    await pinDELETE(new Request("http://localhost/api/terminal/pin", { method: "DELETE", headers: { cookie } }));
  });

  it("a PIN switch-in revokes the client's last known session even without its cookie", async () => {
    const tony = await switchIn(TONY, "1111");
    const queued = { discount: 100, queuedSession: tony.sessionId, staffId: TONY };
    expect((await order(queued)).status).toBe(201);
    // Cookie lost; Chris switches in naming Tony's session → Tony's is revoked.
    const chris = await switchIn(CHRIS, "3333", { previousSessionId: tony.sessionId });
    expect((await getPosDriver().getStaffSession(tony.sessionId))?.revoked_at).toBeTruthy();
    expect((await order(queued)).status).toBe(403);
    // A switch-in with a cookie revokes the cookie's session as before.
    const carmela = await switchIn(CARMELA, "2222", { cookie: chris.cookie });
    expect((await getPosDriver().getStaffSession(chris.sessionId))?.revoked_at).toBeTruthy();
    await pinDELETE(new Request("http://localhost/api/terminal/pin", { method: "DELETE", headers: { cookie: carmela.cookie } }));
  });

  it("a switch-in cannot revoke another device login's session", async () => {
    const carmela = await switchIn(CARMELA, "2222");
    session.user = { ...device("owner"), id: "someone-else" };
    session.user.memberships[0]!.user_id = "someone-else";
    await switchIn(CHRIS, "3333", { previousSessionId: carmela.sessionId });
    session.user = device("owner");
    expect((await getPosDriver().getStaffSession(carmela.sessionId))?.revoked_at).toBeFalsy();
    expect(
      (await order({ discount: 100, queuedSession: carmela.sessionId, staffId: CARMELA })).status,
    ).toBe(201);
    await pinDELETE(new Request("http://localhost/api/terminal/pin", { method: "DELETE", headers: { cookie: carmela.cookie } }));
  });
});

describe("discounts/refunds: tenant without PINs", () => {
  it("falls back to the device login's role", async () => {
    const driver = getPosDriver();
    const { tenant } = await driver.createTenant({
      businessName: `No PIN Pizza ${Date.now()}`,
      ownerEmail: "nopin@example.com",
    });
    expect(await requiresPinStaff(tenant.id)).toBe(false);
    const req = new Request("http://localhost/x");
    const owner = await effectiveTerminalRole(req, {
      tenantId: tenant.id,
      role: "owner",
      user: { id: "u-owner" },
    });
    expect(owner.role).toBe("owner");
    const cashier = await effectiveTerminalRole(req, {
      tenantId: tenant.id,
      role: "cashier",
      user: { id: "u-cashier" },
    });
    expect(cashier.role).toBe("cashier");
    // With PINs in use the device role no longer counts.
    const pinTenant = await effectiveTerminalRole(req, {
      tenantId: DEMO_TENANT_ID,
      role: "owner",
      user: { id: "u-owner" },
    });
    expect(pinTenant.role).toBeNull();
  });
});

describe("refunds: PIN tenant", () => {
  const PAYMENT = "33333333-3333-4333-8333-333333333333";

  async function seedCashTender(): Promise<Payment> {
    const driver = getPosDriver();
    const orderId = `authority-refund-${Date.now()}`;
    await driver.createOrder({
      id: orderId,
      tenant_id: DEMO_TENANT_ID,
      location_id: DEMO_LOCATION_DOWNTOWN_ID,
      channel: "in_store",
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
      status: "paid",
    });
    const now = new Date().toISOString();
    return driver.upsertPayment({
      id: PAYMENT,
      order_id: orderId,
      tenant_id: DEMO_TENANT_ID,
      location_id: DEMO_LOCATION_DOWNTOWN_ID,
      rail: "cash",
      status: "captured",
      amount_cents: 1000,
      tip_cents: 0,
      application_fee_cents: 0,
      currency: "USD",
      charge_id: null,
      connect_account_id: null,
      crypto_tx_hash: null,
      crypto_chain: null,
      cash_tendered_cents: 1000,
      cash_change_cents: 0,
      refunded_cents: 0,
      simulated: true,
      raw: null,
      created_at: now,
      updated_at: now,
    });
  }

  const refund = (cookie?: string) =>
    refundPOST(
      new Request("http://localhost/api/payments/refund", {
        method: "POST",
        headers: cookie ? { cookie } : {},
        body: JSON.stringify({ paymentId: PAYMENT, amountCents: 100 }),
      }),
    );

  it("needs a PIN-switched owner|manager; the owner device login alone is refused", async () => {
    await seedCashTender();
    expect((await refund()).status).toBe(403);
    const chris = await switchIn(CHRIS, "3333");
    expect((await refund(chris.cookie)).status).toBe(403);
    const carmela = await switchIn(CARMELA, "2222");
    expect((await refund(carmela.cookie)).status).toBe(200);
    await pinDELETE(
      new Request("http://localhost/api/terminal/pin", {
        method: "DELETE",
        headers: { cookie: carmela.cookie },
      }),
    );
  });

  it("a cashier device login is refused before any staff check", async () => {
    session.user = device("cashier");
    expect((await refund()).status).toBe(403);
  });
});
