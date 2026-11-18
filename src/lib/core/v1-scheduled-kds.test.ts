/**
 * PR #55 review: holding scheduled online orders until their fire time must not
 * touch /v1 orders. A /v1 order maps to channel `online_pickup` and may carry a
 * future `scheduled_for`, but it never has `kitchen_fire_at`: once released (and
 * paid) it is on the KDS like before, both for a catering `scheduled` hold and
 * an `awaiting_payment` hold.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  DEMO_LOCATION_DOWNTOWN_ID,
  DEMO_TENANT_ID,
  getPosDriver,
} from "@/lib/db";
import {
  resetMockOnline,
  resetMockOrders,
  resetMockPayments,
} from "@/lib/db/mock";
import { buildTickets, DEFAULT_KDS_THRESHOLDS } from "@/lib/kds/board";
import type { Principal } from "@openpizza/core";
import { handleV1 } from "./v1";

const T0 = new Date("2026-06-04T22:00:00.000Z");
const IN_TWO_DAYS = new Date(T0.getTime() + 2 * 24 * 3600_000).toISOString();
const cat: Principal = {
  kind: "service",
  id: "hub:c",
  tenant_id: DEMO_TENANT_ID,
  location_ids: null,
  module: "catering",
  scopes: [
    "orders:read",
    "orders:write",
    "orders:release_unpaid",
    "quotes:write",
    "menu:read",
  ],
};

async function call(method: string, path: string, body?: unknown) {
  const res = await handleV1(
    new Request(`https://pos.test/api/v1${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        "idempotency-key": Math.random().toString(36),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    path.split("?")[0]!.split("/").filter(Boolean),
    { now: () => T0, principal: cat },
  );
  const t = await res.text();
  return { status: res.status, json: t ? JSON.parse(t) : null };
}

async function lines() {
  const { json: menu } = await call(
    "GET",
    `/locations/${DEMO_LOCATION_DOWNTOWN_ID}/menu`,
  );
  const item = menu.categories
    .flatMap((c: { items: unknown[] }) => c.items)
    .find((i: { name: string }) => i.name === "Pepperoni");
  const large = item.sizes.find((s: { name: string }) =>
    s.name.startsWith("Large"),
  );
  return [{ item_id: item.id, size_id: large.id, quantity: 1 }];
}

async function boardHas(id: string, at: Date): Promise<boolean> {
  const orders = await getPosDriver().listOrders(
    DEMO_TENANT_ID,
    DEMO_LOCATION_DOWNTOWN_ID,
  );
  return buildTickets(orders, at, DEFAULT_KDS_THRESHOLDS).some(
    (t) => t.order.id === id,
  );
}

beforeEach(() => {
  resetMockOrders();
  resetMockPayments();
  resetMockOnline();
});

describe("/v1 orders are never held by the storefront fire time", () => {
  for (const hold of [
    {
      reason: "scheduled",
      ttl_seconds: 3 * 24 * 3600,
      payment_intent: "invoice",
    },
    { reason: "awaiting_payment", ttl_seconds: 900, payment_intent: "prepaid" },
  ] as const) {
    it(`a released ${hold.reason} hold with a future scheduled_for stays on the board once paid`, async () => {
      const id = globalThis.crypto.randomUUID();
      const created = await call("POST", "/orders", {
        id,
        location_id: DEMO_LOCATION_DOWNTOWN_ID,
        lines: await lines(),
        channel: "agent",
        source: { type: "agent_api" },
        payment_intent: hold.payment_intent,
        hold: { reason: hold.reason, ttl_seconds: hold.ttl_seconds },
        fulfillment: { type: "pickup", scheduled_for: IN_TWO_DAYS },
        fire_at: IN_TWO_DAYS,
      });
      expect(created.status).toBe(201);
      const stored = (await getPosDriver().getOrder(id))!;
      expect(stored.channel).toBe("online_pickup");
      expect(stored.fulfillment?.scheduled_for).toBe(IN_TWO_DAYS);
      expect(stored.fulfillment?.kitchen_fire_at).toBeUndefined();

      const rel = await call("POST", `/orders/${id}/release`, {});
      expect(rel.status).toBe(200);
      expect((await getPosDriver().getOrder(id))!.status).toBe("placed");
      expect(await boardHas(id, T0)).toBe(true);

      // Paid at the counter afterwards: placed -> paid. Still on the board.
      const paid = await getPosDriver().casOrderStatus(id, ["placed"], "paid");
      expect(paid.ok).toBe(true);
      expect(await boardHas(id, T0)).toBe(true);
    });
  }
});
