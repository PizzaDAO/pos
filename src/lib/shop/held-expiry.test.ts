/**
 * Held-order expiry (`expireHeldOrders`) and the held-order settlement path
 * (D10), against the zero-env mock driver with the Stripe transport mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getPosDriver,
  type CreateOrderInput,
  type Payment,
} from "@/lib/db";
import type { ConnectAccount } from "@/lib/db/payment-types";
import { resetMockOrders, resetMockPayments } from "@/lib/db/mock";

const stripeRequest = vi.fn();
const stripeGet = vi.fn();
vi.mock("@/lib/payments/providers/stripe-client", async (orig) => ({
  ...(await orig<typeof import("@/lib/payments/providers/stripe-client")>()),
  stripeRequest: (...a: unknown[]) => stripeRequest(...a),
  stripeGet: (...a: unknown[]) => stripeGet(...a),
}));

import { expireHeldOrders } from "./lifecycle";
import { applyRailStatus } from "@/lib/payments/service";

const TENANT = "10000000-0000-0000-0000-000000000001";
const LOCATION = "10000000-0000-0000-0000-000000000101";
const ACCT = "acct_test_held";
const NOW = new Date("2026-06-04T22:00:00.000Z");
const PAST = new Date(NOW.getTime() - 60_000).toISOString();
const FUTURE = new Date(NOW.getTime() + 600_000).toISOString();

let seq = 0;

async function seedOrder(opts: {
  status?: "draft" | "placed";
  hold?: { reason: string; expires_at: string } | null;
  mode?: "live" | "test" | "sim" | null;
  scheduledFor?: string;
}): Promise<string> {
  seq += 1;
  const id = `held-order-${seq}`;
  const input: CreateOrderInput = {
    id,
    tenant_id: TENANT,
    location_id: LOCATION,
    channel: "online_pickup",
    currency: "USD",
    items: [],
    discount_cents: 0,
    totals: {
      subtotal_cents: 2000,
      discount_cents: 0,
      taxable_cents: 2000,
      tax_cents: 0,
      tip_cents: 0,
      total_cents: 2000,
    },
    notes: null,
    status: opts.status ?? "draft",
    hold: opts.hold === undefined ? { reason: "awaiting_payment", expires_at: PAST } : opts.hold,
    fulfillment: {
      type: "pickup",
      scheduled_for: opts.scheduledFor ?? "asap",
      promised_at: "2026-06-04T18:15:00.000Z",
      ...(opts.mode === null ? {} : { checkout_mode: opts.mode ?? "sim" }),
    },
  };
  await getPosDriver().createOrder(input);
  return id;
}

async function seedTender(orderId: string, over: Partial<Payment> = {}): Promise<Payment> {
  seq += 1;
  return getPosDriver().upsertPayment({
    id: `held-tender-${seq}`,
    order_id: orderId,
    tenant_id: TENANT,
    location_id: LOCATION,
    rail: "stripe_online",
    status: "requires_action",
    amount_cents: 2000,
    tip_cents: 0,
    application_fee_cents: 0,
    currency: "USD",
    charge_id: null,
    connect_account_id: null,
    crypto_tx_hash: null,
    crypto_chain: null,
    cash_tendered_cents: null,
    cash_change_cents: null,
    refunded_cents: 0,
    simulated: true,
    raw: { checkout_session_id: `cs_sim_${seq}` },
    created_at: "2026-06-04T21:00:00.000Z",
    updated_at: "2026-06-04T21:00:00.000Z",
    ...over,
  });
}

const status = async (id: string) => (await getPosDriver().getOrder(id))!.status;

beforeEach(() => {
  resetMockOrders();
  resetMockPayments();
  stripeRequest.mockReset();
  stripeGet.mockReset();
  vi.unstubAllEnvs();
  vi.stubEnv("STRIPE_SECRET_KEY", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("expireHeldOrders", () => {
  it("voids an expired held order and closes its simulated tender", async () => {
    const id = await seedOrder({});
    const t = await seedTender(id);
    const out = await expireHeldOrders(NOW);
    expect(out).toMatchObject({ checked: 1, voided: 1, errors: 0 });
    expect(await status(id)).toBe("voided");
    expect((await getPosDriver().getPayment(t.id))!.status).toBe("canceled");
  });

  it("leaves a hold that has not expired alone", async () => {
    const id = await seedOrder({ hold: { reason: "awaiting_payment", expires_at: FUTURE } });
    expect((await expireHeldOrders(NOW)).checked).toBe(0);
    expect(await status(id)).toBe("draft");
  });

  it("never touches a parked in-store draft (no hold) or a manual hold", async () => {
    const parked = await seedOrder({ hold: null });
    const manual = await seedOrder({ hold: { reason: "manual", expires_at: PAST } });
    const out = await expireHeldOrders(NOW);
    expect(out.checked).toBe(0);
    for (const id of [parked, manual]) expect(await status(id)).toBe("draft");
  });

  it("voids an UNPAID scheduled hold once it lapses (a 30-day hold, swept on day 40)", async () => {
    const day = 86_400_000;
    const created = new Date(NOW.getTime());
    const id = await seedOrder({
      hold: { reason: "scheduled", expires_at: new Date(created.getTime() + 30 * day).toISOString() },
    });
    // Day 29: still held. Day 40: gone.
    expect((await expireHeldOrders(new Date(created.getTime() + 29 * day))).checked).toBe(0);
    expect(await status(id)).toBe("draft");
    const out = await expireHeldOrders(new Date(created.getTime() + 40 * day));
    expect(out).toMatchObject({ checked: 1, voided: 1 });
    expect(await status(id)).toBe("voided");
  });

  it("never voids a PAID scheduled hold; alerts staff once after the grace", async () => {
    const { SCHEDULED_PAID_GRACE_MS } = await import("./lifecycle");
    const id = await seedOrder({ hold: { reason: "scheduled", expires_at: PAST } });
    await seedTender(id, { status: "captured", simulated: true });
    // Inside the grace: left alone, no alert.
    let out = await expireHeldOrders(NOW);
    expect(out).toMatchObject({ voided: 0, stranded: 0 });
    expect(await status(id)).toBe("draft");
    // Past the grace: one alert, order still held (and releasable).
    const later = new Date(Date.parse(PAST) + SCHEDULED_PAID_GRACE_MS + 1000);
    out = await expireHeldOrders(later);
    expect(out).toMatchObject({ voided: 0, stranded: 1 });
    // Admin-visible: it is in the "Late payments" list with the PAID wording.
    expect((await getPosDriver().getOrder(id))!.fulfillment?.late_payment).toMatchObject({
      kind: "scheduled",
      detail: "paid",
    });
    out = await expireHeldOrders(later);
    expect(out.stranded).toBe(0);
    expect(await status(id)).toBe("draft");
  });

  it("a PARTLY paid scheduled hold is flagged as partial, never voided", async () => {
    const { SCHEDULED_PAID_GRACE_MS } = await import("./lifecycle");
    const id = await seedOrder({ hold: { reason: "scheduled", expires_at: PAST } });
    await seedTender(id, { status: "captured", simulated: true, amount_cents: 500 });
    const later = new Date(Date.parse(PAST) + SCHEDULED_PAID_GRACE_MS + 1000);
    expect(await expireHeldOrders(later)).toMatchObject({ voided: 0, stranded: 1 });
    expect((await getPosDriver().getOrder(id))!.fulfillment?.late_payment).toMatchObject({
      kind: "scheduled",
      detail: "partial",
      amount_cents: 500,
    });
    expect(await status(id)).toBe("draft");
  });

  it("a scheduled hold with an invoice still owed is NEVER voided; a human is flagged after the grace", async () => {
    const { SCHEDULED_PAID_GRACE_MS } = await import("./lifecycle");
    const id = await seedOrder({ hold: { reason: "scheduled", expires_at: PAST } });
    await seedTender(id, { rail: "external", status: "pending", simulated: false, raw: null });
    let out = await expireHeldOrders(NOW);
    expect(out).toMatchObject({ voided: 0, stranded: 0 });
    expect(await status(id)).toBe("draft");
    const later = new Date(Date.parse(PAST) + SCHEDULED_PAID_GRACE_MS + 1000);
    out = await expireHeldOrders(later);
    expect(out).toMatchObject({ voided: 0, stranded: 1 });
    expect((await getPosDriver().getOrder(id))!.fulfillment?.late_payment).toMatchObject({
      kind: "scheduled",
      detail: "invoice_pending",
      amount_cents: 2000,
    });
    expect(await status(id)).toBe("draft");
  });

  it("skips an order stamped by another deployment mode", async () => {
    const live = await seedOrder({ mode: "live" });
    const test = await seedOrder({ mode: "test" });
    expect((await expireHeldOrders(NOW)).checked).toBe(0);
    expect(await status(live)).toBe("draft");
    expect(await status(test)).toBe("draft");
  });

  it("sweeps a legacy order with no mode stamp", async () => {
    const id = await seedOrder({ mode: null });
    expect((await expireHeldOrders(NOW)).voided).toBe(1);
    expect(await status(id)).toBe("voided");
  });

  it("an order paid at the last look is finalized, not voided", async () => {
    const id = await seedOrder({});
    const t = await seedTender(id);
    // Settled between the list and the sweep (webhook): the tender is captured
    // but the order is still draft, e.g. a crashed settlement.
    await getPosDriver().upsertPayment({ ...t, status: "captured" });
    const out = await expireHeldOrders(NOW);
    expect(out.voided).toBe(0);
    expect(await status(id)).not.toBe("voided");
  });

  it("a real Checkout session that Stripe will not expire (payer mid-payment) leaves the order held", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://localhost:54321");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "k");
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_held");
    const acct: ConnectAccount = {
      tenant_id: TENANT,
      account_id: ACCT,
      status: "connected",
      charges_enabled: true,
      payouts_enabled: true,
      details_submitted: true,
      simulated: false,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    };
    await getPosDriver().upsertConnectAccount(acct);
    const id = await seedOrder({ mode: "test" });
    const t = await seedTender(id, {
      simulated: false,
      connect_account_id: ACCT,
      raw: { checkout_session_id: "cs_test_open", livemode: false },
    });
    stripeRequest.mockRejectedValue(new Error("cannot expire"));
    stripeGet.mockResolvedValue({ id: "cs_test_open", status: "open" });
    const out = await expireHeldOrders(NOW);
    expect(out.voided).toBe(0);
    expect(out.errors).toBe(1);
    expect(await status(id)).toBe("draft");
    expect((await getPosDriver().getPayment(t.id))!.status).toBe("requires_action");
    // Once Stripe lets go of it, the next sweep voids.
    stripeRequest.mockReset();
    stripeRequest.mockResolvedValue({ id: "cs_test_open", status: "expired" });
    expect((await expireHeldOrders(NOW)).voided).toBe(1);
    expect(await status(id)).toBe("voided");
  });
});

describe("foreign-mode holds (F4) and the sweep budget (F10)", () => {
  const LONG_AGO = new Date(NOW.getTime() - 25 * 3_600_000).toISOString();

  it("sweeps a foreign-mode hold with no real tender once it is past the long grace", async () => {
    const id = await seedOrder({
      mode: "live",
      hold: { reason: "awaiting_payment", expires_at: LONG_AGO },
    });
    const out = await expireHeldOrders(NOW);
    expect(out.foreignSwept).toBe(1);
    expect(await status(id)).toBe("voided");
  });

  it("leaves a recently expired foreign-mode hold to its own mode's sweeper", async () => {
    const id = await seedOrder({ mode: "live" });
    const out = await expireHeldOrders(NOW);
    expect(out.foreignSwept).toBe(0);
    expect(await status(id)).toBe("draft");
  });

  it("alerts once and parks a foreign-mode hold that holds a real tender", async () => {
    const id = await seedOrder({
      mode: "live",
      hold: { reason: "awaiting_payment", expires_at: LONG_AGO },
    });
    await seedTender(id, {
      simulated: false,
      connect_account_id: ACCT,
      raw: { checkout_session_id: "cs_live_x", livemode: true },
    });
    const first = await expireHeldOrders(NOW);
    expect(first.foreignAlerted).toBe(1);
    expect(await status(id)).toBe("draft");
    expect((await expireHeldOrders(NOW)).foreignAlerted).toBe(0);
  });

  it("stops at its time budget", async () => {
    const id = await seedOrder({});
    const out = await expireHeldOrders(NOW, { budgetMs: -1 });
    expect(out.checked).toBe(0);
    expect(await status(id)).toBe("draft");
  });
});

describe("a held order settled through finalizeOnlinePayment (D10)", () => {
  it("recomputes an ASAP promised_at from payment time and stamps paid/finalized", async () => {
    const id = await seedOrder({ hold: { reason: "awaiting_payment", expires_at: FUTURE } });
    const t = await seedTender(id);
    await applyRailStatus(t.id, "captured", { chargeId: "sim_pi_1" });
    const o = (await getPosDriver().getOrder(id))!;
    expect(o.status).toBe("paid");
    expect(o.hold).toBeNull();
    expect(o.fulfillment?.paid_at).toBeTruthy();
    expect(o.fulfillment?.finalized_at).toBeTruthy();
    expect(o.fulfillment?.promised_at).not.toBe("2026-06-04T18:15:00.000Z");
  });

  it("a scheduled order keeps its slot", async () => {
    const slot = "2026-06-04T23:30:00.000Z";
    const id = await seedOrder({
      hold: { reason: "awaiting_payment", expires_at: FUTURE },
      scheduledFor: slot,
    });
    const t = await seedTender(id);
    await applyRailStatus(t.id, "captured", { chargeId: "sim_pi_2" });
    expect((await getPosDriver().getOrder(id))!.fulfillment?.promised_at).toBe(
      "2026-06-04T18:15:00.000Z",
    );
  });

  it("an in-store draft with no hold keeps the plain draft -> paid move", async () => {
    const id = await seedOrder({ hold: null });
    const t = await seedTender(id, { rail: "cash", raw: null, charge_id: null });
    await applyRailStatus(t.id, "captured");
    const o = (await getPosDriver().getOrder(id))!;
    expect(o.status).toBe("paid");
    expect(o.fulfillment?.paid_at).toBeUndefined();
  });

  it("charge_id is filled once and never overwritten", async () => {
    const id = await seedOrder({ hold: { reason: "awaiting_payment", expires_at: FUTURE } });
    const t = await seedTender(id);
    await applyRailStatus(t.id, "requires_action", { chargeId: "pi_first" });
    await applyRailStatus(t.id, "requires_action", { chargeId: "pi_second", raw: { x: 1 } });
    expect((await getPosDriver().getPayment(t.id))!.charge_id).toBe("pi_first");
  });
});
