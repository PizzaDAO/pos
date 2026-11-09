import { beforeEach, describe, expect, it } from "vitest";
import {
  DEMO_LOCATION_DOWNTOWN_ID as L,
  DEMO_TENANT_ID as T,
  getPosDriver,
} from "@/lib/db";
import { resetMockOrders } from "@/lib/db/mock";
import { PUT } from "./route";

const put = (providers: Record<string, unknown>) =>
  PUT(
    new Request("http://x/api/admin/marketplace", {
      method: "PUT",
      body: JSON.stringify({
        tenantId: T,
        locationId: L,
        enabled: true,
        auto_accept: false,
        providers,
      }),
    }),
  );

beforeEach(async () => {
  resetMockOrders();
  await getPosDriver().setMarketplaceSettings(T, L, {
    enabled: false,
    auto_accept: false,
    providers: {},
  });
});

describe("PUT /api/admin/marketplace (tenant owner)", () => {
  it("cannot enable a real provider that has no admin-assigned store", async () => {
    expect(
      (await put({ doordash: { enabled: true, store_id: "dd-1" } })).status,
    ).toBe(422);
  });

  it("cannot set or change a store id: the body value is ignored", async () => {
    await getPosDriver().assignMarketplaceStore({
      provider: "doordash",
      tenantId: T,
      locationId: L,
      storeId: "dd-real",
    });
    await getPosDriver().setMarketplaceSettings(T, L, {
      enabled: false,
      auto_accept: false,
      providers: { doordash: { enabled: false, store_id: "dd-real" } },
    });
    const res = await put({
      doordash: { enabled: true, store_id: "someone-elses-store" },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).settings.providers.doordash).toEqual({
      enabled: true,
      store_id: "dd-real",
    });
    expect(
      await getPosDriver().findMarketplaceLocations(
        "doordash",
        "someone-elses-store",
      ),
    ).toHaveLength(0);
  });

  it("an omitted provider keeps its assignment but is switched off", async () => {
    await getPosDriver().assignMarketplaceStore({
      provider: "grubhub",
      tenantId: T,
      locationId: L,
      storeId: "g1",
    });
    await getPosDriver().setMarketplaceSettings(T, L, {
      enabled: true,
      auto_accept: false,
      providers: { grubhub: { enabled: true, store_id: "g1" } },
    });
    const res = await put({ simulator: { enabled: true, store_id: null } });
    expect((await res.json()).settings.providers.grubhub).toEqual({
      enabled: false,
      store_id: "g1",
    });
  });

  it("changing marketplace settings leaves tax and tips alone", async () => {
    const before = await getPosDriver().getStoreSettings(T, L);
    await put({ simulator: { enabled: true, store_id: null } });
    const after = await getPosDriver().getStoreSettings(T, L);
    expect({ ...after, marketplace: undefined }).toEqual({
      ...before,
      marketplace: undefined,
    });
    expect(after.marketplace?.providers.simulator?.enabled).toBe(true);
  });
});
