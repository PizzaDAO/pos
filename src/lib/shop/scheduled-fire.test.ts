/**
 * Audit 2026-11-18 pos P1-1: a scheduled online order must not reach the KDS or
 * the printer when it is paid. It is held until its fire time (promised - prep),
 * shows its scheduled time, and ages from the fire time.
 *
 * Mock driver, zero env.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEMO_TENANT_ID, getPosDriver, type Order } from "@/lib/db";
import { resetMockOrders, resetMockPayments } from "@/lib/db/mock";
import { buildTickets, DEFAULT_KDS_THRESHOLDS } from "@/lib/kds/board";
import { isHeldForFire, kitchenFireAt } from "@/lib/kds/fire";
import { formatScheduledFor } from "@/lib/kds/format";
import { createPrinter } from "@/lib/printing/queue";
import { POST as shopOrdersPOST } from "@/app/api/shop/orders/route";
import { GET as fireCronGET } from "@/app/api/cron/fire-scheduled-orders/route";
import { finalizeOnlinePayment } from "./finalize";
import { releaseDueScheduledOrders } from "./fire-sweep";

const MIN = 60_000;
// Wednesday 2026-11-18, 10:00 EST.
const WED_10AM = new Date("2026-11-18T15:00:00.000Z");
// Friday 2026-11-20, 1:00 PM EST.
const FRI_1PM = "2026-11-20T18:00:00.000Z";

function baseOrder(over: Partial<Order> = {}): Order {
  return {
    id: crypto.randomUUID(),
    tenant_id: DEMO_TENANT_ID,
    location_id: "loc",
    channel: "online_pickup",
    status: "paid",
    currency: "USD",
    order_number: "A-0001",
    items: [],
    totals: {
      subtotal_cents: 1000,
      discount_cents: 0,
      taxable_cents: 1000,
      tax_cents: 0,
      tip_cents: 0,
      total_cents: 1000,
    },
    notes: null,
    created_at: WED_10AM.toISOString(),
    updated_at: WED_10AM.toISOString(),
    fulfillment: {
      type: "pickup",
      scheduled_for: FRI_1PM,
      promised_at: FRI_1PM,
      kitchen_fire_at: new Date(Date.parse(FRI_1PM) - 20 * MIN).toISOString(),
    },
    ...over,
  } as Order;
}

describe("buildTickets holds scheduled online orders until fire time", () => {
  it("leaves a paid Friday pickup off Wednesday's board", () => {
    const o = baseOrder();
    expect(buildTickets([o], WED_10AM, DEFAULT_KDS_THRESHOLDS)).toEqual([]);
    expect(isHeldForFire(o, WED_10AM)).toBe(true);
  });

  it("shows it at the fire time, aged from the fire time, with its scheduled time", () => {
    const o = baseOrder();
    const fire = new Date(o.fulfillment!.kitchen_fire_at!);
    const [t] = buildTickets(
      [o],
      new Date(fire.getTime() + 2 * MIN),
      DEFAULT_KDS_THRESHOLDS,
    );
    expect(t).toBeDefined();
    expect(t!.ageFrom).toBe(fire.toISOString());
    expect(t!.elapsedSeconds).toBe(120);
    expect(t!.ageLevel).toBe("fresh");
    expect(t!.scheduledFor).toBe(FRI_1PM);
  });

  it("a legacy order without kitchen_fire_at uses promised - the location's prep", () => {
    const o = baseOrder();
    delete o.fulfillment!.kitchen_fire_at;
    const prep = 25;
    expect(kitchenFireAt(o, prep)).toBe(
      new Date(Date.parse(FRI_1PM) - 25 * MIN).toISOString(),
    );
    expect(
      buildTickets([o], WED_10AM, DEFAULT_KDS_THRESHOLDS, {
        prepMinutes: prep,
      }),
    ).toEqual([]);
    const at = new Date(Date.parse(FRI_1PM) - 20 * MIN);
    const [t] = buildTickets([o], at, DEFAULT_KDS_THRESHOLDS, {
      prepMinutes: prep,
    });
    expect(t!.elapsedSeconds).toBe(300);
  });

  it("does not touch ASAP, in-store, bumped or /v1-held orders", () => {
    const asap = baseOrder({
      fulfillment: {
        type: "pickup",
        scheduled_for: "asap",
        promised_at: FRI_1PM,
      },
    });
    const inStore = baseOrder({ channel: "in_store" });
    const bumped = baseOrder({ status: "in_kitchen" });
    for (const o of [asap, inStore, bumped]) {
      const [t] = buildTickets([o], WED_10AM, DEFAULT_KDS_THRESHOLDS);
      expect(t?.order.id).toBe(o.id);
    }
    // ASAP still ages from created_at.
    const [t] = buildTickets(
      [asap],
      new Date(WED_10AM.getTime() + MIN),
      DEFAULT_KDS_THRESHOLDS,
    );
    expect(t!.ageFrom).toBe(asap.created_at);
    expect(t!.scheduledFor).toBeUndefined();
    // Bumped early by staff: on the board, still aged from the fire time.
    expect(isHeldForFire(bumped, WED_10AM)).toBe(false);
    // A /v1 hold (catering) is its own mechanism.
    expect(
      isHeldForFire(
        baseOrder({
          hold: { reason: "scheduled", expires_at: FRI_1PM },
        } as Partial<Order>),
        WED_10AM,
      ),
    ).toBe(false);
  });

  it("labels the time in the store's zone", () => {
    expect(formatScheduledFor(FRI_1PM, "America/New_York")).toMatch(
      /^For Fri 1:00\sPM$/,
    );
    expect(formatScheduledFor(FRI_1PM, "America/Los_Angeles")).toMatch(
      /^For Fri 10:00\sAM$/,
    );
  });
});

describe("checkout -> payment -> fire sweep (mock driver)", () => {
  beforeEach(() => {
    resetMockOrders();
    resetMockPayments();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(WED_10AM);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function placeScheduled(): Promise<Order> {
    const res = await shopOrdersPOST(
      new Request("http://localhost/api/shop/orders", {
        method: "POST",
        headers: { "x-forwarded-for": "10.1.1.7" },
        body: JSON.stringify({
          id: crypto.randomUUID(),
          tenantSlug: "tonys-pizza",
          locationSlug: "tonys-uptown",
          items: [
            {
              id: "l1",
              item_id: "30000000-0000-0000-0000-000000000010",
              size_id: "40000000-0000-0000-0000-000000000021",
              quantity: 1,
              modifiers: [],
            },
          ],
          fulfillmentType: "pickup",
          scheduledFor: FRI_1PM,
          customer: { email: `sched-${Date.now()}@example.com`, name: "Sam" },
        }),
      }),
    );
    expect(res.status).toBe(201);
    return ((await res.json()) as { order: Order }).order;
  }

  const jobs = (o: Order) =>
    getPosDriver()
      .listPrintJobs(o.tenant_id, o.location_id, 50)
      .then((js) => js.filter((j) => j.order_id === o.id));

  it("stores the fire time, keeps the paid order off the board and the printer until then", async () => {
    const placed = await placeScheduled();
    const driver = getPosDriver();
    const settings = await driver.getStoreSettings(
      placed.tenant_id,
      placed.location_id,
    );
    const prep = settings.fulfillment!.prep_minutes;
    const fireAt = new Date(Date.parse(FRI_1PM) - prep * MIN).toISOString();
    expect(placed.fulfillment?.kitchen_fire_at).toBe(fireAt);

    await createPrinter({
      tenantId: placed.tenant_id,
      locationId: placed.location_id,
      label: "Kitchen",
      protocol: "star_cloudprnt",
    });
    await driver.setPrintAutoPrint(placed.tenant_id, placed.location_id, true);

    const { won } = await finalizeOnlinePayment(placed.id);
    expect(won).toBe(true);
    await new Promise((r) => setTimeout(r, 20)); // let a (wrong) auto-print land
    const paid = (await driver.getOrder(placed.id))!;
    expect(paid.status).toBe("paid");
    expect(paid.fulfillment?.kitchen_fire_at).toBe(fireAt);

    const board = (at: Date) =>
      driver
        .listOrders(placed.tenant_id, placed.location_id)
        .then((os) =>
          buildTickets(os, at, DEFAULT_KDS_THRESHOLDS, {
            prepMinutes: prep,
          }).filter((t) => t.order.id === placed.id),
        );

    // Wednesday: not on the board, not printed, not released by the sweep.
    expect(await board(WED_10AM)).toEqual([]);
    expect(await jobs(placed)).toHaveLength(0);
    expect(await releaseDueScheduledOrders(WED_10AM)).toMatchObject({
      released: 0,
    });
    expect(await jobs(placed)).toHaveLength(0);

    // Friday at fire time: on the board (fresh), printed once by the sweep.
    const fire = new Date(fireAt);
    vi.setSystemTime(fire);
    const [t] = await board(new Date(fire.getTime() + 30_000));
    expect(t?.elapsedSeconds).toBe(30);
    expect(t?.scheduledFor).toBe(FRI_1PM);

    const res = await fireCronGET(
      new Request("http://localhost/api/cron/fire-scheduled-orders"),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      released: 1,
      printed: 1,
      failed: 0,
    });
    expect(await jobs(placed)).toHaveLength(1);
    expect(
      (await driver.getOrder(placed.id))?.fulfillment?.kitchen_released_at,
    ).toBe(fire.toISOString());

    // Idempotent: a re-run neither lists nor prints it again.
    expect(
      await releaseDueScheduledOrders(new Date(fire.getTime() + MIN)),
    ).toMatchObject({
      released: 0,
    });
    expect(await jobs(placed)).toHaveLength(1);
  });

  it("an ASAP order still prints on payment", async () => {
    const res = await shopOrdersPOST(
      new Request("http://localhost/api/shop/orders", {
        method: "POST",
        headers: { "x-forwarded-for": "10.1.1.8" },
        body: JSON.stringify({
          id: crypto.randomUUID(),
          tenantSlug: "tonys-pizza",
          locationSlug: "tonys-uptown",
          items: [
            {
              id: "l1",
              item_id: "30000000-0000-0000-0000-000000000010",
              size_id: "40000000-0000-0000-0000-000000000021",
              quantity: 1,
              modifiers: [],
            },
          ],
          fulfillmentType: "pickup",
          scheduledFor: "asap",
          customer: { email: `asap-${Date.now()}@example.com`, name: "Sam" },
        }),
      }),
    );
    // 10:00 EST is before the 11:00 open: ASAP is refused in store time...
    expect(res.status).toBe(422);
    // ...and allowed at noon EST.
    vi.setSystemTime(new Date("2026-11-18T17:00:00.000Z"));
    const res2 = await shopOrdersPOST(
      new Request("http://localhost/api/shop/orders", {
        method: "POST",
        headers: { "x-forwarded-for": "10.1.1.9" },
        body: JSON.stringify({
          id: crypto.randomUUID(),
          tenantSlug: "tonys-pizza",
          locationSlug: "tonys-uptown",
          items: [
            {
              id: "l1",
              item_id: "30000000-0000-0000-0000-000000000010",
              size_id: "40000000-0000-0000-0000-000000000021",
              quantity: 1,
              modifiers: [],
            },
          ],
          fulfillmentType: "pickup",
          scheduledFor: "asap",
          customer: { email: `asap2-${Date.now()}@example.com`, name: "Sam" },
        }),
      }),
    );
    expect(res2.status).toBe(201);
    const placed = ((await res2.json()) as { order: Order }).order;
    expect(placed.fulfillment?.kitchen_fire_at).toBeUndefined();
    await createPrinter({
      tenantId: placed.tenant_id,
      locationId: placed.location_id,
      label: "Kitchen",
      protocol: "star_cloudprnt",
    });
    await getPosDriver().setPrintAutoPrint(
      placed.tenant_id,
      placed.location_id,
      true,
    );
    await finalizeOnlinePayment(placed.id);
    await new Promise((r) => setTimeout(r, 20));
    expect(await jobs(placed)).toHaveLength(1);
  });
});
