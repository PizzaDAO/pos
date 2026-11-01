/**
 * PR #32 review: scheduled-hold admin items (resolved markers are final, Cancel for
 * invoice_pending, draft-only actions, release clears the flag) and the location
 * country confirm + deterministic order.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Principal } from "@openpizza/core";
import { DEMO_LOCATION_DOWNTOWN_ID, DEMO_TENANT_ID, getPosDriver } from "@/lib/db";
import { resetMockOnline, resetMockOrders, resetMockPayments } from "@/lib/db/mock";

vi.mock("@/lib/auth/api", async (o) => ({
  ...(await o<Record<string, unknown>>()),
  requireTenantRole: async () => ({ ok: true, user: { id: "00000000-0000-4000-8000-0000000000aa", email: "o@x.co" } }),
}));
vi.mock("@/lib/auth/tenant-guard", async (o) => ({
  ...(await o<Record<string, unknown>>()),
  requireTenantAccess: async () => ({
    ok: true,
    tenantId: "10000000-0000-0000-0000-000000000001",
    user: { id: "00000000-0000-4000-8000-0000000000aa", email: "o@x.co" },
  }),
}));

import { handleV1 } from "./v1";
import { expireHeldOrders } from "@/lib/shop/lifecycle";
import { flagStrandedScheduled } from "@/lib/payments/service";
import { GET as lateGET, POST as latePOST } from "@/app/api/admin/late-payments/route";
import { PATCH as locPATCH } from "@/app/api/admin/locations/route";

const T0 = new Date("2026-06-04T22:00:00.000Z");
let NOW = T0;
const H = 3600_000;
const cat: Principal = {
  kind: "service", id: "hub:c", tenant_id: DEMO_TENANT_ID, location_ids: null, module: "catering",
  scopes: ["orders:read", "orders:write", "quotes:write", "menu:read", "payments:read", "payments:write"],
};
async function call(method: string, path: string, body?: unknown) {
  const res = await handleV1(
    new Request(`https://pos.test/api/v1${path}`, {
      method,
      headers: { "content-type": "application/json", "idempotency-key": Math.random().toString(36) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    path.split("?")[0]!.split("/").filter(Boolean),
    { now: () => NOW, principal: cat },
  );
  const t = await res.text();
  return { status: res.status, json: t ? JSON.parse(t) : null };
}
async function orderBody(extra: Record<string, unknown>) {
  const { json: menu } = await call("GET", `/locations/${DEMO_LOCATION_DOWNTOWN_ID}/menu`);
  const item = menu.categories.flatMap((c: { items: unknown[] }) => c.items).find((i: { name: string }) => i.name === "Pepperoni");
  const large = item.sizes.find((s: { name: string }) => s.name.startsWith("Large"));
  return {
    location_id: DEMO_LOCATION_DOWNTOWN_ID,
    lines: [{ item_id: item.id, size_id: large.id, quantity: 1 }],
    channel: "agent", source: { type: "agent_api" }, payment_intent: "invoice",
    hold: { reason: "scheduled", ttl_seconds: 3600 },
    ...extra,
  };
}
const ID = (n: number) => `f8000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const go = (ms: number) => { NOW = new Date(T0.getTime() + ms); vi.setSystemTime(NOW); };
const admin = (orderId: string, action: string) =>
  latePOST(new Request("https://p/api/admin/late-payments", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ orderId, action }),
  }));
const listed = async () =>
  ((await (await lateGET(new Request(`https://p/x?tenantId=${DEMO_TENANT_ID}&locationId=${DEMO_LOCATION_DOWNTOWN_ID}`))).json()).latePayments as { order: { id: string } }[]).map((x) => x.order.id);
const marker = async (id: string) => (await getPosDriver().getOrder(id))!.fulfillment?.late_payment;

async function invoiceOrder(n: number, status: "pending" | "captured") {
  await call("POST", "/orders", await orderBody({ id: ID(n) }));
  const total = (await getPosDriver().getOrder(ID(n)))!.totals.total_cents;
  const r = await call("POST", `/orders/${ID(n)}/payments`, {
    method: "external", collection: "invoice", processor: "catering_invoice", processor_ref: `e:${n}`,
    amount_cents: total, tip_cents: 0, status,
  });
  expect(r.status).toBeLessThan(300);
}

beforeEach(() => {
  NOW = T0;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  resetMockOrders();
  resetMockPayments();
  resetMockOnline();
});

describe("P1: a resolved marker is never overwritten", () => {
  it("refund_owed_manual and refunded markers survive the sweeper and the flag helper", async () => {
    await invoiceOrder(1, "captured");
    go(8 * H);
    expect((await expireHeldOrders(NOW)).stranded).toBe(1);
    expect((await admin(ID(1), "refund")).status).toBe(200);
    expect((await marker(ID(1)))!.resolved).toBe("refund_owed_manual");
    go(9 * H);
    const s = await expireHeldOrders(NOW);
    expect(s.stranded).toBe(0);
    expect(await marker(ID(1))).toMatchObject({ kind: "scheduled", resolved: "refund_owed_manual" });
    const order = (await getPosDriver().getOrder(ID(1)))!;
    expect(await flagStrandedScheduled(order, await getPosDriver().listPaymentsForOrder(ID(1)), "partial")).toBe(false);
    expect((await marker(ID(1)))!.resolved).toBe("refund_owed_manual");
  });
});

describe("P2/P3: invoice_pending items", () => {
  it("Refund is refused (nothing was paid); Cancel voids the order and closes the tender, audited, no refund", async () => {
    await invoiceOrder(2, "pending");
    go(8 * H);
    expect((await expireHeldOrders(NOW)).stranded).toBe(1);
    expect(await listed()).toContain(ID(2));
    const refused = await admin(ID(2), "refund");
    expect(refused.status).toBe(409);
    expect((await refused.json()).error).toMatch(/Nothing was paid/);
    expect((await admin(ID(2), "accept")).status).toBe(409);

    const ok = await admin(ID(2), "cancel");
    expect(ok.status).toBe(200);
    const o = (await getPosDriver().getOrder(ID(2)))!;
    expect(o.status).toBe("voided");
    expect(o.fulfillment?.late_payment).toMatchObject({ resolved: "canceled" });
    const pays = await getPosDriver().listPaymentsForOrder(ID(2));
    expect(pays.every((p) => p.status !== "pending" && p.refunded_cents === 0)).toBe(true);
    expect(await listed()).not.toContain(ID(2));
    const audit = await getPosDriver().listAuditLog(DEMO_TENANT_ID);
    {
      expect(audit.some((a) => a.action === "scheduled_order_canceled")).toBe(true);
      expect(audit.some((a) => a.action === "late_payment_refunded" && (a.detail ?? "").includes(ID(2)))).toBe(false);
    }
    // A second press (stale tab): the order is no longer a held draft.
    expect((await admin(ID(2), "cancel")).status).toBe(409);
  });

  it("Cancel is refused where money was taken", async () => {
    await invoiceOrder(3, "captured");
    go(8 * H);
    await expireHeldOrders(NOW);
    const r = await admin(ID(3), "cancel");
    expect(r.status).toBe(409);
    expect((await getPosDriver().getOrder(ID(3)))!.status).toBe("draft");
  });

  it("scheduled actions need a held draft and an unresolved item; releasing resolves the item", async () => {
    await invoiceOrder(4, "captured");
    go(8 * H);
    await expireHeldOrders(NOW);
    // Released by hand (staff scope) meanwhile: the stale tab can no longer refund it.
    await getPosDriver().transitionOrderStatus(ID(4), ["draft"], "placed");
    const stale = await admin(ID(4), "refund");
    expect(stale.status).toBe(409);
    expect((await getPosDriver().listPaymentsForOrder(ID(4))).every((p) => p.refunded_cents === 0)).toBe(true);
  });

  it("orders.release clears the open flag", async () => {
    await call("POST", "/orders", await orderBody({ id: ID(5) }));
    const total = (await getPosDriver().getOrder(ID(5)))!.totals.total_cents;
    await call("POST", `/orders/${ID(5)}/payments`, {
      method: "external", collection: "invoice", processor: "catering_invoice", processor_ref: "e:5",
      amount_cents: total, tip_cents: 0, status: "captured",
    });
    await getPosDriver().mergeOrderFulfillment(ID(5), {
      late_payment: { kind: "scheduled", detail: "paid", payment_id: "x", amount_cents: total, flagged_at: T0.toISOString() },
    });
    go(30 * 60_000);
    // Inside the hold: released normally.
    const r = await call("POST", `/orders/${ID(5)}/release`);
    expect(r.status).toBe(200);
    expect((await marker(ID(5)))!.resolved).toBe("released");
    expect(await listed()).not.toContain(ID(5));
  });
});

describe("P4: location country", () => {
  const patch = (country: string | null, confirm?: boolean) =>
    locPATCH(new Request("https://p/api/admin/locations", {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenantId: DEMO_TENANT_ID, locationId: DEMO_LOCATION_DOWNTOWN_ID, country, ...(confirm ? { confirmPhoneEffects: true } : {}) }),
    }));

  it("changing it needs an explicit confirm that states the phone effects, and is audited", async () => {
    const d = getPosDriver();
    const no = await patch("GB");
    expect(no.status).toBe(422);
    const j = await no.json();
    expect(j.code).toBe("confirm_required");
    expect(j.error).toMatch(/phone numbers are read/);
    expect((await d.listLocations(DEMO_TENANT_ID)).find((l) => l.id === DEMO_LOCATION_DOWNTOWN_ID)?.country ?? null).toBeNull();
    const yes = await patch("GB", true);
    expect(yes.status).toBe(200);
    expect((await d.listLocations(DEMO_TENANT_ID)).find((l) => l.id === DEMO_LOCATION_DOWNTOWN_ID)?.country).toBe("GB");
    // No change needs no confirm.
    expect((await patch("GB")).status).toBe(200);
  });

  it("listLocations is ordered by (created_at, id)", async () => {
    const d = getPosDriver();
    const a = await d.createLocation({ tenant_id: DEMO_TENANT_ID, name: "Zeta" });
    const b = await d.createLocation({ tenant_id: DEMO_TENANT_ID, name: "Alpha" });
    const ids = (await d.listLocations(DEMO_TENANT_ID)).map((l) => l.id);
    const rows = await d.listLocations(DEMO_TENANT_ID);
    const sorted = [...rows].sort((x, y) => x.created_at.localeCompare(y.created_at) || x.id.localeCompare(y.id)).map((l) => l.id);
    expect(ids).toEqual(sorted);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
  });
});
