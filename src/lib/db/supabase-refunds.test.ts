/**
 * Refunds / voids / comps through the REAL Supabase driver on PGlite: the
 * tip-split refund reservation, item-refund quantities under the order lock,
 * apply_order_edit (compare-and-set, split lines, money checks) and the
 * approval policy column. Opt-in like supabase-phase2.test.ts:
 *
 *   PGLITE=../core/node_modules/@electric-sql/pglite npx vitest run src/lib/db/supabase-refunds.test.ts
 *
 * Without PGLITE the suite is skipped (CI).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { PosDriver } from "@/lib/db/driver";

const PGLITE = process.env.PGLITE ? resolve(process.env.PGLITE) : null;
const ROOT = resolve(__dirname, "../../..");

type Db = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  exec: (sql: string) => Promise<unknown>;
  close: () => Promise<void>;
};
let db: Db;

// supabase-js sends every rpc arg as JSON: arrays are jsonb too here.
const jsonParam = (v: unknown) => (v !== null && typeof v === "object" ? JSON.stringify(v) : v);

/** Just enough of the supabase-js builder for the driver calls under test. */
function fakeClient() {
  return {
    async rpc(name: string, args: Record<string, unknown>) {
      try {
        const keys = Object.keys(args);
        const sql = `select public.${name}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}) as r`;
        const res = await db.query(sql, keys.map((k) => jsonParam(args[k])));
        return { data: res.rows[0]!.r, error: null };
      } catch (e) {
        return { data: null, error: { message: (e as Error).message } };
      }
    },
    from(table: string) {
      type F = { col: string; op: "eq" | "in" | "is" | "notin"; val: unknown };
      const filters: F[] = [];
      let patch: Record<string, unknown> | null = null;
      let single = false;
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.update = (p: Record<string, unknown>) => ((patch = p), q);
      q.eq = (col: string, val: unknown) => (filters.push({ col, op: "eq", val }), q);
      q.in = (col: string, val: unknown[]) => (filters.push({ col, op: "in", val }), q);
      q.is = (col: string, val: unknown) => (filters.push({ col, op: "is", val }), q);
      q.not = (col: string, op: string, val: string) =>
        (filters.push({ col, op: "notin", val: val.replace(/[()]/g, "").split(",") }), q);
      q.order = () => q;
      q.range = () => q;
      q.maybeSingle = () => ((single = true), q);
      q.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => run().then(res, rej);
      async function run() {
        try {
          const params: unknown[] = [];
          const where = filters
            .map((f) => {
              if (f.op === "is") return `${f.col} is null`;
              params.push(f.val);
              if (f.op === "in") return `${f.col}::text = any($${params.length})`;
              if (f.op === "notin") return `not (${f.col}::text = any($${params.length}))`;
              return `${f.col} = $${params.length}`;
            })
            .join(" and ");
          let sql: string;
          if (patch) {
            const sets = Object.entries(patch).map(([k, v]) => {
              params.push(jsonParam(v));
              return `${k} = $${params.length}`;
            });
            sql = `update public.${table} set ${sets.join(", ")} where ${where} returning *`;
          } else {
            sql = `select * from public.${table}${where ? ` where ${where}` : ""}`;
          }
          const rows = (await db.query(sql, params)).rows.map((r) =>
            Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v instanceof Date ? v.toISOString() : v])),
          );
          return { data: single ? (rows[0] ?? null) : rows, error: null };
        } catch (e) {
          return { data: null, error: { message: (e as Error).message } };
        }
      }
      return q;
    },
  };
}

vi.mock("@supabase/supabase-js", () => ({ createClient: () => fakeClient() }));

const T = "10000000-0000-0000-0000-000000000001";
const ORDER = "e5000000-0000-4000-8000-000000000001";
const ORDER2 = "e5000000-0000-4000-8000-000000000002";
const LINE = "e5000000-0000-4000-8000-0000000000b1";
const LINE2 = "e5000000-0000-4000-8000-0000000000b2";
const PAY = "e5000000-0000-4000-8000-0000000000a1";

describe.skipIf(!PGLITE)("supabase driver refunds / voids / comps on PGlite", () => {
  let driver: PosDriver;
  let loc: string;

  beforeAll(async () => {
    const lib = pathToFileURL(join(PGLITE!, "dist/index.js")).href;
    const { PGlite } = await import(/* @vite-ignore */ lib);
    const { pgcrypto } = await import(
      /* @vite-ignore */ pathToFileURL(join(PGLITE!, "dist/contrib/pgcrypto.js")).href
    );
    db = new PGlite({ extensions: { pgcrypto } }) as Db;
    await db.exec(readFileSync(join(ROOT, "supabase/tests/auth_shim.sql"), "utf8"));
    const dir = join(ROOT, "supabase/migrations");
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
      await db.exec(readFileSync(join(dir, f), "utf8"));
    }
    await db.exec(readFileSync(join(ROOT, "supabase/seed.sql"), "utf8"));
    loc = (await db.query("select id from public.locations where tenant_id = $1 limit 1", [T])).rows[0]!
      .id as string;
    await db.query(
      `insert into public.orders (id, tenant_id, location_id, status, currency, totals, order_number)
       values ($1, $2, $3, 'paid', 'USD', '{"subtotal_cents":2000,"discount_cents":0,"taxable_cents":2000,"tax_cents":0,"tip_cents":0,"total_cents":2000}'::jsonb, 'SR-1'),
              ($4, $2, $3, 'placed', 'USD', '{"subtotal_cents":3000,"discount_cents":0,"taxable_cents":3000,"tax_cents":0,"tip_cents":0,"total_cents":3000}'::jsonb, 'SR-2')`,
      [ORDER, T, loc, ORDER2],
    );
    await db.query(
      `insert into public.order_items (id, order_id, item_id, item_name, quantity, unit_price_cents, line_total_cents, base_price_cents)
       values ($1, $2, gen_random_uuid(), 'Margherita', 2, 1000, 2000, 1000),
              ($3, $4, gen_random_uuid(), 'Pepperoni', 3, 1000, 3000, 1000)`,
      [LINE, ORDER, LINE2, ORDER2],
    );
    await db.query(
      `insert into public.payments (id, order_id, tenant_id, location_id, rail, status, amount_cents, tip_cents, currency, simulated)
       values ($1, $2, $3, $4, 'stripe_terminal', 'captured', 2000, 300, 'USD', true)`,
      [PAY, ORDER, T, loc],
    );
    const { createSupabaseDriver } = await import("@/lib/db/supabase");
    driver = createSupabaseDriver({ url: "http://x", key: "k" });
  }, 60_000);
  afterAll(async () => {
    await db?.close();
  });

  it("reservePaymentRefund keeps the tip part apart and caps base and tip separately", async () => {
    const food = await driver.reservePaymentRefund(PAY, 500, "sr-food-1", { tipCents: 0, reason: "quality" });
    expect(food.ok).toBe(true);
    if (food.ok) expect(food.payment).toMatchObject({ refunded_cents: 500, tip_refunded_cents: 0 });
    const tip = await driver.reservePaymentRefund(PAY, 100, "sr-tip-1", { tipCents: 100 });
    expect(tip.ok && tip.payment.tip_refunded_cents).toBe(100);
    expect((await driver.reservePaymentRefund(PAY, 300, "sr-tip-2", { tipCents: 300 })).ok).toBe(false);
    expect((await driver.reservePaymentRefund(PAY, 1600, "sr-food-2", { tipCents: 0 })).ok).toBe(false);
    const dup = await driver.reservePaymentRefund(PAY, 500, "sr-food-1", { tipCents: 0 });
    expect(dup).toMatchObject({ ok: false, reason: "duplicate" });
    await driver.releasePaymentRefund(PAY, 100, "sr-tip-1");
    const p = (await driver.getPayment(PAY))!;
    expect(p).toMatchObject({ refunded_cents: 500, tip_refunded_cents: 0 });
    expect(p.refunds![0]!.tip_cents).toBe(0);
  });

  it("beginOrderRefund reserves item units under the order lock", async () => {
    const rec = (id: string, qty: number) => ({
      id,
      tenant_id: T,
      location_id: loc,
      order_id: ORDER,
      kind: "refund" as const,
      status: "pending" as const,
      amount_cents: 1000 * qty,
      tip_cents: 0,
      lines: [{ line_id: LINE, quantity: qty, amount_cents: 1000 * qty }],
      allocations: [],
      reason_code: "quality",
      reason_text: null,
      staff_id: null,
      actor_user_id: "u1",
      approved_by: null,
      meta: null,
      created_at: "",
      updated_at: "",
    });
    const [a, b] = await Promise.all([
      driver.beginOrderRefund(rec("sr-item-0001", 2)),
      driver.beginOrderRefund(rec("sr-item-0002", 1)),
    ]);
    expect([a.outcome, b.outcome].sort()).toEqual(["exceeds", "ok"]);
    expect((await driver.beginOrderRefund(rec("sr-item-0001", 2))).outcome).toBe("duplicate");
    const done = await driver.finishOrderAdjustment(ORDER, "sr-item-0001", {
      status: "completed",
      allocations: [
        { payment_id: PAY, rail: "stripe_terminal", base_cents: 2000, tip_cents: 0, processor_ref: "re_1", manual: false },
      ],
      meta: { note: "x" },
    });
    expect(done).toMatchObject({ status: "completed", allocations: [{ base_cents: 2000 }] });
    expect((await driver.listOrderAdjustments(ORDER)).map((r) => r.id)).toContain("sr-item-0001");
  });

  it("applyOrderEdit: compare-and-set, partial void split, money check, ledger row", async () => {
    const order = (await driver.getOrder(ORDER2))!;
    const write = {
      orderId: ORDER2,
      tenantId: T,
      expectVersion: order.version ?? 1,
      voidLineIds: [],
      splits: [{ line_id: LINE2, new_line_id: "e5000000-0000-4000-8000-0000000000c1", keep_quantity: 2, void_quantity: 1 }],
      totals: { subtotal_cents: 2000, discount_cents: 0, taxable_cents: 2000, tax_cents: 0, tip_cents: 0, total_cents: 2000 },
      discountCents: 0,
      adjustments: [],
      voidOrder: false,
      record: {
        id: "sr-edit-0001",
        tenant_id: T,
        location_id: loc,
        order_id: ORDER2,
        kind: "void_line" as const,
        status: "completed" as const,
        amount_cents: 1000,
        tip_cents: 0,
        lines: [{ line_id: LINE2, quantity: 1, amount_cents: 1000 }],
        allocations: [],
        reason_code: "entry_error",
        reason_text: null,
        staff_id: null,
        actor_user_id: "u1",
        approved_by: null,
        meta: null,
        created_at: "",
        updated_at: "",
      },
    };
    expect((await driver.applyOrderEdit({ ...write, expectVersion: write.expectVersion - 1 })).outcome).toBe("stale");
    const ok = await driver.applyOrderEdit(write);
    expect(ok.outcome).toBe("ok");
    if (ok.outcome === "ok") {
      expect(ok.order.totals.total_cents).toBe(2000);
      expect(ok.order.items.map((i) => [i.quantity, i.voided])).toEqual(
        expect.arrayContaining([
          [2, false],
          [1, true],
        ]),
      );
    }
    expect((await driver.applyOrderEdit(write)).outcome).toBe("duplicate");
  });

  it("setAdjustmentPolicy round-trips through store_settings", async () => {
    const policy = { refund_approval_cents: 2500, comp_approval_cents: 1000, void_approval_cents: 500 };
    const s = await driver.setAdjustmentPolicy(T, loc, policy);
    expect(s.adjustment_policy).toEqual(policy);
    expect((await driver.getStoreSettings(T, loc)).adjustment_policy).toEqual(policy);
  });
});
