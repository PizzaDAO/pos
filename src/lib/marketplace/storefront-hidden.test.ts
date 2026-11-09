/**
 * The anonymous storefront must not see or touch marketplace orders (they carry
 * the customer's name/phone and the provider order id), and a store-id clash must
 * leave the existing assignment intact.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  DEMO_LOCATION_DOWNTOWN_ID as L,
  DEMO_LOCATION_UPTOWN_ID as L2,
  DEMO_TENANT_ID as T,
  getPosDriver,
} from "@/lib/db";
import { resetMockOrders } from "@/lib/db/mock";
import { POST as cancel } from "@/app/api/shop/orders/cancel/route";
import { POST as placeOrder } from "@/app/api/shop/orders/route";
import { POST as paySync } from "@/app/api/shop/orders/[id]/pay/sync/route";
import { GET as track } from "@/app/api/shop/track/route";
import {
  buildSimulatedOrder,
  signSimulatedWebhook,
} from "./adapters/simulator";
import { SIMULATOR_DEV_SECRET } from "./env";
import { MarketplaceStoreTakenError } from "./guard";
import { ingestMarketplaceWebhook } from "./service";

let orderId: string;

beforeEach(async () => {
  resetMockOrders();
  await getPosDriver().setMarketplaceSettings(T, L, {
    enabled: true,
    auto_accept: false,
    providers: { simulator: { enabled: true, store_id: null } },
  });
  const s = signSimulatedWebhook(
    buildSimulatedOrder(1, { externalId: "SIM-SHOP" }),
    SIMULATOR_DEV_SECRET,
  );
  const r = await ingestMarketplaceWebhook({
    provider: "simulator",
    location: { tenantId: T, locationId: L },
    rawBody: s.rawBody,
    headers: s.headers,
  });
  orderId = r.orderId!;
});

const json = (url: string, body: unknown) =>
  new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("storefront routes hide marketplace orders", () => {
  it("cancel cannot void a pending marketplace order", async () => {
    expect(
      (await cancel(json("http://x/api/shop/orders/cancel", { orderId })))
        .status,
    ).toBe(404);
    expect((await getPosDriver().getOrder(orderId))!.status).toBe("placed");
  });

  it("track returns 404 (no name, phone or external id)", async () => {
    const res = await track(
      new Request(`http://x/api/shop/track?orderId=${orderId}`),
    );
    expect(res.status).toBe(404);
    expect(JSON.stringify(await res.json())).not.toMatch(/SIM-SHOP/);
  });

  it("pay sync returns 404", async () => {
    const res = await paySync(
      json(`http://x/api/shop/orders/${orderId}/pay/sync`, {}),
      {
        params: Promise.resolve({ id: orderId }),
      },
    );
    expect(res.status).toBe(404);
  });

  it("placing an order with a marketplace order's id does not echo it back", async () => {
    const res = await placeOrder(
      json("http://x/api/shop/orders", {
        id: orderId,
        locationSlug: "y",
        items: [],
        fulfillmentType: "pickup",
        scheduledFor: "asap",
        customer: { email: "a@b.co" },
      }),
    );
    expect(res.status).toBe(404);
    expect(JSON.stringify(await res.json())).not.toMatch(/SIM-SHOP/);
  });
});

describe("assignMarketplaceStore clash", () => {
  it("a clash with another location's store id leaves the old assignment intact", async () => {
    const d = getPosDriver();
    await d.assignMarketplaceStore({
      provider: "doordash",
      tenantId: T,
      locationId: L,
      storeId: "mine",
    });
    await d.assignMarketplaceStore({
      provider: "doordash",
      tenantId: T,
      locationId: L2,
      storeId: "theirs",
    });
    await expect(
      d.assignMarketplaceStore({
        provider: "doordash",
        tenantId: T,
        locationId: L2,
        storeId: "mine",
      }),
    ).rejects.toBeInstanceOf(MarketplaceStoreTakenError);
    expect(await d.findMarketplaceLocations("doordash", "theirs")).toEqual([
      { tenant_id: T, location_id: L2 },
    ]);
    expect(await d.findMarketplaceLocations("doordash", "mine")).toEqual([
      { tenant_id: T, location_id: L },
    ]);
    // replacing your own store works, and clearing still deletes
    await d.assignMarketplaceStore({
      provider: "doordash",
      tenantId: T,
      locationId: L2,
      storeId: "theirs-2",
    });
    expect(await d.findMarketplaceLocations("doordash", "theirs")).toHaveLength(
      0,
    );
    await d.assignMarketplaceStore({
      provider: "doordash",
      tenantId: T,
      locationId: L2,
      storeId: null,
    });
    expect(
      await d.findMarketplaceLocations("doordash", "theirs-2"),
    ).toHaveLength(0);
  });
});
