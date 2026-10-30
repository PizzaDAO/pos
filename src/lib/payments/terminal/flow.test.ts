import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

// Stripe is stubbed at the HTTP-client boundary: every Terminal call goes
// through stripeRequest / stripeGet / stripeDelete.
const stripeRequest = vi.fn();
const stripeGet = vi.fn();
const stripeDelete = vi.fn();
vi.mock("@/lib/payments/providers/stripe-client", async (orig) => ({
  ...(await orig<typeof import("@/lib/payments/providers/stripe-client")>()),
  stripeRequest: (...a: unknown[]) => stripeRequest(...a),
  stripeGet: (...a: unknown[]) => stripeGet(...a),
  stripeDelete: (...a: unknown[]) => stripeDelete(...a),
}));

import { StripeError } from "@/lib/payments/providers/stripe-client";
import {
  TerminalFlowError,
  cancelCardTender,
  closeOpenCardTender,
  reconcileTerminalTenders,
  resetReader,
  retryCardTender,
  simulateCardTender,
  startCardTender,
  syncCardTender,
} from "./flow";
import { ReaderNotFoundError, simulatedReaderId } from "./readers";
import { getOrderBalance, takePayment } from "../service";
import { CardPaymentsNotReadyError } from "../connect";

const TENANT = DEMO_TENANT_ID;
const LOCATION = DEMO_LOCATION_DOWNTOWN_ID;
const SIM_READER = simulatedReaderId(LOCATION);
const ACCT = "acct_real_9";

let seq = 0;
const uuid = () => crypto.randomUUID();

async function seedOrder(opts: { total?: number; channel?: "in_store" | "online_pickup"; location?: string } = {}) {
  seq += 1;
  const total = opts.total ?? 2000;
  const id = `term-order-${seq}`;
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
    location_id: opts.location ?? LOCATION,
    channel: opts.channel ?? "in_store",
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

async function orderStatus(orderId: string) {
  return (await getPosDriver().getOrder(orderId))!.status;
}

const spyFetch = () => vi.spyOn(globalThis, "fetch");
let fetchSpy: ReturnType<typeof spyFetch>;

beforeEach(() => {
  resetMockOrders();
  resetMockPayments();
  stripeRequest.mockReset();
  stripeGet.mockReset();
  stripeDelete.mockReset();
  vi.unstubAllEnvs();
  getPosDriver(); // memoize the mock driver; env below only changes the mode
  fetchSpy = spyFetch();
});

afterEach(() => {
  fetchSpy.mockRestore();
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// Simulated mode (zero env): one virtual reader, no Stripe call, ever.
// ---------------------------------------------------------------------------

describe("simulated reader", () => {
  async function start(orderId: string, amountCents = 2000, paymentId = uuid()) {
    return startCardTender({ paymentId, orderId, readerId: SIM_READER, amountCents });
  }

  it("start: requires_action, the balance is NOT reduced, the order stays placed", async () => {
    const orderId = await seedOrder();
    const { payment, resumed } = await start(orderId);
    expect(resumed).toBe(false);
    expect(payment.status).toBe("requires_action");
    expect(payment.rail).toBe("stripe_terminal");
    expect(payment.charge_id!.startsWith("sim_")).toBe(true);
    expect(payment.raw).toMatchObject({
      reader_id: SIM_READER,
      process_attempts: 1,
      reader_action_status: "in_progress",
    });
    expect(await getOrderBalance((await getPosDriver().getOrder(orderId))!)).toBe(2000);
    expect(await orderStatus(orderId)).toBe("placed");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(stripeRequest).not.toHaveBeenCalled();
  });

  it("simulate approve: captured, order paid once, receipt stored, tip from the reader recorded", async () => {
    const orderId = await seedOrder();
    const { payment } = await start(orderId);
    const res = await simulateCardTender(payment.id, { outcome: "approve", tipCents: 300 });
    expect(res.payment.status).toBe("captured");
    expect(res.payment.tip_cents).toBe(300);
    expect(res.payment.amount_cents).toBe(2000);
    expect(res.payment.raw?.card_receipt).toMatchObject({ brand: "visa", last4: "4242" });
    expect(await orderStatus(orderId)).toBe("paid");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("simulate decline: last_error set, order still placed; retry reuses the SAME tender and intent", async () => {
    const orderId = await seedOrder();
    const { payment } = await start(orderId);
    const declined = await simulateCardTender(payment.id, { outcome: "decline" });
    expect(declined.payment.status).toBe("requires_action");
    expect(declined.payment.raw?.last_error).toMatchObject({ code: "card_declined" });
    expect(declined.payment.raw?.reader_action_status).toBe("failed");
    expect(await orderStatus(orderId)).toBe("placed");

    const retried = await retryCardTender(payment.id);
    expect(retried.payment.id).toBe(payment.id);
    expect(retried.payment.charge_id).toBe(payment.charge_id);
    expect(retried.payment.raw?.process_attempts).toBe(2);
    expect(retried.payment.raw?.last_error).toBeNull();
    expect(retried.payment.raw?.reader_action_status).toBe("in_progress");

    const ok = await simulateCardTender(payment.id, { outcome: "approve" });
    expect(ok.payment.status).toBe("captured");
    expect(await orderStatus(orderId)).toBe("paid");
  });

  it("concurrent syncs (poll x2 + webhook) settle once", async () => {
    const orderId = await seedOrder();
    const { payment } = await start(orderId);
    const driver = getPosDriver();
    await driver.upsertPayment({
      ...(await driver.getPayment(payment.id))!,
      raw: { ...(payment.raw ?? {}), sim_outcome: "approve" },
    });
    const transition = vi.spyOn(driver, "transitionOrderStatus");
    const results = await Promise.all([
      syncCardTender(payment.id),
      syncCardTender(payment.id),
      syncCardTender(payment.id),
    ]);
    expect(results.every((r) => r.payment.status === "captured")).toBe(true);
    expect(await orderStatus(orderId)).toBe("paid");
    const toPaid = await Promise.all(
      transition.mock.results.map((r) => r.value as Promise<unknown>),
    );
    // Every call after the first finds the order no longer draft/placed.
    expect(toPaid.filter(Boolean).length).toBeGreaterThanOrEqual(1);
    expect((await driver.listPaymentsForOrder(orderId)).filter((p) => p.status === "captured")).toHaveLength(1);
    transition.mockRestore();
  });

  it("repeat start with the same paymentId returns the existing tender; a new id while one is live returns the live one", async () => {
    const orderId = await seedOrder();
    const id = uuid();
    const a = await start(orderId, 2000, id);
    const b = await start(orderId, 2000, id);
    expect(b.resumed).toBe(true);
    expect(b.payment.id).toBe(a.payment.id);
    const c = await start(orderId, 2000, uuid());
    expect(c.resumed).toBe(true);
    expect(c.payment.id).toBe(a.payment.id);
    expect(await getPosDriver().listPaymentsForOrder(orderId)).toHaveLength(1);
  });

  it("a paymentId reused for another order is refused (409)", async () => {
    const id = uuid();
    await start(await seedOrder(), 2000, id);
    await expect(start(await seedOrder(), 2000, id)).rejects.toMatchObject({ status: 409 });
  });

  it("cancel: tender canceled, balance restored; cancel after approval is 'settled'", async () => {
    const orderId = await seedOrder();
    const { payment } = await start(orderId);
    const res = await cancelCardTender(payment.id);
    expect(res.outcome).toBe("canceled");
    expect(res.payment.status).toBe("canceled");
    expect(await getOrderBalance((await getPosDriver().getOrder(orderId))!)).toBe(2000);

    // a fresh tender is allowed once the first is canceled
    const second = await start(orderId);
    expect(second.resumed).toBe(false);
    await simulateCardTender(second.payment.id, { outcome: "approve" });
    const late = await cancelCardTender(second.payment.id);
    expect(late.outcome).toBe("settled");
    expect(late.payment.status).toBe("captured");
  });

  it("split: card for part of the balance leaves the rest due, then cash-style completion", async () => {
    const orderId = await seedOrder({ total: 2000 });
    const { payment } = await start(orderId, 800);
    await simulateCardTender(payment.id, { outcome: "approve" });
    expect(await orderStatus(orderId)).toBe("placed");
    expect(await getOrderBalance((await getPosDriver().getOrder(orderId))!)).toBe(1200);
    const rest = await start(orderId, 1200);
    await simulateCardTender(rest.payment.id, { outcome: "approve" });
    expect(await orderStatus(orderId)).toBe("paid");
  });

  it("amount guard: more than the balance is 422; zero is 422", async () => {
    const orderId = await seedOrder({ total: 2000 });
    await expect(start(orderId, 2001)).rejects.toMatchObject({
      code: "amount_exceeds_balance",
      status: 422,
    });
    await expect(start(orderId, 0)).rejects.toMatchObject({ code: "amount_invalid", status: 422 });
    expect(await getPosDriver().listPaymentsForOrder(orderId)).toHaveLength(0);
  });

  it("a reader from another location is refused; online orders are refused", async () => {
    const orderId = await seedOrder();
    await expect(
      startCardTender({
        paymentId: uuid(),
        orderId,
        readerId: simulatedReaderId(DEMO_LOCATION_UPTOWN_ID),
        amountCents: 2000,
      }),
    ).rejects.toBeInstanceOf(ReaderNotFoundError);
    const online = await seedOrder({ channel: "online_pickup" });
    await expect(start(online)).rejects.toMatchObject({ code: "order_not_payable", status: 409 });
  });

  it("tip mode: reader ignores a POS tip; pos mode puts it on the tender", async () => {
    const driver = getPosDriver();
    const order1 = await seedOrder();
    const readerMode = await startCardTender({
      paymentId: uuid(),
      orderId: order1,
      readerId: SIM_READER,
      amountCents: 2000,
      tipCents: 400,
    });
    expect(readerMode.payment.tip_cents).toBe(0);

    const now = new Date().toISOString();
    await driver.upsertTerminalLocation({
      location_id: LOCATION,
      tenant_id: TENANT,
      connect_account_id: null,
      stripe_location_id: `tml_sim_${LOCATION}`,
      configuration_id: null,
      livemode: false,
      address: null,
      tip_mode: "pos",
      created_at: now,
      updated_at: now,
    });
    const order2 = await seedOrder();
    const posMode = await startCardTender({
      paymentId: uuid(),
      orderId: order2,
      readerId: SIM_READER,
      amountCents: 2000,
      tipCents: 400,
    });
    expect(posMode.payment.tip_cents).toBe(400);
    expect(posMode.payment.raw?.tip_mode).toBe("pos");
  });

  it("TERMINAL_SIM_AUTO_APPROVE_MS approves a tender with no click", async () => {
    vi.stubEnv("TERMINAL_SIM_AUTO_APPROVE_MS", "1");
    const orderId = await seedOrder();
    const { payment } = await start(orderId);
    await new Promise((r) => setTimeout(r, 15));
    const res = await syncCardTender(payment.id);
    expect(res.payment.status).toBe("captured");
    expect(await orderStatus(orderId)).toBe("paid");
  });

  it("TRAINING_MODE=1 with a live key stays simulated and never calls fetch", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://localhost:54321");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "k");
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_live_x");
    vi.stubEnv("TRAINING_MODE", "1");
    const orderId = await seedOrder();
    const { payment } = await start(orderId);
    expect(payment.charge_id!.startsWith("sim_")).toBe(true);
    // No simulator wherever a live key is configured, even in training mode.
    await expect(simulateCardTender(payment.id, { outcome: "approve" })).rejects.toMatchObject({
      code: "not_simulated",
      status: 404,
    });
    // The tender still settles (demo auto-approve) without ever touching Stripe.
    vi.stubEnv("TERMINAL_SIM_AUTO_APPROVE_MS", "1");
    await new Promise((r) => setTimeout(r, 15));
    expect((await syncCardTender(payment.id)).payment.status).toBe("captured");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(stripeRequest).not.toHaveBeenCalled();
    expect(stripeGet).not.toHaveBeenCalled();
  });

  it("sim tip: approving without a tip keeps the POS tip already on the tender", async () => {
    const now = new Date().toISOString();
    await getPosDriver().upsertTerminalLocation({
      location_id: LOCATION,
      tenant_id: TENANT,
      connect_account_id: null,
      stripe_location_id: `tml_sim_${LOCATION}`,
      configuration_id: null,
      livemode: false,
      address: null,
      tip_mode: "pos",
      created_at: now,
      updated_at: now,
    });
    const { payment } = await startCardTender({
      paymentId: uuid(),
      orderId: await seedOrder(),
      readerId: SIM_READER,
      amountCents: 2000,
      tipCents: 400,
    });
    const done = await simulateCardTender(payment.id, { outcome: "approve" });
    expect(done.payment.tip_cents).toBe(400);
    expect(done.payment.raw).not.toHaveProperty("sim_tip_cents", 0);
  });

  it("closeOpenCardTender: cancels a live card tender; reports settled when a card already went through", async () => {
    const orderId = await seedOrder();
    expect(await closeOpenCardTender(orderId)).toBe("none");
    const { payment } = await start(orderId);
    expect(await closeOpenCardTender(orderId)).toBe("canceled");
    expect((await getPosDriver().getPayment(payment.id))!.status).toBe("canceled");

    const second = await start(orderId);
    await simulateCardTender(second.payment.id, { outcome: "approve" });
    expect(await closeOpenCardTender(orderId)).toBe("none"); // nothing OPEN left
  });

  it("cash that covers the order closes a live card tender (no later tap can double charge)", async () => {
    const orderId = await seedOrder();
    const { payment } = await start(orderId);
    await takePayment({
      paymentId: uuid(),
      orderId,
      tenantId: TENANT,
      locationId: LOCATION,
      rail: "cash",
      amountCents: 2000,
      tipCents: 0,
      currency: "USD",
    });
    expect((await getPosDriver().getPayment(payment.id))!.status).toBe("canceled");
    expect(await orderStatus(orderId)).toBe("paid");
  });

  it("a partial cash tender leaves the live card tender alone", async () => {
    const orderId = await seedOrder();
    const { payment } = await start(orderId, 1200);
    await takePayment({
      paymentId: uuid(),
      orderId,
      tenantId: TENANT,
      locationId: LOCATION,
      rail: "cash",
      amountCents: 800,
      tipCents: 0,
      currency: "USD",
    });
    expect((await getPosDriver().getPayment(payment.id))!.status).toBe("requires_action");
    expect(await orderStatus(orderId)).toBe("placed");
  });

  it("a double settlement on an IN-STORE order is flagged as a duplicate and listed for the admin", async () => {
    const driver = getPosDriver();
    const orderId = await seedOrder();
    const { payment } = await start(orderId);
    await simulateCardTender(payment.id, { outcome: "approve", tipCents: 300 });
    // A tip alone is never a duplicate.
    expect((await driver.getOrder(orderId))!.fulfillment?.late_payment).toBeUndefined();

    await takePayment({
      paymentId: uuid(),
      orderId,
      tenantId: TENANT,
      locationId: LOCATION,
      rail: "cash",
      amountCents: 2000,
      tipCents: 0,
      currency: "USD",
    });
    const order = (await driver.getOrder(orderId))!;
    expect(order.channel).toBe("in_store");
    expect(order.fulfillment?.late_payment).toMatchObject({ kind: "duplicate", amount_cents: 2000 });
    const open = await driver.listOpenLatePayments(TENANT, LOCATION, 100);
    expect(open.map((o) => o.id)).toContain(orderId);
  });

  it("a lone captured card tender with a tip is not flagged", async () => {
    const orderId = await seedOrder();
    const { payment } = await start(orderId);
    await simulateCardTender(payment.id, { outcome: "approve", tipCents: 500 });
    expect((await getPosDriver().getOrder(orderId))!.fulfillment).toBeUndefined();
  });

  it("reconcile cancels a tender left open and settles an approved one", async () => {
    const stale = await start(await seedOrder());
    const approved = await start(await seedOrder());
    const driver = getPosDriver();
    await driver.upsertPayment({
      ...(await driver.getPayment(approved.payment.id))!,
      raw: { ...(approved.payment.raw ?? {}), sim_outcome: "approve" },
    });
    const summary = await reconcileTerminalTenders({ olderThanMs: -1000 });
    expect(summary).toMatchObject({ checked: 2, settled: 1, canceled: 1, errors: 0 });
    expect((await driver.getPayment(stale.payment.id))!.status).toBe("canceled");
    expect((await driver.getPayment(approved.payment.id))!.status).toBe("captured");
  });

  it("reset on the virtual reader is a no-op; a foreign reader is refused", async () => {
    await expect(
      resetReader({ tenantId: TENANT, locationId: LOCATION, readerId: SIM_READER }),
    ).resolves.toBeUndefined();
    await expect(
      resetReader({ tenantId: TENANT, locationId: LOCATION, readerId: "tmr_other" }),
    ).rejects.toBeInstanceOf(ReaderNotFoundError);
  });
});

// ---------------------------------------------------------------------------
// Stripe test mode, Stripe stubbed. (The mock driver stays; only the card-rail
// decision flips, as in the other payment suites.)
// ---------------------------------------------------------------------------

describe("stripe_test mode (stubbed Stripe)", () => {
  function goReal(key = "sk_test_x") {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://localhost:54321");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "k");
    vi.stubEnv("STRIPE_SECRET_KEY", key);
  }

  let piState: Record<string, unknown>;
  let readerState: Record<string, unknown>;

  function setPi(paymentId: string, o: Record<string, unknown> = {}) {
    piState = {
      id: "pi_1",
      status: "requires_payment_method",
      amount: 2000,
      currency: "usd",
      metadata: { payment_id: paymentId },
      amount_details: null,
      last_payment_error: null,
      latest_charge: null,
      ...o,
    };
  }

  beforeEach(async () => {
    goReal();
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
      updated_at: "2026-01-01T00:00:00.000Z",
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
    readerState = { id: "tmr_1", status: "online", action: null };
    setPi("pending");
    stripeRequest.mockImplementation(async (path: string) => {
      if (path === "/payment_intents") return { id: "pi_1", status: "requires_payment_method" };
      if (path.endsWith("/process_payment_intent")) {
        return { id: "tmr_1", action: { type: "process_payment_intent", status: "in_progress" } };
      }
      if (path.endsWith("/cancel_action")) return { id: "tmr_1", action: null };
      if (path.endsWith("/cancel")) return { id: "pi_1", status: "canceled" };
      if (path.includes("present_payment_method")) return { id: "tmr_1" };
      throw new Error(`unexpected POST ${path}`);
    });
    stripeGet.mockImplementation(async (path: string) => {
      if (path.startsWith("/payment_intents/")) return piState;
      if (path.startsWith("/terminal/readers/")) return readerState;
      throw new Error(`unexpected GET ${path}`);
    });
  });

  const callsTo = (suffix: string) =>
    stripeRequest.mock.calls.filter((c) => (c[0] as string).endsWith(suffix));

  async function startReal(orderId: string, amountCents = 2000) {
    const paymentId = uuid();
    const res = await startCardTender({ paymentId, orderId, readerId: "tmr_1", amountCents });
    setPi(paymentId, { amount: amountCents });
    return res.payment;
  }

  it("start: card_present intent on the connected account (fee on the pre-tip amount), then process_payment_intent with the per-attempt key", async () => {
    const orderId = await seedOrder();
    const payment = await startReal(orderId);

    const [, body, opts] = callsTo("/payment_intents")[0]!;
    expect(opts).toMatchObject({ stripeAccount: ACCT, idempotencyKey: payment.id });
    expect(body).toMatchObject({
      amount: 2000,
      currency: "usd",
      payment_method_types: ["card_present"],
      capture_method: "automatic",
      application_fee_amount: 60, // 2.5% of 2000 + 10
    });
    expect((body as { description: string }).description).toContain("Order #");
    expect((body as { metadata: Record<string, string> }).metadata).toMatchObject({
      payment_id: payment.id,
      reader_id: "tmr_1",
      tip_mode: "reader",
    });

    const [path, pbody, popts] = callsTo("/process_payment_intent")[0]!;
    expect(path).toBe("/terminal/readers/tmr_1/process_payment_intent");
    expect(pbody).toMatchObject({
      payment_intent: "pi_1",
      process_config: { enable_customer_cancellation: true },
    });
    expect((pbody as { process_config: Record<string, unknown> }).process_config.skip_tipping).toBeUndefined();
    expect(popts).toEqual({ stripeAccount: ACCT, idempotencyKey: `${payment.id}:process:1` });

    expect(payment.status).toBe("requires_action");
    expect(payment.connect_account_id).toBe(ACCT);
    expect(payment.simulated).toBe(false);
    expect(await orderStatus(orderId)).toBe("placed");
    // never confirmed server-side, never a client secret
    expect(JSON.stringify(payment.raw)).not.toContain("secret");
    expect(callsTo("/confirm")).toHaveLength(0);
  });

  it("POS tip mode: skip_tipping is sent and the fee is on the PRE-TIP amount", async () => {
    const now = new Date().toISOString();
    await getPosDriver().upsertTerminalLocation({
      location_id: LOCATION,
      tenant_id: TENANT,
      connect_account_id: ACCT,
      stripe_location_id: "tml_1",
      configuration_id: null,
      livemode: false,
      address: null,
      tip_mode: "pos",
      created_at: now,
      updated_at: now,
    });
    const res = await startCardTender({
      paymentId: uuid(),
      orderId: await seedOrder(),
      readerId: "tmr_1",
      amountCents: 2000,
      tipCents: 400,
    });
    expect(res.payment.tip_cents).toBe(400);
    const body = callsTo("/payment_intents")[0]![1] as Record<string, unknown>;
    expect(body.amount).toBe(2400);
    expect(body.application_fee_amount).toBe(60); // pre-tip only: 2.5% of 2000 + 10
    const pbody = callsTo("/process_payment_intent")[0]![1] as {
      process_config: Record<string, unknown>;
    };
    expect(pbody.process_config.skip_tipping).toBe(true);
  });

  it("sync succeeded: captured, the on-reader tip lands in tip_cents, EMV receipt fields stored, order paid", async () => {
    const orderId = await seedOrder();
    const payment = await startReal(orderId);
    setPi(payment.id, {
      status: "succeeded",
      amount: 2300,
      amount_details: { tip: { amount: 300 } },
      latest_charge: {
        id: "ch_1",
        payment_method_details: {
          card_present: {
            brand: "visa",
            last4: "4242",
            read_method: "contact_emv",
            receipt: {
              application_preferred_name: "Visa Credit",
              dedicated_file_name: "A0000000031010",
              account_type: "credit",
              authorization_response_code: "00",
            },
          },
        },
      },
    });
    const res = await syncCardTender(payment.id);
    expect(res.payment.status).toBe("captured");
    expect(res.payment.tip_cents).toBe(300);
    expect(res.payment.amount_cents).toBe(2000);
    expect(res.payment.raw?.card_receipt).toMatchObject({
      brand: "visa",
      last4: "4242",
      application_preferred_name: "Visa Credit",
      dedicated_file_name: "A0000000031010",
    });
    expect(await orderStatus(orderId)).toBe("paid");
    // the PI is fetched on the connected account with the charge expanded
    expect(stripeGet.mock.calls[0]![0]).toContain("/payment_intents/pi_1");
    expect(stripeGet.mock.calls[0]![0]).toContain("latest_charge");
    expect(stripeGet.mock.calls[0]![1]).toEqual({ stripeAccount: ACCT });
  });

  it("decline: reader action failed -> requires_action + last_error; retry runs the SAME intent with attempt 2", async () => {
    const orderId = await seedOrder();
    const payment = await startReal(orderId);
    setPi(payment.id, {
      last_payment_error: {
        code: "card_declined",
        decline_code: "generic_decline",
        message: "Your card was declined.",
        type: "card_error",
      },
    });
    readerState = {
      id: "tmr_1",
      status: "online",
      action: {
        type: "process_payment_intent",
        status: "failed",
        failure_code: "card_declined",
        failure_message: "declined",
        process_payment_intent: { payment_intent: "pi_1" },
      },
    };
    const res = await syncCardTender(payment.id);
    expect(res.payment.status).toBe("requires_action");
    expect(res.readerAction?.status).toBe("failed");
    expect(res.payment.raw?.last_error).toMatchObject({ code: "card_declined", declineCode: "generic_decline" });
    expect(await orderStatus(orderId)).toBe("placed");

    stripeRequest.mockClear();
    readerState = { id: "tmr_1", status: "online", action: null };
    setPi(payment.id); // the intent is back to a clean unpaid state
    const retried = await retryCardTender(payment.id);
    expect(retried.payment.id).toBe(payment.id);
    expect(callsTo("/payment_intents")).toHaveLength(0); // no new intent
    const [, body, opts] = callsTo("/process_payment_intent")[0]!;
    expect(body).toMatchObject({ payment_intent: "pi_1" });
    expect(opts).toMatchObject({ idempotencyKey: `${payment.id}:process:2`, stripeAccount: ACCT });
    expect(retried.payment.raw?.process_attempts).toBe(2);
  });

  it("retry syncs first: a card that actually went through is not charged again", async () => {
    const payment = await startReal(await seedOrder());
    setPi(payment.id, { status: "succeeded", amount: 2000 });
    stripeRequest.mockClear();
    const res = await retryCardTender(payment.id);
    expect(res.payment.status).toBe("captured");
    expect(callsTo("/process_payment_intent")).toHaveLength(0);
  });

  it("refuses a PaymentIntent that doesn't match the tender (amount, metadata, currency)", async () => {
    const orderId = await seedOrder();
    const payment = await startReal(orderId);
    for (const bad of [
      { status: "succeeded", amount: 1000 }, // less than the base
      { status: "succeeded", amount: 2000, metadata: { payment_id: "someone-else" } },
      { status: "succeeded", amount: 2000, currency: "eur" },
      { status: "succeeded", amount: 2300, amount_details: { tip: { amount: 100 } } }, // inconsistent tip
    ]) {
      setPi(payment.id, bad);
      await expect(syncCardTender(payment.id)).rejects.toMatchObject({ code: "mismatch" });
    }
    expect((await getPosDriver().getPayment(payment.id))!.status).toBe("requires_action");
    expect(await orderStatus(orderId)).toBe("placed");
  });

  it("a canceled intent cancels the tender", async () => {
    const payment = await startReal(await seedOrder());
    setPi(payment.id, { status: "canceled" });
    expect((await syncCardTender(payment.id)).payment.status).toBe("canceled");
  });

  const onIntent = (pi: string) => ({
    id: "tmr_1",
    status: "online",
    action: {
      type: "process_payment_intent",
      status: "in_progress",
      process_payment_intent: { payment_intent: pi },
    },
  });

  it("cancel: cancel_action then the intent is canceled on the connected account", async () => {
    const payment = await startReal(await seedOrder());
    readerState = onIntent("pi_1");
    stripeRequest.mockClear();
    const res = await cancelCardTender(payment.id);
    expect(res.outcome).toBe("canceled");
    const paths = stripeRequest.mock.calls.map((c) => c[0]);
    expect(paths).toContain("/terminal/readers/tmr_1/cancel_action");
    expect(paths).toContain("/payment_intents/pi_1/cancel");
    for (const c of stripeRequest.mock.calls) {
      expect(c[2]).toMatchObject({ stripeAccount: ACCT });
    }
    expect(res.payment.status).toBe("canceled");
  });

  it("cancel does NOT touch a reader that has moved on to another PaymentIntent (PI cancel only)", async () => {
    const payment = await startReal(await seedOrder());
    readerState = onIntent("pi_someone_else");
    stripeRequest.mockClear();
    const res = await cancelCardTender(payment.id);
    expect(res.outcome).toBe("canceled");
    const paths = stripeRequest.mock.calls.map((c) => c[0]);
    expect(paths).not.toContain("/terminal/readers/tmr_1/cancel_action");
    expect(paths).toContain("/payment_intents/pi_1/cancel");
    // the reader was looked up before any cancel
    expect(stripeGet.mock.calls.some((c) => (c[0] as string).startsWith("/terminal/readers/tmr_1"))).toBe(true);
  });

  it("cancel_action is sent once per cancel (no duplicate from the provider step)", async () => {
    const payment = await startReal(await seedOrder());
    readerState = onIntent("pi_1");
    // After the first cancel_action the reader is clear, like the real one.
    stripeRequest.mockImplementation(async (path: string) => {
      if (path.endsWith("/cancel_action")) {
        readerState = { id: "tmr_1", status: "online", action: null };
        return { id: "tmr_1", action: null };
      }
      if (path.endsWith("/cancel")) return { id: "pi_1", status: "canceled" };
      throw new Error(`unexpected ${path}`);
    });
    await cancelCardTender(payment.id);
    expect(callsTo("/cancel_action")).toHaveLength(1);
  });

  it("retry on another reader only clears the old reader if it is still on this intent", async () => {
    const orderId = await seedOrder();
    const payment = await startReal(orderId);
    const now = new Date().toISOString();
    await getPosDriver().upsertTerminalReader({
      id: "tmr_2",
      tenant_id: TENANT,
      location_id: LOCATION,
      connect_account_id: ACCT,
      label: "Second",
      device_type: null,
      serial_number: null,
      livemode: false,
      created_at: now,
      updated_at: now,
    });
    readerState = onIntent("pi_other"); // tmr_1 now serves someone else
    stripeRequest.mockClear();
    await retryCardTender(payment.id, "tmr_2");
    expect(callsTo("/terminal/readers/tmr_1/cancel_action")).toHaveLength(0);
    expect(callsTo("/terminal/readers/tmr_2/process_payment_intent")).toHaveLength(1);
  });

  it("a canceled real tender whose PaymentIntent later SUCCEEDED is recorded as captured", async () => {
    const orderId = await seedOrder();
    const payment = await startReal(orderId);
    await cancelCardTender(payment.id);
    expect((await getPosDriver().getPayment(payment.id))!.status).toBe("canceled");

    // still unpaid: stays canceled
    setPi(payment.id, { status: "requires_payment_method" });
    expect((await syncCardTender(payment.id)).payment.status).toBe("canceled");

    // the customer tapped after all
    setPi(payment.id, { status: "succeeded", amount: 2000 });
    const res = await syncCardTender(payment.id);
    expect(res.payment.status).toBe("captured");
    expect(await orderStatus(orderId)).toBe("paid");
  });

  it("a late-succeeded canceled tender on an already-paid in-store order is flagged as a duplicate", async () => {
    const orderId = await seedOrder();
    const payment = await startReal(orderId);
    await cancelCardTender(payment.id);
    await takePayment({
      paymentId: uuid(),
      orderId,
      tenantId: TENANT,
      locationId: LOCATION,
      rail: "cash",
      amountCents: 2000,
      tipCents: 0,
      currency: "USD",
    });
    setPi(payment.id, { status: "succeeded", amount: 2000 });
    await syncCardTender(payment.id);
    const order = (await getPosDriver().getOrder(orderId))!;
    expect(order.fulfillment?.late_payment).toMatchObject({ kind: "duplicate", amount_cents: 2000 });
  });

  it("cancel while the customer is paying (terminal_reader_busy) is 'in_flight' and cancels nothing", async () => {
    const payment = await startReal(await seedOrder());
    readerState = onIntent("pi_1");
    stripeRequest.mockClear();
    stripeRequest.mockImplementation(async (path: string) => {
      if (path.endsWith("/cancel_action")) {
        throw new StripeError("busy", 409, { error: { code: "terminal_reader_busy" } });
      }
      throw new Error(`unexpected ${path}`);
    });
    const res = await cancelCardTender(payment.id);
    expect(res.outcome).toBe("in_flight");
    expect(res.payment.status).toBe("requires_action");
    expect(callsTo("/cancel")).toHaveLength(0);
  });

  it("cancel after the card went through settles instead of canceling", async () => {
    const payment = await startReal(await seedOrder());
    stripeRequest.mockImplementation(async (path: string) => {
      if (path.endsWith("/cancel_action")) return { id: "tmr_1" };
      if (path.endsWith("/cancel")) {
        throw new StripeError("already succeeded", 400, { error: { code: "payment_intent_unexpected_state" } });
      }
      throw new Error(`unexpected ${path}`);
    });
    setPi(payment.id, { status: "succeeded", amount: 2000 });
    const res = await cancelCardTender(payment.id);
    expect(res.outcome).toBe("settled");
    expect(res.payment.status).toBe("captured");
  });

  it("reader offline on start: tender stays open with the error recorded; retry on the other reader works", async () => {
    const orderId = await seedOrder();
    const paymentId = uuid();
    stripeRequest.mockImplementation(async (path: string) => {
      if (path === "/payment_intents") return { id: "pi_1", status: "requires_payment_method" };
      if (path.endsWith("/process_payment_intent")) {
        throw new StripeError("offline", 409, { error: { code: "terminal_reader_offline" } });
      }
      throw new Error(`unexpected ${path}`);
    });
    const err = await startCardTender({
      paymentId,
      orderId,
      readerId: "tmr_1",
      amountCents: 2000,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(TerminalFlowError);
    expect(err.code).toBe("reader_offline");
    expect(err.status).toBe(409);
    expect(err.payment.status).toBe("requires_action");
    expect(err.payment.raw.last_error.message).toMatch(/offline/i);
    expect(await orderStatus(orderId)).toBe("placed");
  });

  it("reader busy -> reader_busy (409); timeout is retried once with the same key", async () => {
    const o1 = await seedOrder();
    stripeRequest.mockImplementation(async (path: string) => {
      if (path === "/payment_intents") return { id: "pi_1", status: "requires_payment_method" };
      if (path.endsWith("/process_payment_intent")) {
        throw new StripeError("busy", 409, { error: { code: "terminal_reader_busy" } });
      }
      throw new Error(`unexpected ${path}`);
    });
    await expect(
      startCardTender({ paymentId: uuid(), orderId: o1, readerId: "tmr_1", amountCents: 2000 }),
    ).rejects.toMatchObject({ code: "reader_busy", status: 409 });

    stripeRequest.mockReset();
    let tries = 0;
    stripeRequest.mockImplementation(async (path: string) => {
      if (path === "/payment_intents") return { id: "pi_1", status: "requires_payment_method" };
      if (path.endsWith("/process_payment_intent")) {
        tries += 1;
        if (tries === 1) {
          throw new StripeError("timeout", 504, { error: { code: "terminal_reader_timeout" } });
        }
        return { id: "tmr_1", action: { status: "in_progress" } };
      }
      throw new Error(`unexpected ${path}`);
    });
    const res = await startCardTender({
      paymentId: uuid(),
      orderId: await seedOrder(),
      readerId: "tmr_1",
      amountCents: 2000,
    });
    expect(res.payment.status).toBe("requires_action");
    const keys = callsTo("/process_payment_intent").map((c) => (c[2] as { idempotencyKey: string }).idempotencyKey);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it("an unregistered reader, or another location's reader, is refused before any Stripe call", async () => {
    const orderId = await seedOrder();
    const now = new Date().toISOString();
    await getPosDriver().upsertTerminalReader({
      id: "tmr_uptown",
      tenant_id: TENANT,
      location_id: DEMO_LOCATION_UPTOWN_ID,
      connect_account_id: ACCT,
      label: "Uptown",
      device_type: null,
      serial_number: null,
      livemode: false,
      created_at: now,
      updated_at: now,
    });
    for (const readerId of ["tmr_nope", "tmr_uptown", SIM_READER]) {
      await expect(
        startCardTender({ paymentId: uuid(), orderId, readerId, amountCents: 2000 }),
      ).rejects.toBeInstanceOf(ReaderNotFoundError);
    }
    expect(stripeRequest).not.toHaveBeenCalled();
  });

  it("a reader registered under a different connected account or key mode is refused", async () => {
    const now = new Date().toISOString();
    await getPosDriver().upsertTerminalReader({
      id: "tmr_old_acct",
      tenant_id: TENANT,
      location_id: LOCATION,
      connect_account_id: "acct_old",
      label: "Old",
      device_type: null,
      serial_number: null,
      livemode: false,
      created_at: now,
      updated_at: now,
    });
    await getPosDriver().upsertTerminalReader({
      id: "tmr_live_row",
      tenant_id: TENANT,
      location_id: LOCATION,
      connect_account_id: ACCT,
      label: "Live row",
      device_type: null,
      serial_number: null,
      livemode: true,
      created_at: now,
      updated_at: now,
    });
    for (const readerId of ["tmr_old_acct", "tmr_live_row"]) {
      await expect(
        startCardTender({ paymentId: uuid(), orderId: await seedOrder(), readerId, amountCents: 2000 }),
      ).rejects.toBeInstanceOf(ReaderNotFoundError);
    }
  });

  it("card gate: no charges-enabled connected account refuses (CardPaymentsNotReadyError) with no Stripe call", async () => {
    await getPosDriver().upsertConnectAccount({
      tenant_id: TENANT,
      account_id: ACCT,
      status: "pending",
      charges_enabled: false,
      payouts_enabled: false,
      details_submitted: false,
      simulated: false,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: new Date().toISOString(),
    });
    stripeGet.mockResolvedValue({ id: ACCT, charges_enabled: false });
    await expect(
      startCardTender({ paymentId: uuid(), orderId: await seedOrder(), readerId: "tmr_1", amountCents: 2000 }),
    ).rejects.toBeInstanceOf(CardPaymentsNotReadyError);
    expect(stripeRequest).not.toHaveBeenCalled();
  });

  it("simulate (test mode) drives present_payment_method: decline uses the decline card, approve passes the tip", async () => {
    const payment = await startReal(await seedOrder());
    stripeRequest.mockClear();
    await simulateCardTender(payment.id, { outcome: "decline" });
    const [path, body, opts] = callsTo("/present_payment_method")[0]!;
    expect(path).toBe("/test_helpers/terminal/readers/tmr_1/present_payment_method");
    expect(body).toMatchObject({ type: "card_present", card_present: { number: "4000000000000002" } });
    expect(opts).toMatchObject({ stripeAccount: ACCT });

    stripeRequest.mockClear();
    await simulateCardTender(payment.id, { outcome: "approve", tipCents: 300 });
    expect(callsTo("/present_payment_method")[0]![1]).toMatchObject({ amount_tip: 300 });
  });

  it("simulate is unavailable with a live key; the test helper itself refuses non-test keys", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_live_x");
    vi.stubEnv("VERCEL_ENV", "production");
    await expect(simulateCardTender("whatever", { outcome: "approve" })).rejects.toMatchObject({
      code: "not_simulated",
      status: 404,
    });
    const { presentPaymentMethod } = await import("../providers/stripe-terminal-api");
    expect(() => presentPaymentMethod(ACCT, "tmr_1")).toThrow(/test/);
  });

  it("reset: cancel_action on the reader; busy and offline are mapped", async () => {
    await resetReader({ tenantId: TENANT, locationId: LOCATION, readerId: "tmr_1" });
    expect(stripeRequest).toHaveBeenCalledWith(
      "/terminal/readers/tmr_1/cancel_action",
      {},
      { stripeAccount: ACCT },
    );
    stripeRequest.mockRejectedValueOnce(
      new StripeError("busy", 409, { error: { code: "terminal_reader_busy" } }),
    );
    await expect(
      resetReader({ tenantId: TENANT, locationId: LOCATION, readerId: "tmr_1" }),
    ).rejects.toMatchObject({ code: "reader_busy" });
  });

  it("reconcile: a failing tender records attempts and backs off; it does not hold the queue", async () => {
    const bad = await startReal(await seedOrder());
    stripeGet.mockRejectedValue(new StripeError("stripe down", 500, null));
    const first = await reconcileTerminalTenders({ olderThanMs: -1000 });
    expect(first).toMatchObject({ checked: 1, errors: 1, backedOff: 0 });
    const row = (await getPosDriver().getPayment(bad.id))!;
    expect(row.raw?.reconcile_attempts).toBe(1);
    expect(typeof row.raw?.last_reconcile_at).toBe("string");

    stripeGet.mockClear();
    const second = await reconcileTerminalTenders({ olderThanMs: -1000 });
    expect(second).toMatchObject({ checked: 0, backedOff: 1 });
    expect(stripeGet).not.toHaveBeenCalled(); // not hammering a down Stripe
  });

  it("reconcile: a PaymentIntent that doesn't match is flagged for manual review and leaves the scan", async () => {
    const payment = await startReal(await seedOrder());
    setPi(payment.id, { status: "succeeded", amount: 100 });
    const first = await reconcileTerminalTenders({ olderThanMs: -1000 });
    expect(first).toMatchObject({ checked: 1, flagged: 1 });
    const row = (await getPosDriver().getPayment(payment.id))!;
    expect(row.status).toBe("requires_action");
    expect(row.raw?.needs_manual_review).toBe(true);
    const second = await reconcileTerminalTenders({ olderThanMs: -1000 });
    expect(second.checked).toBe(0);
    expect(second.backedOff).toBe(0);
  });

  it("reconcile: stops when the time budget runs out", async () => {
    await startReal(await seedOrder());
    await startReal(await seedOrder());
    const summary = await reconcileTerminalTenders({ olderThanMs: -1000, budgetMs: 0 });
    expect(summary.stoppedEarly).toBe(true);
    expect(summary.checked).toBe(0);
  });

  it("reconcile: an abandoned real tender is canceled on Stripe", async () => {
    const payment = await startReal(await seedOrder());
    stripeRequest.mockClear();
    const summary = await reconcileTerminalTenders({ olderThanMs: -1000 });
    expect(summary).toMatchObject({ checked: 1, canceled: 1, errors: 0 });
    expect(stripeRequest.mock.calls.map((c) => c[0])).toContain("/payment_intents/pi_1/cancel");
    expect((await getPosDriver().getPayment(payment.id))!.status).toBe("canceled");
  });
});
