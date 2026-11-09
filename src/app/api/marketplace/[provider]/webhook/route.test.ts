import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEMO_LOCATION_DOWNTOWN_ID as L,
  DEMO_TENANT_ID as T,
  getPosDriver,
} from "@/lib/db";
import { resetMockOrders } from "@/lib/db/mock";
import { hmacSha256Hex } from "@/lib/marketplace/crypto";
import { POST } from "./route";

const SECRET = "gh-secret";
const order = (id: string, store: string | null = "gh-store-1") =>
  JSON.stringify({
    event_type: "order.created",
    order_id: id,
    ...(store ? { merchant_id: store } : {}),
    order_type: "PICKUP",
    items: [{ id: "i1", name: "Slice", quantity: 1, price: 450 }],
    tax: 37,
  });
const sign = (raw: string, secret = SECRET) => ({
  "x-grubhub-signature": hmacSha256Hex(secret, raw),
});

function call(provider: string, body: string, headers: Record<string, string>) {
  // No tenant/location in the URL: routing is by the store id in the signed payload.
  const req = new Request(`http://x/api/marketplace/${provider}/webhook`, {
    method: "POST",
    body,
    headers,
  });
  return POST(req, { params: Promise.resolve({ provider }) });
}

async function enable(store = "gh-store-1") {
  await getPosDriver().assignMarketplaceStore({
    provider: "grubhub",
    tenantId: T,
    locationId: L,
    storeId: store,
  });
  await getPosDriver().setMarketplaceSettings(T, L, {
    enabled: true,
    auto_accept: false,
    providers: { grubhub: { enabled: true, store_id: store } },
  });
}

beforeEach(async () => {
  vi.stubEnv("GRUBHUB_WEBHOOK_SECRET", SECRET);
  resetMockOrders();
  await getPosDriver().setMarketplaceSettings(T, L, {
    enabled: false,
    auto_accept: false,
    providers: {},
  });
});
afterEach(() => vi.unstubAllEnvs());

describe("POST /api/marketplace/[provider]/webhook", () => {
  it("never serves the simulator or an unknown provider (404)", async () => {
    const raw = order("X");
    expect((await call("simulator", raw, sign(raw))).status).toBe(404);
    expect((await call("nope", raw, sign(raw))).status).toBe(404);
  });

  it("answers one uniform 404 for a disabled location and an unknown store", async () => {
    const raw = order("G-1");
    const disabled = await call("grubhub", raw, sign(raw)); // nothing enabled yet
    await enable();
    const raw2 = order("G-2", "no-such-store");
    const unknown = await call("grubhub", raw2, sign(raw2));
    expect(disabled.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(await disabled.json()).toEqual(await unknown.json());
  });

  it("401s a bad or non-hex signature (never 500), 503s with no credentials", async () => {
    await enable();
    const raw = order("G-3");
    expect((await call("grubhub", raw, sign(raw, "wrong"))).status).toBe(401);
    expect(
      (await call("grubhub", raw, { "x-grubhub-signature": "not-hex!!" }))
        .status,
    ).toBe(401);
    expect((await call("grubhub", raw, {})).status).toBe(401);
    vi.unstubAllEnvs();
    expect((await call("grubhub", raw, sign(raw))).status).toBe(503);
  });

  it("routes by the signed store id, creates once, replays as duplicate", async () => {
    await enable();
    const raw = order("G-4");
    const ok = await call("grubhub", raw, sign(raw));
    expect(ok.status).toBe(200);
    const created = await ok.json();
    expect(created.status).toBe("created");
    const order1 = await getPosDriver().getOrder(created.orderId);
    expect(order1).toMatchObject({
      tenant_id: T,
      location_id: L,
      channel: "marketplace",
    });
    const again = await call("grubhub", raw, sign(raw));
    expect((await again.json()).status).toBe("duplicate");
  });

  it("rejects a signed payload that names no store id (422)", async () => {
    await enable();
    const raw = order("G-5", null);
    expect((await call("grubhub", raw, sign(raw))).status).toBe(422);
  });
});
