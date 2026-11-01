/**
 * pos-v1-gaps phase 2, review hardening: who may record external money, the hub
 * signature rule, the OTP identity model (customers:verify), consent evidence,
 * reports, and the verifyPin existence oracle. Mock driver; the SQL twin of the
 * customer rules is exercised on PGlite (supabase/tests/phase2_*.sql).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Principal } from "@openpizza/core";
import {
  getPosDriver,
  DEMO_LOCATION_DOWNTOWN_ID,
  DEMO_TENANT_ID,
  type CreateOrderInput,
} from "@/lib/db";
import { resetMockOnline, resetMockOrders, resetMockPayments } from "@/lib/db/mock";
import { handleV1 } from "./v1";
import { memoryOutbox } from "./outbox";

const T0 = new Date("2026-06-04T22:00:00.000Z");
const DOWNTOWN = DEMO_LOCATION_DOWNTOWN_ID;
const FURIO = "80000000-0000-0000-0000-000000000004";
const ID = (n: number) => `d4000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

async function call(
  method: string,
  path: string,
  opts: {
    body?: unknown;
    headers?: Record<string, string>;
    scopes?: string[];
    who?: Partial<Principal>;
  } = {},
) {
  const url = `https://pos.test/api/v1${path}`;
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const req = new Request(url, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const segments = new URL(url).pathname.replace(/^\/api\/v1\/?/, "").split("/").filter(Boolean);
  const principal: Principal = {
    kind: "service",
    id: "hub:test-client",
    tenant_id: DEMO_TENANT_ID,
    location_ids: null,
    scopes: opts.scopes ?? ["*"],
    module: "kiosk",
    ...opts.who,
  };
  const res = await handleV1(req, segments, { principal });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

function held(id: string): CreateOrderInput {
  return {
    id,
    tenant_id: DEMO_TENANT_ID,
    location_id: DOWNTOWN,
    channel: "in_store",
    currency: "USD",
    items: [
      {
        id: `${id.slice(0, 8)}-0000-4000-8000-00000000000a`,
        item_id: "30000000-0000-0000-0000-0000000000ee",
        item_name: "Special",
        size_id: null,
        size_name: "Large",
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
    totals: { subtotal_cents: 1000, discount_cents: 0, taxable_cents: 1000, tax_cents: 0, tip_cents: 0, total_cents: 1000 },
    notes: null,
    status: "draft",
    hold: { reason: "awaiting_payment", expires_at: new Date(Date.now() + 900_000).toISOString() },
    source: { type: "kiosk", channel: "kiosk", module: "kiosk", device_id: "kiosk-1" },
    fulfillment: { type: "pickup", scheduled_for: "asap", promised_at: T0.toISOString() },
  };
}

const cod = (extra: Record<string, unknown> = {}) => ({
  method: "cash",
  processor: "driver",
  processor_ref: null,
  amount_cents: 1000,
  tip_cents: 0,
  status: "captured",
  collection: "cash_on_delivery",
  ...extra,
});
const record = (orderId: string, body: Record<string, unknown>, opts: Parameters<typeof call>[2] = {}) =>
  call("POST", `/orders/${orderId}/payments`, { body, headers: { "idempotency-key": "k" }, ...opts });
const tendersOf = (id: string) => getPosDriver().listPaymentsForOrder(id);
const statusOf = async (id: string) => (await getPosDriver().getOrder(id))?.status;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  resetMockOrders();
  resetMockPayments();
  resetMockOnline();
  memoryOutbox.clear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("recordExternal: who may record money, and how", () => {
  it.each([["kiosk"], ["driver"], ["catering"], ["guests"]])("module %s may record", async (m) => {
    await getPosDriver().createOrder(held(ID(1)));
    const r = await record(ID(1), cod(), { scopes: ["payments:write"], who: { module: m } });
    expect(r.status).toBe(201);
  });

  it("any other module holding payments:write cannot mark an order paid (403, nothing written)", async () => {
    await getPosDriver().createOrder(held(ID(2)));
    for (const m of ["pizza_mcp", "workforce", "backofhouse", "hub"]) {
      const r = await record(ID(2), cod(), { scopes: ["payments:write"], who: { module: m } });
      expect(r.status).toBe(403);
      expect(r.json.details.reason).toBe("module_not_allowed");
    }
    expect(await tendersOf(ID(2))).toHaveLength(0);
    expect(await statusOf(ID(2))).toBe("draft");
  });

  it("a token with no module is refused outside the zero-env dev mode, allowed inside it", async () => {
    await getPosDriver().createOrder(held(ID(3)));
    const dev = await record(ID(3), cod(), { who: { module: null, id: "dev" } });
    expect(dev.status).toBe(201);
    await getPosDriver().createOrder(held(ID(4)));
    vi.stubEnv("OPENPIZZA_HUB_JWKS_URL", "https://hub.test/jwks");
    const prod = await record(ID(4), cod(), { who: { module: null } });
    expect(prod.status).toBe(403);
  });

  it("stores who recorded it (server-derived), never a caller-supplied value", async () => {
    await getPosDriver().createOrder(held(ID(5)));
    const r = await record(
      ID(5),
      { ...cod(), raw: { recorded_by: { principal_id: "forged", module: "forged" } }, recorded_by: "forged" },
      { scopes: ["payments:write"], who: { id: "hub:driver-7", module: "driver" } },
    );
    expect(r.status).toBe(201);
    const stored = (await tendersOf(ID(5)))[0]!;
    expect(stored.raw?.recorded_by).toEqual({ principal_id: "hub:driver-7", module: "driver" });
  });

  it("outside simulated mode a sub without the hub: prefix is refused (recordExternal, setPin)", async () => {
    await getPosDriver().createOrder(held(ID(6)));
    vi.stubEnv("OPENPIZZA_HUB_JWKS_URL", "https://hub.test/jwks");
    const direct = await record(ID(6), cod(), { scopes: ["payments:write"], who: { id: "kiosk-1", module: "driver" } });
    expect(direct.status).toBe(403);
    expect(direct.json.details.reason).toBe("not_hub_signed");
    const viaHub = await record(ID(6), cod(), { scopes: ["payments:write"], who: { id: "hub:driver-1", module: "driver" } });
    expect(viaHub.status).toBe(201);
    const pin = await call("PUT", `/staff/${FURIO}/pin`, {
      body: { pin: "4321" },
      scopes: ["staff:set_pin"],
      who: { id: "some-client" },
    });
    expect(pin.status).toBe(403);
    expect(pin.json.details.reason).toBe("not_hub_signed");
    const ok = await call("PUT", `/staff/${FURIO}/pin`, {
      body: { pin: "4321" },
      scopes: ["staff:set_pin"],
      who: { id: "hub:client" },
    });
    expect(ok.status).toBe(200);
  });
});

describe("customers.upsert: OTP identity (customers:verify)", () => {
  const upsert = (body: Record<string, unknown>, scopes = ["customers:write"]) =>
    call("POST", "/customers", { body, scopes });
  const otp = (body: Record<string, unknown>) =>
    upsert(body, ["customers:write", "customers:verify"]);
  const VICTIM = "victim@example.com";
  const VICTIM_PHONE = "+14155550100";
  const ATTACKER_PHONE = "+14155550199";
  const shopRow = (email: string, phone: string) => ({
    id: crypto.randomUUID(),
    tenant_id: DEMO_TENANT_ID,
    email,
    name: "x",
    phone,
    verified: false,
    created_at: T0.toISOString(),
    updated_at: T0.toISOString(),
  });

  it("verified_contact needs the LITERAL customers:verify scope", async () => {
    for (const scopes of [["customers:write"], ["*"], ["customers:*"], ["*:write"]]) {
      const r = await upsert({ phone: ATTACKER_PHONE, verified_contact: "phone" }, scopes);
      expect(r.status).toBe(403);
    }
    expect((await otp({ phone: ATTACKER_PHONE, verified_contact: "phone" })).status).toBe(200);
    expect((await otp({ email: "a@example.com", verified_contact: "phone" })).status).toBe(422);
    expect((await otp({ phone: ATTACKER_PHONE, verified_contact: "sms" })).status).toBe(422);
  });

  it("A: a shop order with the victim's email and the attacker's phone never makes the victim's row the attacker's identity", async () => {
    const d = getPosDriver();
    // the victim has proven their email by a real OTP
    const v = (await otp({ email: VICTIM, verified_contact: "email" })).json;
    // the attacker places a shop order naming the victim's email and THEIR phone
    await d.upsertCustomer(shopRow(VICTIM, ATTACKER_PHONE));
    expect((await d.getCustomer(v.id))?.phone).toBeNull(); // not planted on a verified row
    // the attacker now passes OTP on their own phone
    const a = await otp({ phone: ATTACKER_PHONE, verified_contact: "phone" });
    expect(a.status).toBe(200);
    expect(a.json.id).not.toBe(v.id);
    expect(a.json.email).toBeNull();

    // the same with an UNVERIFIED victim row (no OTP yet): the planted phone is not verified, so OTP never resolves to it
    const u = (await upsert({ email: "plain@example.com" })).json;
    await d.upsertCustomer(shopRow("plain@example.com", "+14155550177"));
    const a2 = await otp({ phone: "+14155550177", verified_contact: "phone" });
    expect(a2.json.id).not.toBe(u.id);
    expect((await d.getCustomer(u.id))?.phone_verified_at ?? null).toBeNull();
  });

  it("B: {email: attacker, phone: victim} never lets the attacker's email reach the victim's row", async () => {
    const v = (await otp({ phone: VICTIM_PHONE, verified_contact: "phone" })).json;
    const planted = await upsert({ email: "attacker@example.com", phone: VICTIM_PHONE });
    expect(planted.json.id).not.toBe(v.id); // not merged into the victim's row
    expect(planted.json.phone).toBeNull(); // the victim's phone is not planted on the attacker's row
    const victimRow = (await call("GET", `/customers/${v.id}`, { scopes: ["customers:read"] })).json;
    expect(victimRow.email).toBeNull();
    const a = await otp({ email: "attacker@example.com", verified_contact: "email" });
    expect(a.json.id).toBe(planted.json.id);
    expect(a.json.id).not.toBe(v.id);
    // the victim passes OTP on their phone and gets their own verified row back
    expect((await otp({ phone: VICTIM_PHONE, verified_contact: "phone" })).json.id).toBe(v.id);
  });

  it("phone OTP resolves only a verified row; email OTP uses only the proven contact", async () => {
    const p1 = await otp({ phone: "+14155550123", verified_contact: "phone" });
    expect(p1.json.verified).toBe(true);
    const again = await otp({ phone: "+14155550123", verified_contact: "phone" });
    expect(again.json.id).toBe(p1.json.id);
    const e = await otp({ email: "Who@Example.com", verified_contact: "email", phone: "+14155550999" });
    expect(e.json.email).toBe("who@example.com");
    expect(e.json.phone).toBeNull();
    expect(e.json.verified).toBe(true);
  });

  it("ordinary upsert and the shop path never set verified state", async () => {
    const d = getPosDriver();
    const a = await upsert({ email: "o@example.com", phone: "+14155550888" });
    const row = (await d.getCustomer(a.json.id))!;
    expect(row.email_verified_at ?? null).toBeNull();
    expect(row.phone_verified_at ?? null).toBeNull();
    const s = await d.upsertCustomer({
      ...row,
      verified: true,
      email_verified_at: "2026-01-01T00:00:00Z",
      phone_verified_at: "2026-01-01T00:00:00Z",
    });
    expect(s.email_verified_at ?? null).toBeNull();
    expect(s.phone_verified_at ?? null).toBeNull();
    const o = await otp({ phone: "+14155550888", verified_contact: "phone" });
    expect(o.json.id).not.toBe(a.json.id);
  });

  it("a future consent `at` is clamped to now; consent for a contact that was not attached is dropped", async () => {
    const future = "2099-01-01T00:00:00Z";
    const a = await upsert({
      email: "c@example.com",
      phone: "+14155550444",
      marketing: { sms: { opt_in: true, at: future }, email: { opt_in: true, at: future } },
    });
    expect(a.json.marketing.sms.at).toBe(T0.toISOString());
    expect(a.json.marketing.email.at).toBe(T0.toISOString());
    // the phone belongs to someone else (another email): it is not attached, so its SMS consent is not applied
    const b = await upsert({
      email: "d@example.com",
      phone: "+14155550444",
      marketing: { sms: { opt_in: true, at: "2026-01-01T00:00:00Z" } },
    });
    expect(b.json.id).not.toBe(a.json.id);
    expect(b.json.phone).toBeNull();
    expect(b.json.marketing.sms.opt_in).toBe(false);
    expect((await call("GET", `/customers/${a.json.id}`, { scopes: ["customers:read"] })).json.marketing.sms.opt_in).toBe(true);
  });

  it("a national-format phone stored from checkout is reported as E.164 and found by lookup", async () => {
    const d = getPosDriver();
    const c = await d.upsertCustomer(shopRow("nat@example.com", "415-555-0199"));
    const r = await call("GET", `/customers/${c.id}`, { scopes: ["customers:read"] });
    expect(r.json.phone).toBe("+14155550199");
    expect((await call("GET", "/customers/lookup?phone=%2B14155550199", { scopes: ["customers:read"] })).json.id).toBe(c.id);
  });
});

describe("per-contact verification in the contract", () => {
  const upsert = (body: Record<string, unknown>, scopes = ["customers:write"]) =>
    call("POST", "/customers", { body, scopes });
  const otp = (body: Record<string, unknown>) =>
    upsert(body, ["customers:write", "customers:verify"]);

  it("reports verification per contact, never row-wide, and never from the legacy column", async () => {
    const d = getPosDriver();
    // email proven by OTP, then a phone gets attached by an ordinary upsert
    const v = (await otp({ email: "v@example.com", verified_contact: "email" })).json;
    expect(v).toMatchObject({ verified: true, email_verified: true, phone_verified: false });
    // the row is frozen, so a planted phone is refused ...
    const planted = await upsert({ email: "v@example.com", phone: "+14155550999" });
    expect(planted.json.phone).toBeNull();
    // ... and on an UNVERIFIED email row the planted phone is reported unproven,
    // and the row is NOT verified as a whole
    await upsert({ email: "u@example.com" });
    const u = await upsert({ email: "u@example.com", phone: "+14155550998" });
    expect(u.json).toMatchObject({ verified: false, email_verified: false, phone_verified: false });
    // proving the email later does not vouch for the planted phone
    const e = await otp({ email: "u@example.com", verified_contact: "email" });
    expect(e.json.phone).toBe("+14155550998");
    expect(e.json).toMatchObject({ email_verified: true, phone_verified: false, verified: false });
    // the legacy column (the magic-link stub) cannot assert anything
    const row = (await d.getCustomer(e.json.id))!;
    await d.upsertCustomer({ ...row, verified: true });
    const again = await call("GET", `/customers/${e.json.id}`, { scopes: ["customers:read"] });
    expect(again.json).toMatchObject({ email_verified: true, phone_verified: false, verified: false });
  });

  it("an email offered to a phone-only row creates another customer (scenario B residual)", async () => {
    const p = (await otp({ phone: "+14155550123", verified_contact: "phone" })).json;
    const a = await upsert({ email: "late@example.com", phone: "+14155550123" });
    expect(a.json.id).not.toBe(p.id);
    expect(a.json.phone).toBeNull();
    const unverified = (await upsert({ phone: "+14155550124" })).json;
    const b = await upsert({ email: "late2@example.com", phone: "+14155550124" });
    expect(b.json.id).not.toBe(unverified.id);
    expect((await call("GET", `/customers/${unverified.id}`, { scopes: ["customers:read"] })).json.email).toBeNull();
  });

  it("national phones are only read as +1 for a US/CA tenant", async () => {
    const { toContractCustomer } = await import("./mappers");
    const row = {
      id: "c", tenant_id: DEMO_TENANT_ID, email: null, phone: "415-555-0199", name: null, verified: false,
      created_at: T0.toISOString(), updated_at: T0.toISOString(),
    };
    const stats = { order_count: 0, last_order_at: null, lifetime_spend_cents: 0 };
    expect(toContractCustomer(row, stats, "US").phone).toBe("+14155550199");
    expect(toContractCustomer(row, stats, "GB").phone).toBeNull();
    expect(toContractCustomer(row, stats).phone).toBeNull();
    expect(toContractCustomer({ ...row, phone: "+442071838750" }, stats, "GB").phone).toBe("+442071838750");
  });
});

describe("reports and the verifyPin oracle", () => {
  it("external tenders are reported by their own method, not as card", async () => {
    const { mixKey, railFamily, railLabel } = await import("@/lib/reports");
    const cash = mixKey({ rail: "external", method: "cash", processor: "driver" });
    const card = mixKey({ rail: "external", method: "card", processor: "stripe_terminal" });
    const gift = mixKey({ rail: "external", method: "gift_card", processor: "guests" });
    expect([railFamily(cash), railFamily(card), railFamily(gift)]).toEqual(["cash", "card", "other"]);
    expect(railLabel(cash)).toBe("External (cash · driver)");
    expect(mixKey({ rail: "stripe_online", method: null, processor: null })).toBe("stripe_online");
    const { tenderMethod } = await import("./mappers");
    expect(tenderMethod({ rail: "external", method: "cash" })).toBe("cash");
    expect(tenderMethod({ rail: "stripe_terminal", method: null })).toBe("card");
  });

  it("an unknown id locks like a real one (no existence oracle)", async () => {
    const body = { location_id: DOWNTOWN, staff_id: ID(97), pin: "0000" };
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) {
      codes.push((await call("POST", "/staff/verify-pin", { body, scopes: ["staff:pin_verify"] })).status);
    }
    expect(codes).toEqual([403, 403, 403, 403, 403, 429, 429]);
  });
});
