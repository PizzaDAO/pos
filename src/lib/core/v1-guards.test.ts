/**
 * `/api/v1` write guards: parity with the security branch's routes (discounts,
 * tips, plan/tenant status, hours, held orders), atomic transitions and the
 * request-hardening cases.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { Principal } from "@openpizza/core";
import {
  getPosDriver,
  DEMO_LOCATION_DOWNTOWN_ID,
  DEMO_LOCATION_UPTOWN_ID,
  DEMO_TENANT_ID,
} from "@/lib/db";
import { resetMockOnline, resetMockOrders, resetMockPayments } from "@/lib/db/mock";
import { DEV_TOKEN } from "./auth";
import { handleV1 } from "./v1";
import { memoryOutbox } from "./outbox";

// Thursday 2026-06-04 18:00 America/New_York (open 11:00-22:00).
const NOW = new Date("2026-06-04T22:00:00.000Z");
const OTHER_TENANT = "20000000-0000-4000-8000-0000000000bb";

function principal(scopes: string[], extra: Partial<Principal> = {}): Principal {
  return {
    kind: "service",
    id: "t",
    tenant_id: DEMO_TENANT_ID,
    location_ids: null,
    scopes,
    module: "guests",
    ...extra,
  };
}

const agent = () =>
  principal(["orders:read", "orders:write", "quotes:write", "menu:read", "customers:write"]);

async function call(
  method: string,
  path: string,
  opts: { body?: unknown; p?: Principal; now?: Date } = {},
) {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (!opts.p) headers.authorization = `Bearer ${DEV_TOKEN}`;
  const res = await handleV1(
    new Request(`https://pos.test/api/v1${path}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    }),
    path.split("/").filter(Boolean),
    { now: () => opts.now ?? NOW, principal: opts.p },
  );
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

async function orderBody(extra: Record<string, unknown> = {}, id?: string) {
  const { json: menu } = await call("GET", `/locations/${DEMO_LOCATION_DOWNTOWN_ID}/menu`);
  const item = menu.categories
    .flatMap((c: { items: unknown[] }) => c.items)
    .find((i: { name: string }) => i.name === "Pepperoni");
  const large = item.sizes.find((s: { name: string }) => s.name.startsWith("Large"));
  return {
    ...(id ? { id } : {}),
    location_id: DEMO_LOCATION_DOWNTOWN_ID,
    lines: [{ item_id: item.id, size_id: large.id, quantity: 1 }],
    channel: "agent",
    source: { type: "agent_api" },
    payment_intent: "pay_at_counter",
    ...extra,
  } as Record<string, unknown> & { lines: { item_id: string; size_id?: string; quantity: number }[] };
}

const pay = (orderId: string, status: "pending" | "captured", amount = 100) => ({
  id: `e4000000-0000-4000-8000-${orderId.slice(-12)}`,
  order_id: orderId,
  tenant_id: DEMO_TENANT_ID,
  location_id: DEMO_LOCATION_DOWNTOWN_ID,
  rail: "stripe_online" as const,
  status,
  amount_cents: amount,
  tip_cents: 0,
  application_fee_cents: 0,
  currency: "USD",
  charge_id: null,
  connect_account_id: null,
  crypto_tx_hash: null,
  crypto_chain: null,
  cash_tendered_cents: null,
  cash_change_cents: null,
  refunded_cents: 0,
  simulated: true,
  raw: null,
  created_at: NOW.toISOString(),
  updated_at: NOW.toISOString(),
});

beforeEach(() => {
  resetMockOrders();
  resetMockPayments();
  resetMockOnline();
  memoryOutbox.clear();
});

describe("write guards", () => {
  it("non-terminal principals get HELD orders even for pay_at_counter; terminals are placed", async () => {
    const b = await orderBody({}, "b1000000-0000-4000-8000-000000000001");
    const held = await call("POST", "/orders", { p: agent(), body: b });
    expect(held.status).toBe(201);
    expect(held.json.fulfillment_status).toBe("held");

    const terminal = principal(["orders:*", "orders:place_direct", "quotes:write", "menu:read"]);
    const placed = await call("POST", "/orders", {
      p: terminal,
      body: {
        ...b,
        id: "b1000000-0000-4000-8000-000000000002",
        channel: "in_store",
        source: { type: "pos_terminal" },
      },
    });
    expect(placed.json.fulfillment_status).toBe("placed");
  });

  it("adjustments need orders:discount", async () => {
    const b = await orderBody({
      adjustments: [{ type: "discount", source: "x", label: "free", amount_cents: 500 }],
    });
    const denied = await call("POST", "/orders", { p: agent(), body: b });
    expect(denied.status).toBe(403);
    expect(denied.json.code).toBe("INSUFFICIENT_SCOPE");
    const ok = await call("POST", "/orders", {
      p: principal([...agent().scopes, "orders:discount"]),
      body: { ...b, id: "b2000000-0000-4000-8000-000000000001" },
    });
    expect(ok.status).toBe(201);
    expect(ok.json.totals.discount_cents).toBe(500);
  });

  it("caps absurd tips", async () => {
    const b = await orderBody({ tip: { amount_cents: 5_000_000 } });
    const r = await call("POST", "/orders", { p: agent(), body: b });
    expect(r.status).toBe(422);
    expect(r.json.path).toBe("tip");
  });

  it("suspended tenants cannot write; reads still work", async () => {
    const driver = getPosDriver();
    await driver.setTenantStatus(DEMO_TENANT_ID, "suspended");
    try {
      const b = await orderBody();
      expect((await call("POST", "/orders", { body: b })).status).toBe(403);
      const put = await call("PUT", `/locations/${DEMO_LOCATION_DOWNTOWN_ID}/menu/availability`, {
        body: { target_type: "item", target_id: b.lines[0]!.item_id, available: false },
      });
      expect(put.status).toBe(403);
      expect((await call("GET", "/tenant")).status).toBe(200);
    } finally {
      await driver.setTenantStatus(DEMO_TENANT_ID, "active");
    }
  });

  it("non-terminals cannot bypass hours with channel in_store", async () => {
    const b = await orderBody({ channel: "in_store", source: { type: "kiosk" } });
    const closed = await call("POST", "/orders", {
      p: agent(),
      body: b,
      now: new Date("2026-06-05T08:00:00.000Z"), // 04:00 local
    });
    expect(closed.status).toBe(422);
    expect(closed.json.errors[0].code).toBe("STORE_CLOSED");
  });

  it("releasing an awaiting_payment hold needs full payment or orders:release_unpaid", async () => {
    const b = await orderBody({}, "b3000000-0000-4000-8000-000000000001");
    const created = await call("POST", "/orders", { p: agent(), body: b });
    const id = created.json.id as string;
    const denied = await call("POST", `/orders/${id}/release`, { p: agent(), body: {} });
    expect(denied.status).toBe(402);
    expect(denied.json.code).toBe("PAYMENT_REQUIRED");
    const ok = await call("POST", `/orders/${id}/release`, {
      p: principal([...agent().scopes, "orders:release_unpaid"]),
      body: {},
    });
    expect(ok.json.fulfillment_status).toBe("placed");
  });

  it("cancel refuses while a payment is in flight", async () => {
    const b = await orderBody({}, "b4000000-0000-4000-8000-000000000001");
    const created = await call("POST", "/orders", { p: agent(), body: b });
    await getPosDriver().upsertPayment(pay(created.json.id, "pending"));
    const r = await call("POST", `/orders/${created.json.id}/cancel`, {
      p: agent(),
      body: { reason: "x" },
    });
    expect(r.status).toBe(409);
    expect(r.json.code).toBe("CANCEL_NOT_ALLOWED");
  });
});

describe("tender settlement + active staff", () => {
  it("cancel voids an abandoned (stale, never-on-rail) tender but not a live one", async () => {
    const driver = getPosDriver();
    const stale = await call("POST", "/orders", {
      p: agent(),
      body: await orderBody({}, "b7000000-0000-4000-8000-000000000001"),
    });
    const old = { ...pay(stale.json.id, "pending"), created_at: new Date(NOW.getTime() - 3_600_000).toISOString() };
    await driver.upsertPayment(old);
    const ok = await call("POST", `/orders/${stale.json.id}/cancel`, { p: agent(), body: { reason: "x" } });
    expect(ok.status).toBe(200);
    expect((await driver.getPayment(old.id))?.status).toBe("canceled");

    const live = await call("POST", "/orders", {
      p: agent(),
      body: await orderBody({}, "b7000000-0000-4000-8000-000000000002"),
    });
    await driver.upsertPayment({ ...pay(live.json.id, "pending"), charge_id: "pi_live", created_at: old.created_at });
    const refused = await call("POST", `/orders/${live.json.id}/cancel`, { p: agent(), body: { reason: "x" } });
    expect(refused.status).toBe(409);
  });

  it("staff attribution must be an ACTIVE staff member", async () => {
    const driver = getPosDriver();
    const now = new Date().toISOString();
    const gone = await driver.upsertStaff({
      id: "44000000-0000-4000-8000-0000000000aa",
      tenant_id: DEMO_TENANT_ID,
      name: "Left",
      role: "cashier",
      active: false,
      created_at: now,
    });
    const r = await call("POST", "/orders", {
      p: agent(),
      body: await orderBody({ staff_id: gone.id }, "b8000000-0000-4000-8000-000000000001"),
    });
    expect(r.status).toBe(404);
  });
});

describe("literal order-money scopes + hold reason", () => {
  it("a caller-chosen hold reason cannot dodge the unpaid-release check", async () => {
    const b = await orderBody(
      { hold: { reason: "manual" }, payment_intent: "prepaid" },
      "b9000000-0000-4000-8000-000000000001",
    );
    const created = await call("POST", "/orders", { p: agent(), body: b });
    expect(created.status).toBe(201);
    expect(created.json.hold.reason).toBe("awaiting_payment");
    const denied = await call("POST", `/orders/${created.json.id}/release`, { p: agent(), body: {} });
    expect(denied.status).toBe(402);
  });

  it("release checks payment for ANY hold reason (a terminal-made manual hold too)", async () => {
    const terminal = principal(["orders:place_direct", "orders:write", "quotes:write", "menu:read"]);
    const b = await orderBody(
      { hold: { reason: "manual" }, channel: "in_store", source: { type: "pos_terminal" } },
      "b9000000-0000-4000-8000-000000000002",
    );
    const created = await call("POST", "/orders", { p: terminal, body: b });
    expect(created.json.hold.reason).toBe("manual");
    const denied = await call("POST", `/orders/${created.json.id}/release`, { p: terminal, body: {} });
    expect(denied.status).toBe(402);
  });

  it("*, orders:* and *:write do not grant discount / place_direct / release_unpaid", async () => {
    for (const scopes of [["*"], ["orders:*", "quotes:write"], ["*:write", "orders:write", "quotes:write"]]) {
      const p = principal(scopes);
      const disc = await call("POST", "/orders", {
        p,
        body: await orderBody({ adjustments: [{ type: "discount", source: "x", label: "y", amount_cents: 100 }] }),
      });
      expect(disc.status, scopes.join()).toBe(403);
      const placed = await call("POST", "/orders", { p, body: await orderBody({ channel: "in_store" }) });
      expect(placed.json.fulfillment_status, scopes.join()).toBe("held");
    }
  });
});

describe("atomic transitions", () => {
  it("only one caller wins draft -> placed and inventory depletes once", async () => {
    const driver = getPosDriver();
    const id = "b5000000-0000-4000-8000-000000000001";
    await call("POST", "/orders", { p: agent(), body: await orderBody({}, id) });
    const rp = principal([...agent().scopes, "orders:release_unpaid"]);
    const results = await Promise.all([
      call("POST", `/orders/${id}/release`, { p: rp, body: {} }),
      call("POST", `/orders/${id}/release`, { p: rp, body: {} }),
      driver.casOrderStatus(id, ["draft"], "placed"),
    ]);
    expect(results[0]!.status).toBe(200);
    expect(results[1]!.status).toBe(200);
    const moves = (
      await driver.listInventoryMovements(DEMO_TENANT_ID, DEMO_LOCATION_DOWNTOWN_ID)
    ).filter((m) => m.order_id === id && m.reason === "depletion");
    expect(moves.length).toBeGreaterThan(0);
    expect(new Set(moves.map((m) => m.inventory_item_id)).size).toBe(moves.length);
    const again = await driver.casOrderStatus(id, ["draft"], "placed");
    expect(again.ok).toBe(false);
    // exactly one order.placed announced
    expect(memoryOutbox.rows.filter((r) => r.event_type === "order.placed")).toHaveLength(1);
  });
});

describe("request hardening", () => {
  it("foreign / out-of-scope ids in a replay look like a plain conflict", async () => {
    const b = await orderBody({}, "b6000000-0000-4000-8000-000000000001");
    await call("POST", "/orders", { p: agent(), body: b });
    const mismatch = await call("POST", "/orders", {
      p: agent(),
      body: { ...b, lines: [{ ...b.lines[0], quantity: 7 }] },
    });
    expect(mismatch.status).toBe(409);
    // a foreign tenant never even reaches the order lookup (its location check fails)
    const foreign = await call("POST", "/orders", {
      p: principal(agent().scopes, { tenant_id: OTHER_TENANT }),
      body: b,
    });
    expect([403, 404]).toContain(foreign.status);
    // a location-limited token reusing the id from ANOTHER location of the same
    // tenant gets the same neutral conflict, not the existing order
    const limited = principal(agent().scopes, { location_ids: [DEMO_LOCATION_UPTOWN_ID] });
    const leak = await call("POST", "/orders", {
      p: limited,
      body: { ...b, location_id: DEMO_LOCATION_UPTOWN_ID },
    });
    expect(leak.status).toBe(409);
    expect(leak.json.detail).toBe(mismatch.json.detail);
  });

  it("malformed percent-escapes are 400; oversized bodies are 413", async () => {
    expect((await call("GET", "/orders/%E0%A4%A")).status).toBe(400);
    const big = await handleV1(
      new Request("https://pos.test/api/v1/quotes", {
        method: "POST",
        headers: { authorization: `Bearer ${DEV_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ pad: "x".repeat(300_000) }),
      }),
      ["quotes"],
    );
    expect(big.status).toBe(413);
  });
});
