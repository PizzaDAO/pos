import { describe, it, expect, vi, beforeEach } from "vitest";
import { getPosDriver, type CreateOrderInput, type OrderChannel } from "@/lib/db";
import { resetMockOrders } from "@/lib/db/mock";

vi.mock("@/lib/auth/tenant-guard", async () => {
  const { getPosDriver } = await import("@/lib/db");
  return {
    requireTenantAccess: async () => ({ ok: true }),
    requireOrderAccess: async (id: string) => ({
      ok: true,
      order: await getPosDriver().getOrder(id),
    }),
  };
});

import { POST } from "@/app/api/kitchen/orders/route";

const TENANT = "10000000-0000-0000-0000-000000000001";
const LOCATION = "10000000-0000-0000-0000-000000000101";
let seq = 0;

async function seed(channel: OrderChannel, provider?: string): Promise<string> {
  seq += 1;
  const id = `kds-handoff-${seq}`;
  const input = {
    id,
    tenant_id: TENANT,
    location_id: LOCATION,
    channel,
    currency: "USD",
    items: [],
    discount_cents: 0,
    totals: {
      subtotal_cents: 0,
      discount_cents: 0,
      taxable_cents: 0,
      tax_cents: 0,
      tip_cents: 0,
      total_cents: 0,
    },
    notes: null,
    status: "ready",
    ...(channel === "online_delivery"
      ? {
          fulfillment: {
            type: "delivery",
            scheduled_for: "asap",
            promised_at: new Date().toISOString(),
            ...(provider ? { delivery_provider: provider } : {}),
          },
        }
      : {}),
  } as unknown as CreateOrderInput;
  await getPosDriver().createOrder(input);
  await getPosDriver().updateOrderStatus(id, "ready");
  return id;
}

const bump = (id: string) =>
  POST(
    new Request("http://x/api/kitchen/orders", {
      method: "POST",
      body: JSON.stringify({ id, action: "bump" }),
    }),
  ).then((r) => r.json());

beforeEach(() => resetMockOrders());

describe("KDS hand-off bump", () => {
  it("in-store Ready → completed (Picked up)", async () => {
    const id = await seed("in_store");
    const r = await bump(id);
    expect(r.order.status).toBe("completed");
  });

  it("in-house delivery: Ready → out_for_delivery → completed", async () => {
    const id = await seed("online_delivery", "in_house_manual");
    expect((await bump(id)).order.status).toBe("out_for_delivery");
    expect((await bump(id)).order.status).toBe("completed");
  });

  it("DoorDash delivery: the KDS can't move it past Ready", async () => {
    const id = await seed("online_delivery", "doordash_drive");
    const r = await bump(id);
    expect(r.changed).toBe(false);
    expect((await getPosDriver().getOrder(id))?.status).toBe("ready");
  });
});
