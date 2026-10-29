import { describe, it, expect, vi } from "vitest";

/** Minimal chainable fake of the supabase-js query builder, recording ops. */
const ops: { table: string; op: string }[] = [];
let deleteError: { message: string } | null = null;
let rpcResult: unknown = null;
const rpcCalls: { name: string; args: unknown }[] = [];
const captured: unknown[] = [];
vi.mock("@/lib/observability", () => ({
  captureError: (e: unknown) => captured.push(e),
}));

function fakeClient() {
  return {
    rpc(name: string, args: unknown) {
      rpcCalls.push({ name, args });
      return Promise.resolve({ data: rpcResult, error: null });
    },
    from(table: string) {
      let op = "select";
      const c: Record<string, unknown> = {};
      const chain = () => c;
      c.select = () => c;
      c.insert = () => ((op = "insert"), c);
      c.delete = () => ((op = "delete"), c);
      c.update = () => ((op = "update"), c);
      c.eq = chain;
      c.order = chain;
      c.maybeSingle = chain;
      c.single = chain;
      c.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => {
        ops.push({ table, op });
        let result: unknown = { data: null, error: null, count: 0 };
        if (table === "orders" && op === "insert") {
          result = { data: { id: "ord-1" }, error: null };
        }
        if (table === "orders" && op === "delete") {
          result = { data: null, error: deleteError };
        }
        if (table === "order_items" && op === "insert") {
          result = { data: null, error: { message: "boom: order_items insert" } };
        }
        return Promise.resolve(result).then(res, rej);
      };
      return c;
    },
  };
}

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => fakeClient(),
}));

import { createSupabaseDriver } from "@/lib/db/supabase";

describe("supabase createOrder is not left half-written", () => {
  it("deletes the order row when writing its lines fails", async () => {
    const driver = createSupabaseDriver({ url: "http://x", key: "k" });
    await expect(
      driver.createOrder({
        id: "ord-1",
        tenant_id: "t1",
        location_id: "l1",
        channel: "online_pickup",
        currency: "USD",
        items: [
          {
            id: "line-1",
            item_id: "i",
            item_name: "x",
            size_id: null,
            size_name: null,
            base_price_cents: 100,
            quantity: 1,
            modifiers: [],
            notes: null,
            voided: false,
            unit_price_cents: 100,
            line_total_cents: 100,
          },
        ],
        discount_cents: 0,
        totals: {
          subtotal_cents: 100,
          discount_cents: 0,
          taxable_cents: 100,
          tax_cents: 0,
          tip_cents: 0,
          total_cents: 100,
        },
        notes: null,
      }),
    ).rejects.toThrow(/boom/);
    const orderOps = ops.filter((o) => o.table === "orders").map((o) => o.op);
    expect(orderOps).toContain("insert");
    expect(orderOps[orderOps.length - 1]).toBe("delete");
  });
});

const order = {
  id: "ord-2",
  tenant_id: "t1",
  location_id: "l1",
  channel: "online_pickup" as const,
  currency: "USD",
  items: [
    {
      id: "line-2",
      item_id: "i",
      item_name: "x",
      size_id: null,
      size_name: null,
      base_price_cents: 100,
      quantity: 1,
      modifiers: [],
      notes: null,
      voided: false,
      unit_price_cents: 100,
      line_total_cents: 100,
    },
  ],
  discount_cents: 0,
  totals: {
    subtotal_cents: 100,
    discount_cents: 0,
    taxable_cents: 100,
    tax_cents: 0,
    tip_cents: 0,
    total_cents: 100,
  },
  notes: null,
};

describe("rollback failure is reported", () => {
  it("captures + logs when the compensating delete itself fails", async () => {
    deleteError = { message: "delete blocked" };
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const driver = createSupabaseDriver({ url: "http://x", key: "k" });
    await expect(driver.createOrder(order)).rejects.toThrow(/boom/);
    expect(captured).toHaveLength(1);
    expect(String(captured[0])).toContain("rollback failed");
    expect(log).toHaveBeenCalled();
    log.mockRestore();
    deleteError = null;
  });
});

describe("atomic refund RPC wiring", () => {
  it("maps outcomes from reserve_payment_refund", async () => {
    const driver = createSupabaseDriver({ url: "http://x", key: "k" });
    const row = {
      id: "p1",
      order_id: "o1",
      tenant_id: "t1",
      location_id: "l1",
      rail: "cash",
      status: "captured",
      amount_cents: 1000,
      tip_cents: 0,
      application_fee_cents: 0,
      currency: "USD",
      refunded_cents: 300,
      refund_ids: ["a"],
      simulated: true,
      created_at: "x",
      updated_at: "x",
    };
    rpcResult = { outcome: "ok", payment: row };
    const ok = await driver.reservePaymentRefund("p1", 300, "a");
    expect(ok.ok).toBe(true);
    expect(rpcCalls.at(-1)).toEqual({
      name: "reserve_payment_refund",
      args: { p_payment_id: "p1", p_amount: 300, p_refund_id: "a" },
    });
    rpcResult = { outcome: "duplicate", payment: row };
    expect(await driver.reservePaymentRefund("p1", 300, "a")).toMatchObject({
      ok: false,
      reason: "duplicate",
    });
    rpcResult = { outcome: "exceeds", payment: row };
    expect(await driver.reservePaymentRefund("p1", 9999, "b")).toMatchObject({
      ok: false,
      reason: "exceeds",
    });
    rpcResult = { outcome: "not_found" };
    expect(await driver.reservePaymentRefund("zz", 1, null)).toMatchObject({
      ok: false,
      reason: "not_found",
      payment: null,
    });
    await driver.releasePaymentRefund("p1", 300, "a");
    expect(rpcCalls.at(-1)?.name).toBe("release_payment_refund");
  });
});
