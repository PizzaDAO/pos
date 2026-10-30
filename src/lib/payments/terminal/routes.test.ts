import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextResponse } from "next/server";
import {
  getPosDriver,
  type CreateOrderInput,
  type OrderItem,
  type OrderTotals,
} from "@/lib/db";
import {
  DEMO_LOCATION_DOWNTOWN_ID,
  DEMO_LOCATION_UPTOWN_ID,
  DEMO_TENANT_ID,
} from "@/lib/db/seed-data";
import { resetMockOrders, resetMockPayments } from "@/lib/db/mock";

const stripeRequest = vi.fn();
const stripeGet = vi.fn();
vi.mock("@/lib/payments/providers/stripe-client", async (orig) => ({
  ...(await orig<typeof import("@/lib/payments/providers/stripe-client")>()),
  stripeRequest: (...a: unknown[]) => stripeRequest(...a),
  stripeGet: (...a: unknown[]) => stripeGet(...a),
  verifyStripeWebhook: () => true,
}));

const requireTenantRole = vi.fn();
vi.mock("@/lib/auth/api", () => ({
  requireTenantRole: (...a: unknown[]) => requireTenantRole(...a),
  requireTenantMember: (tenantId: string) =>
    requireTenantRole(tenantId, ["owner", "manager", "cashier", "kitchen"]),
}));

import { GET as readersGET } from "@/app/api/terminal/readers/route";
import { POST as resetPOST } from "@/app/api/terminal/readers/[id]/reset/route";
import { POST as startPOST } from "@/app/api/terminal/payments/route";
import { GET as syncGET } from "@/app/api/terminal/payments/[id]/route";
import { POST as retryPOST } from "@/app/api/terminal/payments/[id]/retry/route";
import { POST as cancelPOST } from "@/app/api/terminal/payments/[id]/cancel/route";
import { POST as simulatePOST } from "@/app/api/terminal/payments/[id]/simulate/route";
import { GET as adminGET, PUT as adminPUT } from "@/app/api/admin/terminal/route";
import { POST as adminReaderPOST } from "@/app/api/admin/terminal/readers/route";
import { DELETE as adminReaderDELETE } from "@/app/api/admin/terminal/readers/[id]/route";
import { GET as paymentsGET, POST as paymentsPOST } from "@/app/api/payments/route";
import { POST as webhookPOST } from "@/app/api/payments/stripe/webhook/route";
import { simulatedReaderId } from "./readers";

const TENANT = DEMO_TENANT_ID;
const LOCATION = DEMO_LOCATION_DOWNTOWN_ID;
const SIM_READER = simulatedReaderId(LOCATION);
const ACCT = "acct_real_9";
const uuid = () => crypto.randomUUID();

let seq = 0;
async function seedOrder(total = 2000) {
  seq += 1;
  const id = `route-order-${seq}`;
  const totals: OrderTotals = {
    subtotal_cents: total,
    discount_cents: 0,
    taxable_cents: total,
    tax_cents: 0,
    tip_cents: 0,
    total_cents: total,
  };
  const line: OrderItem = {
    id: "l1",
    item_id: "i1",
    item_name: "Pizza",
    size_id: "s1",
    size_name: "L",
    base_price_cents: total,
    quantity: 1,
    modifiers: [],
    notes: null,
    voided: false,
    unit_price_cents: total,
    line_total_cents: total,
  };
  const input: CreateOrderInput = {
    id,
    tenant_id: TENANT,
    location_id: LOCATION,
    channel: "in_store",
    currency: "USD",
    items: [line],
    discount_cents: 0,
    totals,
    notes: null,
    status: "placed",
  };
  await getPosDriver().createOrder(input);
  return id;
}

/** Mimic requireTenantRole for a session holding `role` in TENANT. */
function sessionRole(role: string | null) {
  requireTenantRole.mockImplementation(async (tenantId: string, roles: string[]) => {
    if (!role) {
      return { ok: false, res: NextResponse.json({ error: "Not signed in." }, { status: 401 }) };
    }
    if (tenantId !== TENANT || !roles.includes(role)) {
      return {
        ok: false,
        res: NextResponse.json({ error: "Not authorized for this tenant." }, { status: 403 }),
      };
    }
    return { ok: true, user: { id: "u1", email: "u@x" } };
  });
}

const json = (body: unknown) => ({ method: "POST", body: JSON.stringify(body) });
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const req = (url: string, init?: RequestInit) => new Request(`http://localhost${url}`, init);

async function startTender(orderId: string, amountCents = 2000, paymentId = uuid()) {
  const res = await startPOST(
    req("/api/terminal/payments", json({ paymentId, orderId, readerId: SIM_READER, amountCents })),
  );
  return { res, body: await res.json(), paymentId };
}

beforeEach(() => {
  resetMockOrders();
  resetMockPayments();
  stripeRequest.mockReset();
  stripeGet.mockReset();
  requireTenantRole.mockReset();
  sessionRole("cashier");
  vi.unstubAllEnvs();
  getPosDriver();
});

afterEach(() => vi.unstubAllEnvs());

describe("POST /api/terminal/payments", () => {
  it("cashier starts a card tender (201, requires_action, balance not reduced); auth is checked against the ORDER's tenant", async () => {
    const orderId = await seedOrder();
    const { res, body } = await startTender(orderId);
    expect(res.status).toBe(201);
    expect(body.payment.status).toBe("requires_action");
    expect(body.balanceCents).toBe(2000);
    expect(body.orderStatus).toBe("placed");
    expect(body.resumed).toBe(false);
    expect(requireTenantRole).toHaveBeenCalledWith(TENANT, ["owner", "manager", "cashier"]);
    // the response never carries rail internals or secrets
    expect(JSON.stringify(body)).not.toContain("client_secret");
    expect(body.payment.raw).toMatchObject({ reader_id: SIM_READER });
  });

  it("kitchen is 403, signed out is 401; nothing is created", async () => {
    const orderId = await seedOrder();
    sessionRole("kitchen");
    expect((await startTender(orderId)).res.status).toBe(403);
    sessionRole(null);
    expect((await startTender(orderId)).res.status).toBe(401);
    expect(await getPosDriver().listPaymentsForOrder(orderId)).toHaveLength(0);
  });

  it("a body naming another tenant/location cannot move the tender (the order decides)", async () => {
    const orderId = await seedOrder();
    const res = await startPOST(
      req(
        "/api/terminal/payments",
        json({
          paymentId: uuid(),
          orderId,
          readerId: SIM_READER,
          amountCents: 2000,
          tenantId: "10000000-0000-0000-0000-0000000000ee",
          locationId: DEMO_LOCATION_UPTOWN_ID,
        }),
      ),
    );
    expect(res.status).toBe(201);
    const [p] = await getPosDriver().listPaymentsForOrder(orderId);
    expect(p!.tenant_id).toBe(TENANT);
    expect(p!.location_id).toBe(LOCATION);
  });

  it("validates the payload and amounts (422), unknown order (404)", async () => {
    const orderId = await seedOrder();
    for (const bad of [
      {},
      { paymentId: "not-a-uuid", orderId, readerId: SIM_READER, amountCents: 100 },
      { paymentId: uuid(), orderId, readerId: SIM_READER, amountCents: -5 },
      { paymentId: uuid(), orderId, readerId: SIM_READER, amountCents: 1.5 },
      { paymentId: uuid(), orderId, readerId: SIM_READER, amountCents: 100, tipCents: "x" },
      { paymentId: uuid(), orderId, amountCents: 100 },
    ]) {
      expect((await startPOST(req("/api/terminal/payments", json(bad)))).status).toBe(422);
    }
    const tooMuch = await startTender(orderId, 5000);
    expect(tooMuch.res.status).toBe(422);
    expect(tooMuch.body.code).toBe("amount_exceeds_balance");
    const missing = await startPOST(
      req(
        "/api/terminal/payments",
        json({ paymentId: uuid(), orderId: "nope", readerId: SIM_READER, amountCents: 100 }),
      ),
    );
    expect(missing.status).toBe(404);
  });

  it("is idempotent on paymentId and returns the live tender for a new id", async () => {
    const orderId = await seedOrder();
    const a = await startTender(orderId);
    const b = await startTender(orderId, 2000, a.paymentId);
    expect(b.body.resumed).toBe(true);
    expect(b.body.payment.id).toBe(a.paymentId);
    const c = await startTender(orderId);
    expect(c.body.payment.id).toBe(a.paymentId);
  });
});

describe("tender lifecycle routes (simulated reader)", () => {
  it("GET sync -> simulate decline -> retry -> simulate approve -> order paid", async () => {
    const orderId = await seedOrder();
    const { paymentId } = await startTender(orderId);

    const polled = await (await syncGET(req(`/api/terminal/payments/${paymentId}`), params(paymentId))).json();
    expect(polled.payment.status).toBe("requires_action");
    expect(polled.readerAction.status).toBe("in_progress");

    const declined = await (
      await simulatePOST(
        req(`/api/terminal/payments/${paymentId}/simulate`, json({ outcome: "decline" })),
        params(paymentId),
      )
    ).json();
    expect(declined.payment.raw.last_error.code).toBe("card_declined");
    expect(declined.orderStatus).toBe("placed");

    const retried = await (
      await retryPOST(req(`/api/terminal/payments/${paymentId}/retry`, json({})), params(paymentId))
    ).json();
    expect(retried.payment.id).toBe(paymentId);
    expect(retried.payment.raw.reader_action_status).toBe("in_progress");

    const approved = await (
      await simulatePOST(
        req(`/api/terminal/payments/${paymentId}/simulate`, json({ outcome: "approve", tipCents: 200 })),
        params(paymentId),
      )
    ).json();
    expect(approved.payment.status).toBe("captured");
    expect(approved.payment.tip_cents).toBe(200);
    expect(approved.payment.raw.card_receipt).toMatchObject({ brand: "visa", last4: "4242" });
    expect(approved.orderStatus).toBe("paid");
    expect(approved.balanceCents).toBe(0);
  });

  it("cancel returns the balance; auth is by the tender's tenant; kitchen 403; unknown/foreign payment 404", async () => {
    const orderId = await seedOrder();
    const { paymentId } = await startTender(orderId);
    sessionRole("kitchen");
    expect((await cancelPOST(req(`/api/terminal/payments/${paymentId}/cancel`, json({})), params(paymentId))).status).toBe(403);
    expect((await syncGET(req(`/api/terminal/payments/${paymentId}`), params(paymentId))).status).toBe(403);
    sessionRole("cashier");
    const res = await cancelPOST(req(`/api/terminal/payments/${paymentId}/cancel`, json({})), params(paymentId));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.outcome).toBe("canceled");
    expect(body.payment.status).toBe("canceled");
    expect(body.balanceCents).toBe(2000);

    expect((await syncGET(req("/api/terminal/payments/nope"), params("nope"))).status).toBe(404);
    // a non-card tender id is not addressable through the terminal routes
    const cash = await paymentsPOST(
      req(
        "/api/payments",
        json({
          paymentId: uuid(),
          orderId,
          tenantId: TENANT,
          locationId: LOCATION,
          rail: "cash",
          amountCents: 500,
          currency: "USD",
        }),
      ),
    );
    const cashId = (await cash.json()).payment.id as string;
    expect((await syncGET(req(`/api/terminal/payments/${cashId}`), params(cashId))).status).toBe(404);
  });

  it("simulate: validates the body; 404 with a live key", async () => {
    const orderId = await seedOrder();
    const { paymentId } = await startTender(orderId);
    const bad = await simulatePOST(
      req(`/api/terminal/payments/${paymentId}/simulate`, json({ outcome: "maybe" })),
      params(paymentId),
    );
    expect(bad.status).toBe(422);

    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://localhost:54321");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "k");
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_live_x");
    const authCallsBefore = requireTenantRole.mock.calls.length;
    const live = await simulatePOST(
      req(`/api/terminal/payments/${paymentId}/simulate`, json({ outcome: "approve" })),
      params(paymentId),
    );
    expect(live.status).toBe(404);
    expect(requireTenantRole.mock.calls.length).toBe(authCallsBefore); // live 404s before auth
  });

  it("the generic payments GET shows the card receipt and last_error but no other rail internals", async () => {
    const orderId = await seedOrder();
    const { paymentId } = await startTender(orderId);
    await simulatePOST(
      req(`/api/terminal/payments/${paymentId}/simulate`, json({ outcome: "approve" })),
      params(paymentId),
    );
    const res = await paymentsGET(req(`/api/payments?orderId=${orderId}`));
    const body = await res.json();
    const raw = body.payments[0].raw;
    expect(raw.card_receipt.last4).toBe("4242");
    expect(raw.applicationFeeCents).toBeUndefined();
    expect(raw.process_attempts).toBeUndefined();
  });
});

describe("GET /api/terminal/readers and reset", () => {
  it("returns the readiness + the virtual reader in simulated mode", async () => {
    const res = await readersGET(
      req(`/api/terminal/readers?tenantId=${TENANT}&locationId=${LOCATION}`),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ mode: "simulated", ready: true, notReadyReason: null });
    expect(body.readers[0]).toMatchObject({ id: SIM_READER, status: "online" });
  });

  it("kitchen 403; another tenant's location 404; missing params 400", async () => {
    sessionRole("kitchen");
    expect(
      (await readersGET(req(`/api/terminal/readers?tenantId=${TENANT}&locationId=${LOCATION}`))).status,
    ).toBe(403);
    sessionRole("cashier");
    expect(
      (await readersGET(req(`/api/terminal/readers?tenantId=${TENANT}&locationId=10000000-0000-0000-0000-00000000ffff`)))
        .status,
    ).toBe(404);
    expect((await readersGET(req("/api/terminal/readers"))).status).toBe(400);
  });

  it("reset: cashier ok on the virtual reader; unknown reader 404; kitchen 403", async () => {
    const ok = await resetPOST(
      req(`/api/terminal/readers/${SIM_READER}/reset`, json({ tenantId: TENANT, locationId: LOCATION })),
      params(SIM_READER),
    );
    expect(ok.status).toBe(200);
    const missing = await resetPOST(
      req("/api/terminal/readers/tmr_nope/reset", json({ tenantId: TENANT, locationId: LOCATION })),
      params("tmr_nope"),
    );
    expect(missing.status).toBe(404);
    sessionRole("kitchen");
    const denied = await resetPOST(
      req(`/api/terminal/readers/${SIM_READER}/reset`, json({ tenantId: TENANT, locationId: LOCATION })),
      params(SIM_READER),
    );
    expect(denied.status).toBe(403);
  });
});

describe("admin: /api/admin/terminal", () => {
  const url = `/api/admin/terminal?tenantId=${TENANT}&locationId=${LOCATION}`;

  it("owner/manager only: cashier and kitchen are 403 on every method", async () => {
    for (const role of ["cashier", "kitchen"]) {
      sessionRole(role);
      expect((await adminGET(req(url))).status).toBe(403);
      expect(
        (await adminPUT(req("/api/admin/terminal", { method: "PUT", body: JSON.stringify({ tenantId: TENANT, locationId: LOCATION, tipMode: "pos" }) }))).status,
      ).toBe(403);
      expect(
        (await adminReaderPOST(req("/api/admin/terminal/readers", json({ tenantId: TENANT, locationId: LOCATION, registrationCode: "a-b-c" })))).status,
      ).toBe(403);
      expect(
        (await adminReaderDELETE(req(`/api/admin/terminal/readers/tmr_x?tenantId=${TENANT}&locationId=${LOCATION}`, { method: "DELETE" }), params("tmr_x"))).status,
      ).toBe(403);
    }
  });

  it("manager reads the setup (default tip mode reader) and saves a tip mode + address", async () => {
    sessionRole("manager");
    const before = await (await adminGET(req(url))).json();
    expect(before).toMatchObject({ mode: "simulated", tipMode: "reader", address: null, ready: true });
    expect(requireTenantRole).toHaveBeenCalledWith(TENANT, ["owner", "manager"]);

    const put = (b: unknown) =>
      adminPUT(req("/api/admin/terminal", { method: "PUT", body: JSON.stringify({ tenantId: TENANT, locationId: LOCATION, ...(b as object) }) }));
    const saved = await put({
      tipMode: "pos",
      address: { line1: "1 Main St", city: "Austin", state: "tx", postal_code: "78701" },
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({
      tipMode: "pos",
      address: { line1: "1 Main St", state: "TX", country: "US" },
    });
    expect((await put({ tipMode: "bogus" })).status).toBe(422);
    expect((await put({ address: { line1: "x" } })).status).toBe(422);
    expect((await put({})).status).toBe(422);
    // the saved tip mode is what the next card tender uses
    const orderId = await seedOrder();
    const { body } = await startTender(orderId);
    expect(body.payment.raw.reader_id).toBe(SIM_READER);
    expect((await getPosDriver().getPayment(body.payment.id))!.raw?.tip_mode).toBe("pos");
  });

  it("registering a reader in simulated mode is 422; deleting an unknown reader is 404", async () => {
    sessionRole("owner");
    const reg = await adminReaderPOST(
      req("/api/admin/terminal/readers", json({ tenantId: TENANT, locationId: LOCATION, registrationCode: "apple-orange-banana", label: "x" })),
    );
    expect(reg.status).toBe(422);
    const noCode = await adminReaderPOST(
      req("/api/admin/terminal/readers", json({ tenantId: TENANT, locationId: LOCATION })),
    );
    expect(noCode.status).toBe(422);
    const del = await adminReaderDELETE(
      req(`/api/admin/terminal/readers/tmr_x?tenantId=${TENANT}&locationId=${LOCATION}`, { method: "DELETE" }),
      params("tmr_x"),
    );
    expect(del.status).toBe(404);
  });
});

describe("generic /api/payments and stripe_terminal", () => {
  async function seedConnected() {
    await getPosDriver().upsertConnectAccount({
      tenant_id: TENANT,
      account_id: ACCT,
      status: "connected",
      charges_enabled: true,
      payouts_enabled: true,
      details_submitted: true,
      simulated: false,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: new Date().toISOString(),
    });
  }
  const payBody = (orderId: string) => ({
    paymentId: uuid(),
    orderId,
    tenantId: TENANT,
    locationId: LOCATION,
    rail: "stripe_terminal",
    amountCents: 2000,
    currency: "USD",
  });

  it("real mode: an in-store stripe_terminal tender is refused (400) after auth, with no Stripe call", async () => {
    await seedConnected();
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://localhost:54321");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "k");
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
    const orderId = await seedOrder();
    const res = await paymentsPOST(req("/api/payments", json(payBody(orderId))));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("use_terminal_reader");
    expect(stripeRequest).not.toHaveBeenCalled();
    // unauthenticated callers still get the auth answer first
    sessionRole(null);
    expect((await paymentsPOST(req("/api/payments", json(payBody(orderId))))).status).toBe(401);
  });

  it("simulated mode keeps the legacy instant approval (until the till moves to the reader flow)", async () => {
    const orderId = await seedOrder();
    const res = await paymentsPOST(req("/api/payments", json(payBody(orderId))));
    expect(res.status).toBe(201);
    expect((await res.json()).payment.status).toBe("captured");
  });
});

// ---------------------------------------------------------------------------
// Webhook: card-present tenders settle by re-reading the PaymentIntent.
// ---------------------------------------------------------------------------

describe("Connect webhook: card-present", () => {
  let piState: Record<string, unknown>;
  let readerState: Record<string, unknown>;

  async function startRealTender() {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://localhost:54321");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "k");
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_x");
    const driver = getPosDriver();
    await driver.upsertConnectAccount({
      tenant_id: TENANT,
      account_id: ACCT,
      status: "connected",
      charges_enabled: true,
      payouts_enabled: true,
      details_submitted: true,
      simulated: false,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: new Date().toISOString(),
    });
    const now = new Date().toISOString();
    await driver.upsertTerminalReader({
      id: "tmr_1",
      tenant_id: TENANT,
      location_id: LOCATION,
      connect_account_id: ACCT,
      label: "Counter",
      device_type: "stripe_s700",
      serial_number: null,
      livemode: false,
      created_at: now,
      updated_at: now,
    });
    stripeRequest.mockImplementation(async (path: string) => {
      if (path === "/payment_intents") return { id: "pi_1", status: "requires_payment_method" };
      if (path.endsWith("/process_payment_intent")) return { id: "tmr_1", action: { status: "in_progress" } };
      throw new Error(`unexpected ${path}`);
    });
    stripeGet.mockImplementation(async (path: string) => {
      if (path.startsWith("/payment_intents/")) return piState;
      if (path.startsWith("/terminal/readers/")) return readerState;
      throw new Error(`unexpected GET ${path}`);
    });
    const orderId = await seedOrder();
    const paymentId = uuid();
    const { startCardTender } = await import("./flow");
    const { payment } = await startCardTender({ paymentId, orderId, readerId: "tmr_1", amountCents: 2000 });
    piState = {
      id: "pi_1",
      status: "requires_payment_method",
      amount: 2000,
      currency: "usd",
      metadata: { payment_id: paymentId },
      amount_details: null,
      last_payment_error: null,
      latest_charge: null,
    };
    readerState = { id: "tmr_1", status: "online", action: null };
    return { orderId, payment };
  }

  function hook(type: string, object: Record<string, unknown>, account: string | null = ACCT) {
    return webhookPOST(
      req("/api/payments/stripe/webhook", {
        method: "POST",
        headers: { "stripe-signature": "t=1,v1=x" },
        body: JSON.stringify({ type, ...(account ? { account } : {}), data: { object } }),
      }),
    );
  }

  it("payment_intent.succeeded with an on-reader tip settles via the re-read PI (tip recorded, order paid)", async () => {
    const { orderId, payment } = await startRealTender();
    piState = { ...piState, status: "succeeded", amount: 2300, amount_details: { tip: { amount: 300 } } };
    // The event's own amount (2300) differs from the tender's (2000): that is fine for card-present.
    const res = await hook("payment_intent.succeeded", { id: "pi_1", amount: 2300, currency: "usd", metadata: { payment_id: payment.id } });
    expect(res.status).toBe(200);
    const p = (await getPosDriver().getPayment(payment.id))!;
    expect(p.status).toBe("captured");
    expect(p.tip_cents).toBe(300);
    expect((await getPosDriver().getOrder(orderId))!.status).toBe("paid");
  });

  it("terminal.reader.action_succeeded settles the tender named by the reader's action", async () => {
    const { orderId, payment } = await startRealTender();
    piState = { ...piState, status: "succeeded" };
    const res = await hook("terminal.reader.action_succeeded", {
      id: "tmr_1",
      action: { status: "succeeded", process_payment_intent: { payment_intent: "pi_1" } },
    });
    expect(res.status).toBe(200);
    expect((await getPosDriver().getPayment(payment.id))!.status).toBe("captured");
    expect((await getPosDriver().getOrder(orderId))!.status).toBe("paid");
  });

  it("terminal.reader.action_failed records the decline and leaves the tender open", async () => {
    const { orderId, payment } = await startRealTender();
    piState = {
      ...piState,
      last_payment_error: { code: "card_declined", decline_code: "generic_decline", message: "Your card was declined." },
    };
    readerState = {
      id: "tmr_1",
      status: "online",
      action: { status: "failed", failure_code: "card_declined", process_payment_intent: { payment_intent: "pi_1" } },
    };
    const res = await hook("terminal.reader.action_failed", {
      id: "tmr_1",
      action: { status: "failed", process_payment_intent: { payment_intent: "pi_1" } },
    });
    expect(res.status).toBe(200);
    const p = (await getPosDriver().getPayment(payment.id))!;
    expect(p.status).toBe("requires_action");
    expect(p.raw?.last_error).toMatchObject({ code: "card_declined" });
    expect((await getPosDriver().getOrder(orderId))!.status).toBe("placed");
  });

  it("an event from the wrong connected account (or without one) is ignored", async () => {
    const { payment } = await startRealTender();
    piState = { ...piState, status: "succeeded" };
    const wrong = await (
      await hook("terminal.reader.action_succeeded", {
        id: "tmr_1",
        action: { process_payment_intent: { payment_intent: "pi_1" } },
      }, "acct_other")
    ).json();
    expect(wrong.ignored).toBe("account_mismatch");
    const wrongPi = await (
      await hook("payment_intent.succeeded", { id: "pi_1", amount: 2000, currency: "usd", metadata: { payment_id: payment.id } }, "acct_other")
    ).json();
    expect(wrongPi.ignored).toBe("account_mismatch");
    const none = await (
      await hook("payment_intent.succeeded", { id: "pi_1", amount: 2000, currency: "usd" }, null)
    ).json();
    expect(none.ignored).toBe("no_account");
    expect((await getPosDriver().getPayment(payment.id))!.status).toBe("requires_action");
  });

  it("an unknown PaymentIntent is acknowledged; a PI that doesn't fit the tender is refused without settling", async () => {
    const { payment } = await startRealTender();
    const unknown = await (
      await hook("terminal.reader.action_succeeded", {
        id: "tmr_1",
        action: { process_payment_intent: { payment_intent: "pi_unknown" } },
      })
    ).json();
    expect(unknown.ignored).toBe("unknown_payment");

    piState = { ...piState, status: "succeeded", amount: 500 }; // less than the base
    const bad = await hook("payment_intent.succeeded", { id: "pi_1", amount: 500, currency: "usd", metadata: { payment_id: payment.id } });
    expect(bad.status).toBe(200);
    expect((await bad.json()).ignored).toBe("amount_mismatch");
    expect((await getPosDriver().getPayment(payment.id))!.status).toBe("requires_action");
  });
});
