import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getPosDriver } from "@/lib/db";
import {
  DEMO_LOCATION_DOWNTOWN_ID,
  DEMO_LOCATION_UPTOWN_ID,
  DEMO_TENANT_ID,
} from "@/lib/db/seed-data";
import { resetMockPayments } from "@/lib/db/mock";

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
import { cardReaderMode } from "../env";
import { CardPaymentsNotReadyError } from "../connect";
import {
  TerminalAddressRequiredError,
  ensureTerminalLocation,
  getTerminalTipMode,
  parseTerminalAddress,
  tipPercentagesFromBps,
} from "./locations";
import {
  getCardReadiness,
  isInStoreCardReady,
  listReadersWithStatus,
  locationHasReader,
  registerTerminalReader,
  removeTerminalReader,
  ReaderNotFoundError,
  ReaderRegistrationError,
  simulatedReaderId,
} from "./readers";

const TENANT = DEMO_TENANT_ID;
const LOCATION = DEMO_LOCATION_DOWNTOWN_ID;
const ACCT = "acct_real_9";
const ADDRESS = {
  line1: "1 Main St",
  city: "Austin",
  state: "TX",
  postal_code: "78701",
  country: "US",
};

function goReal(key = "sk_test_x") {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://localhost:54321");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "k");
  vi.stubEnv("STRIPE_SECRET_KEY", key);
}

async function connect(accountId = ACCT, chargesEnabled = true) {
  await getPosDriver().upsertConnectAccount({
    tenant_id: TENANT,
    account_id: accountId,
    status: chargesEnabled ? "connected" : "pending",
    charges_enabled: chargesEnabled,
    payouts_enabled: chargesEnabled,
    details_submitted: true,
    simulated: false,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: new Date().toISOString(),
  });
}

function stubStripe() {
  let n = 0;
  stripeRequest.mockImplementation(async (path: string) => {
    n += 1;
    if (path === "/terminal/locations") return { id: `tml_${n}` };
    if (path.startsWith("/terminal/locations/")) return { id: path.split("/").pop() };
    if (path === "/terminal/configurations") return { id: `tmc_${n}` };
    if (path.startsWith("/terminal/configurations/")) return { id: path.split("/").pop() };
    if (path === "/terminal/readers") {
      return {
        id: "tmr_new",
        label: "Counter",
        device_type: "stripe_s700",
        serial_number: "SN1",
        status: "online",
      };
    }
    throw new Error(`unexpected POST ${path}`);
  });
}

beforeEach(async () => {
  resetMockPayments();
  stripeRequest.mockReset();
  stripeGet.mockReset();
  stripeDelete.mockReset();
  vi.unstubAllEnvs();
  getPosDriver();
});

afterEach(() => vi.unstubAllEnvs());

describe("cardReaderMode", () => {
  it("matrix: no key / training / test key / live key / restricted keys", () => {
    expect(cardReaderMode()).toBe("simulated");

    // The mock driver always forces simulated; go "live driver" for the rest.
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://localhost:54321");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "k");
    expect(cardReaderMode()).toBe("simulated"); // no Stripe key

    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
    expect(cardReaderMode()).toBe("stripe_test");
    vi.stubEnv("STRIPE_SECRET_KEY", "rk_test_x");
    expect(cardReaderMode()).toBe("stripe_test");
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_live_x");
    expect(cardReaderMode()).toBe("stripe_live");
    vi.stubEnv("STRIPE_SECRET_KEY", "rk_live_x");
    expect(cardReaderMode()).toBe("stripe_live");

    // Training mode wins over any key (T8): never a real reader or charge.
    vi.stubEnv("TRAINING_MODE", "1");
    expect(cardReaderMode()).toBe("simulated");
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
    expect(cardReaderMode()).toBe("simulated");
  });

  it("the mock driver is always simulated, whatever key is set", () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_live_x");
    expect(cardReaderMode()).toBe("simulated");
  });
});

describe("address + tip presets", () => {
  it("parseTerminalAddress validates and normalizes a US address", () => {
    const ok = parseTerminalAddress({ ...ADDRESS, state: "tx", line2: " Ste 2 " });
    expect(ok).toEqual({
      ok: true,
      address: { ...ADDRESS, line2: "Ste 2" },
    });
    for (const bad of [
      null,
      {},
      { ...ADDRESS, line1: "" },
      { ...ADDRESS, city: "" },
      { ...ADDRESS, state: "Texas" },
      { ...ADDRESS, state: "ZZ" },
      { ...ADDRESS, postal_code: "7870" },
      { ...ADDRESS, postal_code: "ABCDE" },
      { ...ADDRESS, country: "CA" },
    ]) {
      expect(parseTerminalAddress(bad).ok).toBe(false);
    }
    expect(parseTerminalAddress({ ...ADDRESS, postal_code: "78701-1234" }).ok).toBe(true);
  });

  it("tipPercentagesFromBps: whole percents, unique, ascending, max 3", () => {
    expect(tipPercentagesFromBps([2000, 1500, 1800])).toEqual([15, 18, 20]);
    expect(tipPercentagesFromBps([1500, 1500, 1550, 2500, 3000])).toEqual([15, 16, 25]);
    expect(tipPercentagesFromBps([0, 20, 20000])).toEqual([]);
    expect(tipPercentagesFromBps([])).toEqual([]);
  });
});

describe("ensureTerminalLocation", () => {
  it("simulated: stores the tip mode with a sim id and never calls Stripe", async () => {
    const row = await ensureTerminalLocation({
      tenantId: TENANT,
      locationId: LOCATION,
      tipMode: "none",
    });
    expect(row.tip_mode).toBe("none");
    expect(row.stripe_location_id).toBe(`tml_sim_${LOCATION}`);
    expect(await getTerminalTipMode(LOCATION)).toBe("none");
    expect(await getTerminalTipMode(DEMO_LOCATION_UPTOWN_ID)).toBe("reader"); // default
    expect(stripeRequest).not.toHaveBeenCalled();
  });

  it("an unknown location (or another tenant's) is refused", async () => {
    await expect(
      ensureTerminalLocation({ tenantId: TENANT, locationId: "10000000-0000-0000-0000-00000000ffff" }),
    ).rejects.toThrow(/not found/i);
  });

  it("real: creates the tipping Configuration then the Location on the connected account; a repeat makes no Stripe call", async () => {
    goReal();
    await connect();
    stubStripe();
    const row = await ensureTerminalLocation({
      tenantId: TENANT,
      locationId: LOCATION,
      address: ADDRESS,
    });
    expect(row.connect_account_id).toBe(ACCT);
    expect(row.livemode).toBe(false);
    expect(row.stripe_location_id).toMatch(/^tml_/);
    expect(row.configuration_id).toMatch(/^tmc_/);

    const [cfgPath, cfgBody, cfgOpts] = stripeRequest.mock.calls[0]!;
    expect(cfgPath).toBe("/terminal/configurations");
    expect(cfgBody).toMatchObject({ tipping: { usd: { percentages: [15, 18, 20] } } });
    expect(cfgOpts).toEqual({ stripeAccount: ACCT });
    const [locPath, locBody, locOpts] = stripeRequest.mock.calls[1]!;
    expect(locPath).toBe("/terminal/locations");
    expect(locBody).toMatchObject({
      address: ADDRESS,
      configuration_overrides: row.configuration_id,
    });
    expect(locOpts).toEqual({ stripeAccount: ACCT });

    stripeRequest.mockClear();
    // Same inputs again: config and Location are re-synced (presets/address may
    // have changed) but no NEW Location or Configuration is created.
    await ensureTerminalLocation({ tenantId: TENANT, locationId: LOCATION });
    const paths = stripeRequest.mock.calls.map((c) => c[0] as string);
    expect(paths).toEqual([
      `/terminal/configurations/${row.configuration_id}`,
      `/terminal/locations/${row.stripe_location_id}`,
    ]);
  });

  it("simulated mode saves tip mode + address but NEVER overwrites real Stripe ids", async () => {
    goReal();
    await connect();
    stubStripe();
    const real = await ensureTerminalLocation({ tenantId: TENANT, locationId: LOCATION, address: ADDRESS });

    vi.unstubAllEnvs(); // back to simulated (no key)
    stripeRequest.mockClear();
    const sim = await ensureTerminalLocation({
      tenantId: TENANT,
      locationId: LOCATION,
      tipMode: "pos",
      address: { ...ADDRESS, line1: "9 New St" },
    });
    expect(sim.tip_mode).toBe("pos");
    expect(sim.address?.line1).toBe("9 New St");
    expect(sim.connect_account_id).toBe(ACCT);
    expect(sim.stripe_location_id).toBe(real.stripe_location_id);
    expect(sim.configuration_id).toBe(real.configuration_id);
    expect(stripeRequest).not.toHaveBeenCalled();

    // Back in test mode the real Location is reused (not recreated) and gets the new address.
    goReal();
    stripeRequest.mockClear();
    const again = await ensureTerminalLocation({ tenantId: TENANT, locationId: LOCATION });
    expect(again.stripe_location_id).toBe(real.stripe_location_id);
    const locUpdate = stripeRequest.mock.calls.find(
      (c) => c[0] === `/terminal/locations/${real.stripe_location_id}`,
    );
    expect(locUpdate![1]).toMatchObject({ address: { line1: "9 New St" } });
    expect(stripeRequest.mock.calls.map((c) => c[0])).not.toContain("/terminal/locations");
  });

  it("real: a changed address updates the Location; a changed account recreates both", async () => {
    goReal();
    await connect();
    stubStripe();
    const first = await ensureTerminalLocation({ tenantId: TENANT, locationId: LOCATION, address: ADDRESS });

    stripeRequest.mockClear();
    await ensureTerminalLocation({
      tenantId: TENANT,
      locationId: LOCATION,
      address: { ...ADDRESS, line1: "2 Elm St" },
    });
    expect(stripeRequest.mock.calls.map((c) => c[0])).toContain(
      `/terminal/locations/${first.stripe_location_id}`,
    );

    stripeRequest.mockClear();
    await connect("acct_reonboarded");
    const moved = await ensureTerminalLocation({ tenantId: TENANT, locationId: LOCATION });
    const paths = stripeRequest.mock.calls.map((c) => c[0]);
    expect(paths).toContain("/terminal/locations");
    expect(paths).toContain("/terminal/configurations");
    expect(moved.connect_account_id).toBe("acct_reonboarded");
    expect(moved.stripe_location_id).not.toBe(first.stripe_location_id);
    for (const c of stripeRequest.mock.calls) expect(c[2]).toEqual({ stripeAccount: "acct_reonboarded" });
  });

  it("real: a test<->live flip recreates the Location (row livemode must match)", async () => {
    goReal();
    await connect();
    stubStripe();
    const test = await ensureTerminalLocation({ tenantId: TENANT, locationId: LOCATION, address: ADDRESS });
    expect(test.livemode).toBe(false);

    goReal("sk_live_x");
    vi.stubEnv("VERCEL_ENV", "production");
    stripeRequest.mockClear();
    const live = await ensureTerminalLocation({ tenantId: TENANT, locationId: LOCATION });
    expect(live.livemode).toBe(true);
    expect(live.stripe_location_id).not.toBe(test.stripe_location_id);
    expect(stripeRequest.mock.calls.map((c) => c[0])).toContain("/terminal/locations");
  });

  it("real: no address -> TerminalAddressRequiredError; no charges-enabled account -> not ready; no Stripe call either way", async () => {
    goReal();
    await connect();
    await expect(
      ensureTerminalLocation({ tenantId: TENANT, locationId: LOCATION }),
    ).rejects.toBeInstanceOf(TerminalAddressRequiredError);

    await connect(ACCT, false);
    stripeGet.mockResolvedValue({ id: ACCT, charges_enabled: false });
    await expect(
      ensureTerminalLocation({ tenantId: TENANT, locationId: LOCATION, address: ADDRESS }),
    ).rejects.toBeInstanceOf(CardPaymentsNotReadyError);
    expect(stripeRequest).not.toHaveBeenCalled();
  });

  it("real: a live key outside production is refused (live-key guard)", async () => {
    goReal("sk_live_x");
    await connect();
    await expect(
      ensureTerminalLocation({ tenantId: TENANT, locationId: LOCATION, address: ADDRESS }),
    ).rejects.toThrow(/live Stripe key/i);
    expect(stripeRequest).not.toHaveBeenCalled();
  });
});

describe("readers", () => {
  it("simulated: one virtual reader per location, always ready, registration refused", async () => {
    const readers = await listReadersWithStatus(TENANT, LOCATION);
    expect(readers).toHaveLength(1);
    expect(readers[0]).toMatchObject({
      id: simulatedReaderId(LOCATION),
      status: "online",
      simulated: true,
    });
    expect(await locationHasReader(TENANT, LOCATION)).toBe(true);
    expect(await isInStoreCardReady(TENANT, LOCATION)).toBe(true);
    expect(await getCardReadiness(TENANT, LOCATION)).toMatchObject({
      mode: "simulated",
      ready: true,
      notReadyReason: null,
    });
    await expect(
      registerTerminalReader({
        tenantId: TENANT,
        locationId: LOCATION,
        registrationCode: "apple-orange-banana",
        label: "x",
      }),
    ).rejects.toBeInstanceOf(ReaderRegistrationError);
  });

  it("real: card shows only when card-ready AND the location has a registered reader", async () => {
    goReal();
    await connect();
    stubStripe();
    // Connected but no reader.
    expect(await isInStoreCardReady(TENANT, LOCATION)).toBe(false);
    expect(await getCardReadiness(TENANT, LOCATION)).toMatchObject({
      ready: false,
      notReadyReason: "no_reader",
      readers: [],
    });

    await ensureTerminalLocation({ tenantId: TENANT, locationId: LOCATION, address: ADDRESS });
    const reader = await registerTerminalReader({
      tenantId: TENANT,
      locationId: LOCATION,
      registrationCode: "apple-orange-banana",
      label: "Counter",
    });
    expect(reader).toMatchObject({
      id: "tmr_new",
      connect_account_id: ACCT,
      location_id: LOCATION,
      livemode: false,
    });
    const regCall = stripeRequest.mock.calls.find((c) => c[0] === "/terminal/readers")!;
    expect(regCall[1]).toMatchObject({
      registration_code: "apple-orange-banana",
      label: "Counter",
      location: expect.stringMatching(/^tml_/),
    });
    expect(regCall[2]).toEqual({ stripeAccount: ACCT });

    expect(await isInStoreCardReady(TENANT, LOCATION)).toBe(true);
    // The reader belongs to THIS location only.
    expect(await isInStoreCardReady(TENANT, DEMO_LOCATION_UPTOWN_ID)).toBe(false);

    // Not charges-enabled -> not ready even with a reader.
    await connect(ACCT, false);
    stripeGet.mockResolvedValue({ id: ACCT, charges_enabled: false });
    expect(await isInStoreCardReady(TENANT, LOCATION)).toBe(false);
    expect(await getCardReadiness(TENANT, LOCATION)).toMatchObject({
      ready: false,
      notReadyReason: "connect_not_ready",
    });
  });

  it("real: a reader from a previous account is not counted (re-onboarded account)", async () => {
    goReal();
    await connect();
    stubStripe();
    await ensureTerminalLocation({ tenantId: TENANT, locationId: LOCATION, address: ADDRESS });
    await registerTerminalReader({
      tenantId: TENANT,
      locationId: LOCATION,
      registrationCode: "apple-orange-banana",
      label: "Counter",
    });
    expect(await locationHasReader(TENANT, LOCATION)).toBe(true);
    await connect("acct_reonboarded");
    expect(await locationHasReader(TENANT, LOCATION)).toBe(false);
  });

  it("listReadersWithStatus merges live online/offline and degrades to unknown", async () => {
    goReal();
    await connect();
    const now = new Date().toISOString();
    for (const id of ["tmr_a", "tmr_b", "tmr_c"]) {
      await getPosDriver().upsertTerminalReader({
        id,
        tenant_id: TENANT,
        location_id: LOCATION,
        connect_account_id: ACCT,
        label: id,
        device_type: "stripe_s700",
        serial_number: null,
        livemode: false,
        created_at: now,
        updated_at: now,
      });
    }
    stripeGet.mockImplementation(async (path: string) => {
      if (path.endsWith("tmr_a")) return { id: "tmr_a", status: "online", action: null };
      if (path.endsWith("tmr_b")) {
        return {
          id: "tmr_b",
          status: "offline",
          action: { status: "failed", failure_code: "x", process_payment_intent: { payment_intent: "pi_9" } },
        };
      }
      throw new StripeError("boom", 500, null);
    });
    const list = await listReadersWithStatus(TENANT, LOCATION);
    const by = Object.fromEntries(list.map((r) => [r.id, r]));
    expect(by.tmr_a!.status).toBe("online");
    expect(by.tmr_b!.status).toBe("offline");
    expect(by.tmr_b!.action).toMatchObject({ status: "failed", paymentIntentId: "pi_9" });
    expect(by.tmr_c!.status).toBe("unknown");
  });

  it("registration: simulated codes are test-mode only; bad codes are refused before Stripe", async () => {
    goReal("sk_live_x");
    vi.stubEnv("VERCEL_ENV", "production");
    await connect();
    stubStripe();
    await expect(
      registerTerminalReader({ tenantId: TENANT, locationId: LOCATION, registrationCode: "simulated-wpe", label: "x" }),
    ).rejects.toThrow(/test mode/i);
    for (const code of ["", "  ", "has space here", "../../x", "a".repeat(80)]) {
      await expect(
        registerTerminalReader({ tenantId: TENANT, locationId: LOCATION, registrationCode: code, label: "x" }),
      ).rejects.toBeInstanceOf(ReaderRegistrationError);
    }
    expect(stripeRequest).not.toHaveBeenCalled();

    goReal("sk_test_x");
    await ensureTerminalLocation({ tenantId: TENANT, locationId: LOCATION, address: ADDRESS });
    const sim = await registerTerminalReader({
      tenantId: TENANT,
      locationId: LOCATION,
      registrationCode: "simulated-wpe",
      label: "Sim",
    });
    expect(sim.id).toBe("tmr_new");
  });

  it("registration needs a saved address (a Terminal Location) first", async () => {
    goReal();
    await connect();
    stubStripe();
    await expect(
      registerTerminalReader({ tenantId: TENANT, locationId: LOCATION, registrationCode: "apple-orange-banana", label: "x" }),
    ).rejects.toBeInstanceOf(TerminalAddressRequiredError);
    expect(stripeRequest.mock.calls.find((c) => c[0] === "/terminal/readers")).toBeUndefined();
  });

  it("removeTerminalReader deletes on Stripe then in our DB; already-gone on Stripe still deletes; foreign location refused", async () => {
    goReal();
    await connect();
    const now = new Date().toISOString();
    await getPosDriver().upsertTerminalReader({
      id: "tmr_x",
      tenant_id: TENANT,
      location_id: LOCATION,
      connect_account_id: ACCT,
      label: "x",
      device_type: null,
      serial_number: null,
      livemode: false,
      created_at: now,
      updated_at: now,
    });
    await expect(
      removeTerminalReader({ tenantId: TENANT, locationId: DEMO_LOCATION_UPTOWN_ID, readerId: "tmr_x" }),
    ).rejects.toBeInstanceOf(ReaderNotFoundError);
    expect(stripeDelete).not.toHaveBeenCalled();

    stripeDelete.mockRejectedValueOnce(
      new StripeError("gone", 404, { error: { code: "resource_missing" } }),
    );
    await removeTerminalReader({ tenantId: TENANT, locationId: LOCATION, readerId: "tmr_x" });
    expect(stripeDelete).toHaveBeenCalledWith("/terminal/readers/tmr_x", { stripeAccount: ACCT });
    expect(await getPosDriver().getTerminalReader("tmr_x")).toBeNull();
  });
});
