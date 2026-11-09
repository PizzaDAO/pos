import { describe, it, expect, vi, beforeEach } from "vitest";
import { getPosDriver, type CreateOrderInput, type OrderChannel } from "@/lib/db";
import { resetMockOrders } from "@/lib/db/mock";

vi.mock("@/lib/auth/tenant-guard", async () => {
  const { getPosDriver } = await import("@/lib/db");
  return {
    requireTenantAccess: async (
      tenantId: string,
      _s: string,
      o?: { locationId?: string },
    ) => ({ ok: true, tenantId, locationId: o?.locationId ?? null }),
    requireOrderAccess: async (id: string) => ({
      ok: true,
      order: await getPosDriver().getOrder(id),
    }),
  };
});

import { GET, POST } from "@/app/api/kitchen/orders/route";

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

  it("a delivery switched to in-house (record says in_house_manual, fulfillment still openpizza_driver) can be handed off", async () => {
    const id = await seed("online_delivery", "openpizza_driver");
    const now = new Date().toISOString();
    await getPosDriver().upsertDelivery({
      id: `del-${id}`,
      order_id: id,
      tenant_id: TENANT,
      location_id: LOCATION,
      provider: "in_house_manual",
      status: "pending_assignment",
      zone_id: null,
      fee_cents: 0,
      currency: "USD",
      eta_minutes: null,
      provider_delivery_id: null,
      tracking_ref: null,
      created_at: now,
      updated_at: now,
    } as unknown as Parameters<ReturnType<typeof getPosDriver>["upsertDelivery"]>[0]);

    // The board ticket carries the record's provider (so the card shows the button).
    const board = await (
      await GET(
        new Request(`http://x/api/kitchen/orders?tenantId=${TENANT}&locationId=${LOCATION}`),
      )
    ).json();
    const ticket = board.tickets.find((t: { order: { id: string } }) => t.order.id === id);
    expect(ticket.deliveryProvider).toBe("in_house_manual");

    expect((await bump(id)).order.status).toBe("out_for_delivery");
    expect((await bump(id)).order.status).toBe("completed");
  });

  it("with no delivery record, the fulfillment provider decides (driver module: no bump)", async () => {
    const id = await seed("online_delivery", "openpizza_driver");
    expect((await bump(id)).changed).toBe(false);
  });
});
