import { describe, it, expect, vi } from "vitest";

/** Minimal chainable fake of the supabase-js query builder, recording ops. */
const ops: { table: string; op: string }[] = [];

function fakeClient() {
  return {
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
