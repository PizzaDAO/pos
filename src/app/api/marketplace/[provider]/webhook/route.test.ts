import { beforeEach, describe, expect, it } from "vitest";
import {
  DEMO_LOCATION_DOWNTOWN_ID as L,
  DEMO_TENANT_ID as T,
  getPosDriver,
} from "@/lib/db";
import { resetMockOrders } from "@/lib/db/mock";
import {
  buildSimulatedOrder,
  signSimulatedWebhook,
} from "@/lib/marketplace/adapters/simulator";
import { SIMULATOR_DEV_SECRET } from "@/lib/marketplace/env";
import { POST } from "./route";

function call(
  provider: string,
  body: string,
  headers: Record<string, string>,
  loc = L,
) {
  const req = new Request(
    `http://x/api/marketplace/${provider}/webhook?tenantId=${T}&locationId=${loc}`,
    { method: "POST", body, headers },
  );
  return POST(req, { params: Promise.resolve({ provider }) });
}

beforeEach(async () => {
  resetMockOrders();
  await getPosDriver().setMarketplaceSettings(T, L, {
    enabled: false,
    auto_accept: false,
    providers: {},
  });
});

describe("POST /api/marketplace/[provider]/webhook", () => {
  const s = signSimulatedWebhook(
    buildSimulatedOrder(1, { externalId: "SIM-ROUTE" }),
    SIMULATOR_DEV_SECRET,
  );

  it("is 403 while the location has the marketplace off (the default)", async () => {
    expect((await call("simulator", s.rawBody, s.headers)).status).toBe(403);
  });

  it("404s an unknown provider and an unknown location", async () => {
    expect((await call("nope", s.rawBody, s.headers)).status).toBe(404);
    expect(
      (
        await call(
          "simulator",
          s.rawBody,
          s.headers,
          "00000000-0000-0000-0000-000000000000",
        )
      ).status,
    ).toBe(404);
  });

  it("401s a bad signature, 200s a good one, and replays as duplicate", async () => {
    await getPosDriver().setMarketplaceSettings(T, L, {
      enabled: true,
      auto_accept: false,
      providers: { simulator: { enabled: true, store_id: null } },
    });
    expect(
      (await call("simulator", s.rawBody, { "x-simulator-signature": "00" }))
        .status,
    ).toBe(401);
    const ok = await call("simulator", s.rawBody, s.headers);
    expect(ok.status).toBe(200);
    expect((await ok.json()).status).toBe("created");
    const again = await call("simulator", s.rawBody, s.headers);
    expect(again.status).toBe(200);
    expect((await again.json()).status).toBe("duplicate");
  });
});
