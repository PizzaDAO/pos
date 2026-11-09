import { beforeEach, describe, expect, it } from "vitest";
import {
  DEMO_LOCATION_DOWNTOWN_ID as L,
  DEMO_LOCATION_UPTOWN_ID as L2,
  DEMO_TENANT_ID as T,
  getPosDriver,
} from "@/lib/db";
import { resetMockOrders } from "@/lib/db/mock";
import { PUT } from "./route";

const put = (body: Record<string, unknown>) =>
  PUT(
    new Request("http://x/api/platform/marketplace", {
      method: "PUT",
      body: JSON.stringify({ tenantId: T, ...body }),
    }),
  );

beforeEach(() => resetMockOrders());

describe("PUT /api/platform/marketplace (platform admin)", () => {
  it("assigns a store, mirrors it into settings, and routes webhooks to it", async () => {
    const res = await put({
      locationId: L,
      provider: "doordash",
      storeId: "dd-1",
    });
    expect(res.status).toBe(200);
    expect(
      (await getPosDriver().getStoreSettings(T, L)).marketplace?.providers
        .doordash?.store_id,
    ).toBe("dd-1");
    expect(
      await getPosDriver().findMarketplaceLocations("doordash", "dd-1"),
    ).toEqual([{ tenant_id: T, location_id: L }]);
  });

  it("two locations can never hold the same store id; re-assigning the same location is fine", async () => {
    expect(
      (await put({ locationId: L, provider: "ubereats", storeId: "u-1" }))
        .status,
    ).toBe(200);
    expect(
      (await put({ locationId: L2, provider: "ubereats", storeId: "u-1" }))
        .status,
    ).toBe(409);
    expect(
      (await put({ locationId: L, provider: "ubereats", storeId: "u-1" }))
        .status,
    ).toBe(200);
    // the same id under another provider is a different store
    expect(
      (await put({ locationId: L2, provider: "grubhub", storeId: "u-1" }))
        .status,
    ).toBe(200);
  });

  it("clearing the store switches the provider off and frees the id", async () => {
    await put({ locationId: L, provider: "grubhub", storeId: "g-1" });
    await getPosDriver().setMarketplaceSettings(T, L, {
      enabled: true,
      auto_accept: false,
      providers: { grubhub: { enabled: true, store_id: "g-1" } },
    });
    expect(
      (await put({ locationId: L, provider: "grubhub", storeId: null })).status,
    ).toBe(200);
    expect(
      (await getPosDriver().getStoreSettings(T, L)).marketplace?.providers
        .grubhub,
    ).toEqual({ enabled: false, store_id: null });
    expect(
      (await put({ locationId: L2, provider: "grubhub", storeId: "g-1" }))
        .status,
    ).toBe(200);
  });

  it("refuses the simulator and an unknown location", async () => {
    expect(
      (await put({ locationId: L, provider: "simulator", storeId: "x" }))
        .status,
    ).toBe(422);
    expect(
      (
        await put({
          locationId: "00000000-0000-0000-0000-000000000000",
          provider: "doordash",
          storeId: "x",
        })
      ).status,
    ).toBe(404);
  });
});
