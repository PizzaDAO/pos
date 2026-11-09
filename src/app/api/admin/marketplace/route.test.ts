import { beforeEach, describe, expect, it } from "vitest";
import {
  DEMO_LOCATION_DOWNTOWN_ID as L,
  DEMO_LOCATION_UPTOWN_ID as L2,
  DEMO_TENANT_ID as T,
  getPosDriver,
} from "@/lib/db";
import { PUT } from "./route";

const put = (locationId: string, providers: Record<string, unknown>) =>
  PUT(
    new Request("http://x/api/admin/marketplace", {
      method: "PUT",
      body: JSON.stringify({
        tenantId: T,
        locationId,
        enabled: true,
        auto_accept: false,
        providers,
      }),
    }),
  );

beforeEach(async () => {
  for (const loc of [L, L2]) {
    await getPosDriver().setMarketplaceSettings(T, loc, {
      enabled: false,
      auto_accept: false,
      providers: {},
    });
  }
});

describe("PUT /api/admin/marketplace", () => {
  it("a real provider cannot be enabled without a store id", async () => {
    expect(
      (await put(L, { doordash: { enabled: true, store_id: null } })).status,
    ).toBe(422);
  });

  it("one store id belongs to one location", async () => {
    expect(
      (await put(L, { doordash: { enabled: true, store_id: "dd-1" } })).status,
    ).toBe(200);
    expect(
      (await put(L2, { doordash: { enabled: true, store_id: "dd-1" } })).status,
    ).toBe(409);
    expect(
      (await put(L, { doordash: { enabled: true, store_id: "dd-1" } })).status,
    ).toBe(200); // same location re-save
  });

  it("changing marketplace settings leaves tax and tips alone", async () => {
    const before = await getPosDriver().getStoreSettings(T, L);
    await put(L, { simulator: { enabled: true, store_id: null } });
    const after = await getPosDriver().getStoreSettings(T, L);
    expect({ ...after, marketplace: undefined }).toEqual({
      ...before,
      marketplace: undefined,
    });
    expect(after.marketplace?.providers.simulator?.enabled).toBe(true);
  });
});
