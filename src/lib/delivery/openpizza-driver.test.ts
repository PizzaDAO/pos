/**
 * Outbound `openpizza_driver` delivery provider: gate, dispatch (record first),
 * idempotent retries, failure classes, cancel, manual fallback, M8. The hub and
 * the driver are a mocked `fetch`; every driver reply is a core `DeliveryTrack`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeliveryTrackSchema } from "@openpizza/core";
import {
  getPosDriver,
  DEMO_LOCATION_DOWNTOWN_ID,
  DEMO_TENANT_ID,
  type CreateOrderInput,
  type DeliveryAddress,
} from "@/lib/db";
import { resetMockOnline, resetMockOrders } from "@/lib/db/mock";
import { resetDriverHubCache } from "./driver-hub";
import {
  attemptDriverDispatch,
  cancelDeliveryForOrder,
  dispatchDelivery,
  dispatchManuallyInstead,
  pickProvider,
  quoteDelivery,
  sweepDriverDispatches,
  type DispatchDeliveryInput,
} from "./service";
import { DRIVER_CONFLICT_MARK, driverAttention } from "./attention";
import { POST as dispatchRoute } from "@/app/api/delivery/dispatch/route";

const HUB = "https://hub.test";
const DRIVER = "https://driver.test";
const T = DEMO_TENANT_ID;
const L = DEMO_LOCATION_DOWNTOWN_ID;

const dropoff: DeliveryAddress = {
  line1: "9 Elm St",
  city: "Springfield",
  region: "NY",
  postal_code: "10001",
  country: "US",
};

interface Call {
  url: string;
  signal?: AbortSignal | null;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

let calls: Call[] = [];
/** Driver /dispatch behaviour: a status code, or a function for custom replies. */
let dispatchReply: (call: Call) => Response | Promise<Response>;
let trackReply: (call: Call) => Response | Promise<Response> = () => json(track());
let cancelReply: (call: Call) => Response | Promise<Response>;
let providersReply: () => Response;

function track(over: Record<string, unknown> = {}) {
  return DeliveryTrackSchema.parse({
    provider: "openpizza_driver",
    provider_delivery_id: "drv_1",
    status: "dispatched",
    eta_minutes: 35,
    driver: null,
    tracking_url: "https://driver.test/t/abc",
    ...over,
  });
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
// The driver's real error shape: a NESTED {error:{code,message}} body.
const problem = (status: number, code = "X") =>
  json({ error: { code, message: code } }, status);

const registration = (over: Record<string, unknown> = {}) => ({
  kind: "delivery",
  key: "openpizza_driver",
  status: "active",
  base_url: DRIVER,
  ...over,
});

beforeEach(async () => {
  resetMockOrders();
  resetMockOnline();
  resetDriverHubCache();
  calls = [];
  dispatchReply = () => json(track());
  cancelReply = () => json(track({ status: "canceled" }));
  trackReply = () => json(track());
  providersReply = () => json({ data: [registration()] });
  vi.stubEnv("OPENPIZZA_DRIVER_TENANTS", T);
  vi.stubEnv("OPENPIZZA_HUB_URL", HUB);
  vi.stubEnv("OPENPIZZA_POS_CLIENT_ID", "pos-client");
  vi.stubEnv("OPENPIZZA_POS_CLIENT_SECRET", "pos-secret");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const call: Call = {
        url,
        signal: init?.signal,
        method: init?.method ?? "GET",
        headers: Object.fromEntries(
          Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
            k.toLowerCase(),
            v,
          ]),
        ),
        body: typeof init?.body === "string" ? init.body : undefined,
      };
      calls.push(call);
      if (url === `${HUB}/oauth/token`) {
        return json({ access_token: "tok_pos", token_type: "Bearer", expires_in: 300 });
      }
      if (url.startsWith(`${HUB}/v1/providers`)) return providersReply();
      if (url === `${DRIVER}/dispatch`) return dispatchReply(call);
      if (url.includes("/cancel")) return cancelReply(call);
      if (url.startsWith(`${DRIVER}/deliveries/`)) return trackReply(call);
      throw new Error(`unexpected fetch ${url}`);
    }),
  );
  await setProviders(["in_house_manual"]);
});

const original: Record<string, unknown> = {};
async function setProviders(list: string[]) {
  const s = await getPosDriver().getStoreSettings(T, L);
  if (!("saved" in original)) original.saved = s.fulfillment;
  s.fulfillment = { ...(s.fulfillment ?? {}), delivery_providers: list } as typeof s.fulfillment;
}

afterEach(async () => {
  const s = await getPosDriver().getStoreSettings(T, L);
  s.fulfillment = original.saved as typeof s.fulfillment;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

let seq = 0;
async function seedOrder(): Promise<string> {
  seq += 1;
  const id = `drv-order-${seq}`;
  const input: CreateOrderInput = {
    id,
    tenant_id: T,
    location_id: L,
    channel: "online_delivery" as CreateOrderInput["channel"],
    currency: "USD",
    items: [],
    discount_cents: 0,
    totals: {
      subtotal_cents: 2000,
      discount_cents: 0,
      taxable_cents: 2000,
      tax_cents: 0,
      tip_cents: 300,
      total_cents: 2300,
    },
    notes: null,
    status: "paid",
    fulfillment: {
      type: "delivery",
      scheduled_for: "asap",
      address: dropoff,
      contact: { name: "Dana", phone: "+14155550100" },
      delivery_notes: "Ring twice",
    } as CreateOrderInput["fulfillment"],
  } as CreateOrderInput;
  await getPosDriver().createOrder(input);
  return id;
}

function dispatchInput(orderId: string, provider = "openpizza_driver"): DispatchDeliveryInput {
  return {
    orderId,
    tenantId: T,
    locationId: L,
    provider: provider as DispatchDeliveryInput["provider"],
    pickup: { ...dropoff, line1: "Shop" },
    dropoff,
    zoneId: null,
    feeCents: 399,
    currency: "USD",
    etaMinutes: 30,
  };
}

const driverCalls = () => calls.filter((c) => c.url.startsWith(DRIVER));
const alerts = () => vi.spyOn(console, "error").mockImplementation(() => undefined);

// ---------------------------------------------------------------------------
describe("gate: default OFF, three locks plus the location list", () => {
  beforeEach(async () => {
    await setProviders(["openpizza_driver", "in_house_manual"]);
  });

  it("all locks open: the driver is picked", async () => {
    expect(await pickProvider(T, L)).toBe("openpizza_driver");
  });

  it("OPENPIZZA_DRIVER_TENANTS empty or not listing the tenant: in-house, and no network at all", async () => {
    for (const v of ["", "20000000-0000-4000-8000-0000000000bb"]) {
      vi.stubEnv("OPENPIZZA_DRIVER_TENANTS", v);
      expect(await pickProvider(T, L)).toBe("in_house_manual");
    }
    expect(calls).toHaveLength(0);
  });

  it("hub client env missing: in-house", async () => {
    vi.stubEnv("OPENPIZZA_POS_CLIENT_SECRET", "");
    expect(await pickProvider(T, L)).toBe("in_house_manual");
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["providers 403", () => problem(403, "FORBIDDEN")],
    ["providers 503", () => problem(503, "UNAVAILABLE")],
    ["empty list", () => json({ data: [] })],
    ["paused", () => json({ data: [registration({ status: "paused" })] })],
    ["http base_url", () => json({ data: [registration({ base_url: "http://driver.test" })] })],
  ])("hub registration %s: unavailable, falls through to in-house", async (_n, reply) => {
    providersReply = reply as () => Response;
    expect(await pickProvider(T, L)).toBe("in_house_manual");
    const q = await quoteDelivery({
      tenantId: T,
      locationId: L,
      pickup: dropoff,
      dropoff,
      subtotalCents: 2500,
      currency: "USD",
    });
    expect(q.provider).toBe("in_house_manual");
  });

  it("a location that does not list the driver never uses it", async () => {
    await setProviders(["in_house_manual"]);
    expect(await pickProvider(T, L)).toBe("in_house_manual");
  });

  it("the registration is cached for 60 s", async () => {
    await pickProvider(T, L);
    await pickProvider(T, L);
    expect(calls.filter((c) => c.url.startsWith(`${HUB}/v1/providers`))).toHaveLength(1);
  });

  it("a checkout quote never calls the driver", async () => {
    await quoteDelivery({
      tenantId: T,
      locationId: L,
      pickup: dropoff,
      dropoff,
      subtotalCents: 2500,
      currency: "USD",
      provider: "openpizza_driver",
    });
    expect(driverCalls()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe("dispatch", () => {
  it("inserts the record as quoted BEFORE calling the driver, sends its id and no ready/pickup", async () => {
    const orderId = await seedOrder();
    let seen: { status?: string; id?: string } = {};
    dispatchReply = async () => {
      const rec = await getPosDriver().getDeliveryForOrder(orderId);
      seen = { status: rec?.status, id: rec?.id };
      return json(track({ driver: { name: "Dee", phone: "+14155550111" } }));
    };
    const rec = await dispatchDelivery(dispatchInput(orderId));

    expect(seen.status).toBe("quoted");
    const call = driverCalls()[0]!;
    const body = JSON.parse(call.body!);
    expect(body.delivery_id).toBe(seen.id);
    expect(body.order_id).toBe(orderId);
    expect(body.source).toBe("pos");
    expect(body).not.toHaveProperty("ready");
    expect(body).not.toHaveProperty("pickup");
    expect(body.fee_cents).toBe(399);
    expect(body.tip_cents).toBe(300);
    expect(body.dropoff.contact.name).toBe("Dana");
    expect(body.dropoff.notes).toBe("Ring twice");
    expect(call.headers["idempotency-key"]).toBe(`pos-delivery:${seen.id}`);
    expect(call.headers.authorization).toBe("Bearer tok_pos");

    expect(rec.id).toBe(seen.id);
    expect(rec.status).toBe("dispatched");
    expect(rec.provider_delivery_id).toBe("drv_1");
    expect(rec.tracking_ref).toBe("https://driver.test/t/abc");
    expect(rec.driver_name).toBe("Dee");
    expect(rec.eta_minutes).toBe(35);
    expect(rec.dispatch_attempts).toBe(1);
  });

  it("a re-dispatch of a confirmed delivery returns it without calling the driver again", async () => {
    const orderId = await seedOrder();
    const a = await dispatchDelivery(dispatchInput(orderId));
    const b = await dispatchDelivery(dispatchInput(orderId));
    expect(b.id).toBe(a.id);
    expect(driverCalls()).toHaveLength(1);
  });

  it("driver 503: stays quoted, attempts + 1; the replay sends the same key and identical body", async () => {
    const orderId = await seedOrder();
    dispatchReply = () => problem(503, "UNAVAILABLE");
    const first = await dispatchDelivery(dispatchInput(orderId));
    expect(first.status).toBe("quoted");
    expect(first.provider_delivery_id).toBeNull();
    expect(first.dispatch_attempts).toBe(1);
    expect(first.dispatch_error).toBeTruthy();
    expect(first.dispatch_next_at).toBeTruthy();

    dispatchReply = () => json(track());
    const later = new Date(Date.now() + 61_000);
    const sweep = await sweepDriverDispatches(later);
    expect(sweep).toMatchObject({ retried: 1, dispatched: 1, failed: 0 });
    const [a, b] = driverCalls();
    expect(b!.headers["idempotency-key"]).toBe(a!.headers["idempotency-key"]);
    expect(b!.body).toBe(a!.body);
    const stored = await getPosDriver().getDelivery(first.id);
    expect(stored).toMatchObject({ status: "dispatched", provider_delivery_id: "drv_1", dispatch_attempts: 2 });
  });

  it("a timeout / network error is retryable too", async () => {
    const orderId = await seedOrder();
    dispatchReply = () => {
      throw new Error("The operation was aborted");
    };
    const rec = await dispatchDelivery(dispatchInput(orderId));
    expect(rec.status).toBe("quoted");
    expect(rec.dispatch_attempts).toBe(1);
  });

  it("an unreachable hub at dispatch leaves it quoted", async () => {
    const orderId = await seedOrder();
    providersReply = () => problem(503, "UNAVAILABLE");
    const rec = await dispatchDelivery(dispatchInput(orderId));
    expect(rec.status).toBe("quoted");
    expect(driverCalls()).toHaveLength(0);
  });

  it("the sweep waits for the backoff, then gives up after 15 minutes (failed + alert)", async () => {
    const orderId = await seedOrder();
    const err = alerts();
    dispatchReply = () => problem(503, "UNAVAILABLE");
    const rec = await dispatchDelivery(dispatchInput(orderId));
    // Too early: neither 30 s old nor past the backoff.
    expect(await sweepDriverDispatches(new Date(Date.now() + 5_000))).toMatchObject({ retried: 0 });
    // Still down at +5 min: stays quoted.
    expect((await sweepDriverDispatches(new Date(Date.now() + 5 * 60_000))).failed).toBe(0);
    expect((await getPosDriver().getDelivery(rec.id))!.status).toBe("quoted");
    // 16 min: give up.
    const s = await sweepDriverDispatches(new Date(Date.now() + 16 * 60_000));
    expect(s.failed).toBe(1);
    const stored = (await getPosDriver().getDelivery(rec.id))!;
    expect(stored.status).toBe("failed");
    expect(stored.dispatch_error).toContain("gave up");
    expect(err.mock.calls.some((c) => String(c[0]).includes("[pos][ALERT]"))).toBe(true);
    // Failed records are never retried.
    const n = driverCalls().length;
    await sweepDriverDispatches(new Date(Date.now() + 40 * 60_000));
    expect(driverCalls()).toHaveLength(n);
  });

  it.each([401, 403, 404, 422])("driver %i: failed + alert, never retried", async (status) => {
    const orderId = await seedOrder();
    const err = alerts();
    dispatchReply = () => problem(status, "NOPE");
    const rec = await dispatchDelivery(dispatchInput(orderId));
    expect(rec.status).toBe("failed");
    expect(rec.dispatch_error).toContain(String(status));
    expect(err.mock.calls.some((c) => String(c[0]).includes("[pos][ALERT]"))).toBe(true);
    await sweepDriverDispatches(new Date(Date.now() + 10 * 60_000));
    expect(driverCalls()).toHaveLength(1);
  });

  it("a malformed driver reply is retried with the same key (never trusted)", async () => {
    const orderId = await seedOrder();
    dispatchReply = () => json({ nonsense: true });
    const rec = await dispatchDelivery(dispatchInput(orderId));
    expect(rec.status).toBe("quoted");
    expect(rec.provider_delivery_id).toBeNull();
  });

  it("the driver's own push arrives before the dispatch response: the newer status is kept", async () => {
    const orderId = await seedOrder();
    dispatchReply = async () => {
      const rec = (await getPosDriver().getDeliveryForOrder(orderId))!;
      await getPosDriver().transitionDelivery(rec.id, T, {
        status: "picked_up",
        provider_delivery_id: "drv_1",
        driver_name: "Dee",
      });
      return json(track());
    };
    const rec = await dispatchDelivery(dispatchInput(orderId));
    expect(rec.status).toBe("picked_up");
    expect(rec.provider_delivery_id).toBe("drv_1");
    expect(rec.driver_name).toBe("Dee");
  });

  it("the push moved it but carried no id: the id is filled in, the status kept", async () => {
    const orderId = await seedOrder();
    dispatchReply = async () => {
      const rec = (await getPosDriver().getDeliveryForOrder(orderId))!;
      await getPosDriver().transitionDelivery(rec.id, T, { status: "assigned" });
      return json(track());
    };
    const rec = await dispatchDelivery(dispatchInput(orderId));
    expect(rec.status).toBe("assigned");
    expect(rec.provider_delivery_id).toBe("drv_1");
  });

  it("switched off between insert and retry: nothing is sent; it ages to failed", async () => {
    const orderId = await seedOrder();
    dispatchReply = () => problem(503, "UNAVAILABLE");
    const rec = await dispatchDelivery(dispatchInput(orderId));
    vi.stubEnv("OPENPIZZA_DRIVER_TENANTS", "");
    const n = calls.length;
    const off = await sweepDriverDispatches(new Date(Date.now() + 6 * 60_000));
    expect(off.retried).toBe(0); // a switched-off tenant is not counted
    expect(calls).toHaveLength(n);
    alerts();
    await sweepDriverDispatches(new Date(Date.now() + 16 * 60_000));
    expect((await getPosDriver().getDelivery(rec.id))!.status).toBe("failed");
  });
});

// ---------------------------------------------------------------------------
describe("cancel", () => {
  it("driver 200: the record becomes canceled, with a per-record cancel key", async () => {
    const orderId = await seedOrder();
    const rec = await dispatchDelivery(dispatchInput(orderId));
    const out = await cancelDeliveryForOrder(orderId);
    expect(out!.status).toBe("canceled");
    const c = calls.find((x) => x.url.includes("/cancel"))!;
    expect(c.url).toBe(`${DRIVER}/deliveries/drv_1/cancel`);
    expect(c.headers["idempotency-key"]).toBe(`pos-cancel:${rec.id}`);
  });

  it("driver 409 (already picked up): stays live, the refusal is stored, nothing is marked canceled", async () => {
    const orderId = await seedOrder();
    alerts();
    await dispatchDelivery(dispatchInput(orderId));
    cancelReply = () => problem(409, "INVALID_TRANSITION");
    const out = await cancelDeliveryForOrder(orderId);
    expect(out!.status).toBe("dispatched");
    expect(out!.dispatch_error).toContain("409");
    expect(driverAttention(out!).reason).toContain("409");
  });

  it("driver unreachable: stays live too", async () => {
    const orderId = await seedOrder();
    alerts();
    await dispatchDelivery(dispatchInput(orderId));
    cancelReply = () => problem(503, "UNAVAILABLE");
    expect((await cancelDeliveryForOrder(orderId))!.status).toBe("dispatched");
  });

  it("no provider id yet: canceled locally, the driver is not called", async () => {
    const orderId = await seedOrder();
    dispatchReply = () => problem(503, "UNAVAILABLE");
    await dispatchDelivery(dispatchInput(orderId));
    const out = await cancelDeliveryForOrder(orderId);
    expect(out!.status).toBe("canceled");
    expect(calls.some((c) => c.url.includes("/cancel"))).toBe(false);
    // And the sweep never revives it.
    await sweepDriverDispatches(new Date(Date.now() + 6 * 60_000));
    expect(driverCalls()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
describe("assign route (M8) and the manual fallback", () => {
  const post = (body: unknown) =>
    dispatchRoute(
      new Request("https://pos.test/api/delivery/dispatch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );

  it("refuses to hand-assign an openpizza_driver delivery (409), leaving it untouched", async () => {
    const orderId = await seedOrder();
    const rec = await dispatchDelivery(dispatchInput(orderId));
    const res = await post({ deliveryId: rec.id, driverName: "Sam" });
    expect(res.status).toBe(409);
    expect((await getPosDriver().getDelivery(rec.id))!.driver_name).toBeNull();
    expect((await getPosDriver().getOrder(orderId))!.status).toBe("paid");
  });

  it("still assigns an in-house delivery", async () => {
    await setProviders(["in_house_manual"]);
    const orderId = await seedOrder();
    const rec = await dispatchDelivery(dispatchInput(orderId, "in_house_manual"));
    expect(rec.status).toBe("pending_assignment");
    const res = await post({ deliveryId: rec.id, driverName: "Sam" });
    expect(res.status).toBe(200);
    expect((await getPosDriver().getDelivery(rec.id))!.status).toBe("assigned");
  });

  it("manual fallback is refused while the driver has the delivery", async () => {
    const orderId = await seedOrder();
    const rec = await dispatchDelivery(dispatchInput(orderId));
    const res = await post({ deliveryId: rec.id, action: "dispatchManually" });
    expect(res.status).toBe(409);
    expect((await getPosDriver().getDelivery(rec.id))!.provider).toBe("openpizza_driver");
  });

  it("manual fallback is held for 2 minutes on a quoted record, then allowed", async () => {
    const orderId = await seedOrder();
    dispatchReply = () => problem(503, "UNAVAILABLE");
    const rec = await dispatchDelivery(dispatchInput(orderId));
    expect((await dispatchManuallyInstead(rec.id)).ok).toBe(false);
    const res = await dispatchManuallyInstead(rec.id, new Date(Date.now() + 3 * 60_000));
    expect(res.ok).toBe(true);
    const stored = (await getPosDriver().getDelivery(rec.id))!;
    expect(stored).toMatchObject({ provider: "in_house_manual", status: "pending_assignment" });
    // The order's quoted provider follows the switch (the KDS hand-off reads it).
    expect((await getPosDriver().getOrder(orderId))?.fulfillment?.delivery_provider).toBe(
      "in_house_manual",
    );
    // From here it is an ordinary in-house delivery: hand-assignable, and the sweep leaves it.
    await sweepDriverDispatches(new Date(Date.now() + 10 * 60_000));
    expect(driverCalls()).toHaveLength(1);
  });

  it("manual fallback is allowed on a failed record with no provider id (via the route)", async () => {
    const orderId = await seedOrder();
    alerts();
    dispatchReply = () => problem(422, "BAD");
    const rec = await dispatchDelivery(dispatchInput(orderId));
    expect(rec.status).toBe("failed");
    const res = await post({ deliveryId: rec.id, action: "dispatchManually" });
    expect(res.status).toBe(200);
    const stored = (await getPosDriver().getDelivery(rec.id))!;
    expect(stored).toMatchObject({ provider: "in_house_manual", status: "pending_assignment" });
  });

  it("manual fallback is allowed after the driver canceled, and for a driver-reported failure even with a provider id", async () => {
    const orderId = await seedOrder();
    const rec = await dispatchDelivery(dispatchInput(orderId));
    // The driver reports a failed stop: it said failed, so a person may take over.
    await getPosDriver().transitionDelivery(rec.id, T, { status: "failed" });
    const failedSwitch = await dispatchManuallyInstead(rec.id);
    expect(failedSwitch.ok).toBe(true);

    const orderId2 = await seedOrder();
    const rec2 = await dispatchDelivery(dispatchInput(orderId2));
    await getPosDriver().transitionDelivery(rec2.id, T, { status: "canceled" });
    expect((await dispatchManuallyInstead(rec2.id)).ok).toBe(true);
  });

  it("manual fallback never applies to other providers or to a closed-out order", async () => {
    await setProviders(["in_house_manual"]);
    const o1 = await seedOrder();
    const inHouse = await dispatchDelivery(dispatchInput(o1, "in_house_manual"));
    expect(await dispatchManuallyInstead(inHouse.id)).toMatchObject({ ok: false, reason: "not_driver" });

    const o2 = await seedOrder();
    alerts();
    dispatchReply = () => problem(422, "BAD");
    const failed = await dispatchDelivery(dispatchInput(o2));
    for (const closed of ["voided", "completed", "refunded", "abandoned"] as const) {
      await getPosDriver().updateOrderStatus(o2, closed);
      expect((await dispatchManuallyInstead(failed.id)).ok).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
describe("regression: a location on in-house takes exactly today's path", () => {
  it("no driver env, no network, no dispatch bookkeeping", async () => {
    vi.stubEnv("OPENPIZZA_DRIVER_TENANTS", "");
    vi.stubEnv("OPENPIZZA_HUB_URL", "");
    vi.stubEnv("OPENPIZZA_POS_CLIENT_ID", "");
    vi.stubEnv("OPENPIZZA_POS_CLIENT_SECRET", "");
    expect(await pickProvider(T, L)).toBe("in_house_manual");
    const orderId = await seedOrder();
    const rec = await dispatchDelivery(dispatchInput(orderId, "in_house_manual"));
    expect(rec.provider).toBe("in_house_manual");
    expect(rec.status).toBe("pending_assignment");
    expect(rec.dispatch_attempts).toBeUndefined();
    expect(calls).toHaveLength(0);
    expect(await sweepDriverDispatches()).toEqual({ retried: 0, dispatched: 0, failed: 0 });
  });
});

describe("driverAttention", () => {
  const base = {
    provider: "openpizza_driver",
    status: "dispatched" as const,
    provider_delivery_id: "drv_1" as string | null,
    dispatch_error: null as string | null,
    created_at: new Date(0).toISOString(),
  };
  it("flags failed, long-quoted and driver-canceled rows only", () => {
    const now = 10 * 60_000;
    expect(driverAttention(base, now).reason).toBeNull();
    expect(driverAttention({ ...base, provider: "in_house_manual", status: "failed" }, now).reason).toBeNull();
    expect(driverAttention({ ...base, status: "failed", provider_delivery_id: null }, now)).toMatchObject({
      canDispatchManually: true,
    });
    expect(driverAttention({ ...base, status: "failed" }, now).canDispatchManually).toBe(true);
    // A row POS canceled itself (order voided) needs no one.
    for (const os of ["voided", "abandoned", "refunded"]) {
      expect(driverAttention({ ...base, status: "failed" }, now, os)).toEqual({
        reason: null,
        canDispatchManually: false,
      });
      expect(driverAttention({ ...base, status: "canceled" }, now, os).reason).toBeNull();
    }
    expect(driverAttention({ ...base, status: "failed" }, now, "paid").reason).toBeTruthy();
    expect(
      driverAttention({ ...base, status: "quoted", provider_delivery_id: null }, 60_000).reason,
    ).toBeNull();
    expect(
      driverAttention({ ...base, status: "quoted", provider_delivery_id: null }, now).canDispatchManually,
    ).toBe(true);
    expect(driverAttention({ ...base, status: "canceled" }, now).canDispatchManually).toBe(true);
  });
});

describe("attemptDriverDispatch on a record that is not the driver's", () => {
  it("is a no-op for the store (CAS refuses a non-driver record)", async () => {
    await setProviders(["in_house_manual"]);
    const orderId = await seedOrder();
    const rec = await dispatchDelivery(dispatchInput(orderId, "in_house_manual"));
    const res = await getPosDriver().updateDriverDispatch(rec.id, T, {
      expect_status: rec.status,
      status: "failed",
    });
    expect(res.ok).toBe(false);
    void attemptDriverDispatch;
  });
});

// ---------------------------------------------------------------------------
describe("review fixes", () => {
  it("the post-dispatch CAS loses to a local cancel: the driver delivery is canceled and alerted", async () => {
    const orderId = await seedOrder();
    const err = alerts();
    dispatchReply = async () => {
      // POS cancels (no provider id yet -> local cancel) while the call is in flight.
      await cancelDeliveryForOrder(orderId);
      return json(track());
    };
    const rec = await dispatchDelivery(dispatchInput(orderId));
    expect(rec.status).toBe("canceled");
    const c = calls.find((x) => x.url.includes("/cancel"))!;
    expect(c.url).toBe(`${DRIVER}/deliveries/drv_1/cancel`);
    expect(err.mock.calls.some((x) => String(x[0]).includes("[pos][ALERT]"))).toBe(true);
  });

  it("the post-dispatch CAS loses to a manual switch: the driver delivery is canceled", async () => {
    const orderId = await seedOrder();
    alerts();
    dispatchReply = async () => {
      const r = (await getPosDriver().getDeliveryForOrder(orderId))!;
      await getPosDriver().switchDeliveryToManual(r.id, T, { status: "quoted", provider_delivery_id: null });
      return json(track());
    };
    const rec = await dispatchDelivery(dispatchInput(orderId));
    expect(rec.provider).toBe("in_house_manual");
    expect(calls.some((x) => x.url.includes("/cancel"))).toBe(true);
  });

  it("a stale copy is re-read right before the call: switched-to-manual or canceled rows are not sent", async () => {
    const orderId = await seedOrder();
    dispatchReply = () => problem(503, "UNAVAILABLE");
    const stale = await dispatchDelivery(dispatchInput(orderId));
    await getPosDriver().switchDeliveryToManual(stale.id, T, { status: "quoted", provider_delivery_id: null });
    dispatchReply = () => json(track());
    const out = await attemptDriverDispatch(stale);
    expect(out.provider).toBe("in_house_manual");
    expect(driverCalls()).toHaveLength(1);
  });

  it("the hub token request has a 5 s abort signal", async () => {
    await pickProvider(T, L).catch(() => undefined);
    await setProviders(["openpizza_driver", "in_house_manual"]);
    resetDriverHubCache();
    await pickProvider(T, L);
    const tok = calls.find((c) => c.url === `${HUB}/oauth/token`)!;
    expect(tok.signal).toBeInstanceOf(AbortSignal);
  });

  it("a hub failure is cached as none for 30 s (one hub call, not one per quote)", async () => {
    await setProviders(["openpizza_driver", "in_house_manual"]);
    providersReply = () => problem(503, "UNAVAILABLE");
    for (let i = 0; i < 3; i++) expect(await pickProvider(T, L)).toBe("in_house_manual");
    expect(calls.filter((c) => c.url.startsWith(`${HUB}/v1/providers`))).toHaveLength(1);
  });

  describe("a 409 from /dispatch (driver may already hold it)", () => {
    const conflict = () => problem(409, "IDEMPOTENCY_CONFLICT");

    it("push NOT landed: stays quoted with the conflict mark + alert; never failed, no adopt GET", async () => {
      const orderId = await seedOrder();
      const err = alerts();
      dispatchReply = conflict;
      const rec = await dispatchDelivery(dispatchInput(orderId));
      expect(rec.status).toBe("quoted");
      expect(rec.dispatch_error).toBe(DRIVER_CONFLICT_MARK);
      expect(err.mock.calls.some((x) => String(x[0]).includes("[pos][ALERT]"))).toBe(true);
      expect(calls.some((c) => c.method === "GET" && c.url.startsWith(`${DRIVER}/deliveries/`))).toBe(false);
    });

    it("push landed meanwhile: the row with the driver's id is kept", async () => {
      const orderId = await seedOrder();
      dispatchReply = async () => {
        const r = (await getPosDriver().getDeliveryForOrder(orderId))!;
        await getPosDriver().transitionDelivery(r.id, T, {
          status: "assigned",
          provider_delivery_id: "drv_7",
        });
        return conflict();
      };
      const rec = await dispatchDelivery(dispatchInput(orderId));
      expect(rec).toMatchObject({ status: "assigned", provider_delivery_id: "drv_7" });
    });

    it("refuses the manual switch (route and service) and hides the button", async () => {
      const orderId = await seedOrder();
      alerts();
      dispatchReply = conflict;
      const rec = await dispatchDelivery(dispatchInput(orderId));
      const later = new Date(Date.now() + 10 * 60_000);
      expect((await dispatchManuallyInstead(rec.id, later)).ok).toBe(false);
      expect(driverAttention(rec, later.getTime())).toMatchObject({
        reason: DRIVER_CONFLICT_MARK,
        canDispatchManually: false,
      });
      expect((await getPosDriver().getDelivery(rec.id))!.provider).toBe("openpizza_driver");
    });

    it("is never auto-failed or re-sent by the sweep (alert only), and a later push still lands", async () => {
      const orderId = await seedOrder();
      const err = alerts();
      dispatchReply = conflict;
      const rec = await dispatchDelivery(dispatchInput(orderId));
      const n = driverCalls().length;
      const s = await sweepDriverDispatches(new Date(Date.now() + 2 * 60 * 60_000));
      expect(s.failed).toBe(0);
      expect(driverCalls()).toHaveLength(n);
      expect((await getPosDriver().getDelivery(rec.id))!.status).toBe("quoted");
      expect(err.mock.calls.some((x) => String(x[0]).includes("still waiting"))).toBe(true);
      const push = await getPosDriver().transitionDelivery(rec.id, T, {
        status: "assigned",
        provider_delivery_id: "drv_7",
      });
      expect(push.ok).toBe(true);
    });
  });

  it("the sweep honors its total time budget", async () => {
    const orderId = await seedOrder();
    dispatchReply = () => problem(503, "UNAVAILABLE");
    await dispatchDelivery(dispatchInput(orderId));
    const n = driverCalls().length;
    const s = await sweepDriverDispatches(new Date(Date.now() + 61_000), 10, 0);
    expect(s.retried).toBe(0);
    expect(driverCalls()).toHaveLength(n);
  });
});

// ---------------------------------------------------------------------------
describe("stuck conflict rows (go-live follow-ups)", () => {
  const conflict = () => problem(409, "IDEMPOTENCY_CONFLICT");
  const ACTOR = { id: "user-1", label: "mgr@example.com" };

  async function parked() {
    const orderId = await seedOrder();
    const err = alerts();
    dispatchReply = conflict;
    const rec = await dispatchDelivery(dispatchInput(orderId));
    return { orderId, rec, err };
  }

  it("parking sets dispatch_next_at about an hour out", async () => {
    const { rec } = await parked();
    const next = new Date(rec.dispatch_next_at!).getTime();
    expect(next - Date.now()).toBeGreaterThan(59 * 60_000);
    expect(next - Date.now()).toBeLessThanOrEqual(60 * 60_000);
  });

  it("override needs a row older than 15 min AND confirmNotWithDriver", async () => {
    const { rec } = await parked();
    const old = new Date(Date.now() + 16 * 60_000);
    expect((await dispatchManuallyInstead(rec.id, old)).ok).toBe(false);
    expect((await dispatchManuallyInstead(rec.id, old, { confirmNotWithDriver: false })).ok).toBe(false);
    // Too young, even when confirmed.
    expect(
      (await dispatchManuallyInstead(rec.id, new Date(Date.now() + 5 * 60_000), { confirmNotWithDriver: true })).ok,
    ).toBe(false);
    expect((await getPosDriver().getDelivery(rec.id))!.provider).toBe("openpizza_driver");
  });

  it("confirmed override switches, logs the ALERT with the user, and audits", async () => {
    const { rec, err } = await parked();
    const res = await dispatchManuallyInstead(rec.id, new Date(Date.now() + 16 * 60_000), {
      confirmNotWithDriver: true,
      actor: ACTOR,
    });
    expect(res.ok).toBe(true);
    expect(await getPosDriver().getDelivery(rec.id)).toMatchObject({
      provider: "in_house_manual",
      status: "pending_assignment",
    });
    expect(
      err.mock.calls.some((c) =>
        String(c[0]).includes(`[pos][ALERT] manual override of driver conflict for delivery ${rec.id} by mgr@example.com`),
      ),
    ).toBe(true);
    const log = await getPosDriver().listAuditLog(T);
    expect(log.some((e) => e.action === "delivery_manual_override" && e.detail?.includes(rec.id))).toBe(true);
  });

  it("the sweep alerts and pushes dispatch_next_at out another hour (no starvation)", async () => {
    const { rec, err } = await parked();
    const at = new Date(Date.now() + 2 * 60 * 60_000);
    const s = await sweepDriverDispatches(at);
    expect(s.failed).toBe(0);
    expect(err.mock.calls.some((x) => String(x[0]).includes("still waiting"))).toBe(true);
    const stored = (await getPosDriver().getDelivery(rec.id))!;
    expect(new Date(stored.dispatch_next_at!).getTime()).toBeGreaterThanOrEqual(at.getTime() + 59 * 60_000);
    // Not due again right away.
    expect(await getPosDriver().listDriverDispatchRetries(at.toISOString(), 10)).toHaveLength(0);
  });

  it("the sweep does not alert for a closed order", async () => {
    for (const closed of ["refunded", "voided", "abandoned", "completed"] as const) {
      resetMockOnline();
      const { orderId, err } = await parked();
      await getPosDriver().updateOrderStatus(orderId, closed);
      err.mockClear();
      await sweepDriverDispatches(new Date(Date.now() + 2 * 60 * 60_000));
      expect(err.mock.calls.some((x) => String(x[0]).includes("still waiting"))).toBe(false);
    }
  });

  it("the sweep cancels a conflict row locally when its order is closed", async () => {
    for (const closed of ["refunded", "voided", "abandoned", "completed"] as const) {
      resetMockOnline();
      const { orderId, rec } = await parked();
      await getPosDriver().updateOrderStatus(orderId, closed);
      await sweepDriverDispatches(new Date(Date.now() + 2 * 60 * 60_000));
      const stored = (await getPosDriver().getDelivery(rec.id))!;
      expect(stored.status).toBe("canceled");
      expect(stored.provider_delivery_id).toBeNull();
    }
  });

  it("the sweep never cancels a closed-order row the driver's push just took", async () => {
    const { orderId, rec, err } = await parked();
    await getPosDriver().updateOrderStatus(orderId, "voided");
    const db = getPosDriver();
    const realGetOrder = db.getOrder.bind(db);
    // The driver's push lands between the sweep's list and its cancel.
    const spy = vi.spyOn(db, "getOrder").mockImplementation(async (id) => {
      await db.updateDriverDispatch(rec.id, rec.tenant_id, {
        expect_status: "quoted",
        status: "dispatched",
        provider_delivery_id: "drv_race",
      });
      return realGetOrder(id);
    });
    err.mockClear();
    await sweepDriverDispatches(new Date(Date.now() + 2 * 60 * 60_000));
    spy.mockRestore();
    expect((await db.getDelivery(rec.id))!).toMatchObject({
      status: "dispatched",
      provider_delivery_id: "drv_race",
    });
    expect(err.mock.calls.some((x) => String(x[0]).includes("picked up by the driver during the sweep"))).toBe(true);
  });

  it("the sweep leaves a conflict row on a live order parked", async () => {
    const { rec } = await parked();
    await sweepDriverDispatches(new Date(Date.now() + 2 * 60 * 60_000));
    expect((await getPosDriver().getDelivery(rec.id))!.status).toBe("quoted");
  });

  it("attention: the mark counts only on a quoted row without a driver id; override after 15 min", async () => {
    const base = {
      provider: "openpizza_driver",
      status: "quoted" as const,
      provider_delivery_id: null as string | null,
      dispatch_error: DRIVER_CONFLICT_MARK as string | null,
      created_at: new Date(0).toISOString(),
    };
    expect(driverAttention(base, 5 * 60_000)).toMatchObject({ canDispatchManually: false, canOverrideConflict: false });
    expect(driverAttention(base, 16 * 60_000)).toMatchObject({ canDispatchManually: false, canOverrideConflict: true });
    for (const over of [
      { status: "assigned" as const },
      { provider_delivery_id: "drv_1" },
    ]) {
      const a = driverAttention({ ...base, ...over }, 60 * 60_000);
      expect(a.canOverrideConflict).toBeFalsy();
      expect(a.reason).toBeNull();
    }
  });

  it("the route passes the confirm flag through (refused when the row is young)", async () => {
    const { rec } = await parked();
    const res = await dispatchRoute(
      new Request("https://pos.test/api/delivery/dispatch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deliveryId: rec.id, action: "dispatchManually", confirmNotWithDriver: true }),
      }),
    );
    expect(res.status).toBe(409);
  });
});
