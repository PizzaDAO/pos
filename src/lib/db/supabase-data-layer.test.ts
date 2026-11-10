/**
 * Load-test data-layer fixes on the REAL SQL through the Supabase driver
 * (loadtest/REPORT.md): tenant-scoped + paged menu assembly and its version
 * cache, atomic order numbers + order/lines insert, and the kitchen poll's SQL
 * filter. Opt-in like supabase-menu-import.test.ts:
 *
 *   PGLITE=../core/node_modules/@electric-sql/pglite npx vitest run src/lib/db/supabase-data-layer.test.ts
 *
 * Without PGLITE the suite is skipped (CI). The fake client caps EVERY response
 * at 1000 rows, like PostgREST's max_rows.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { PosDriver } from "@/lib/db/driver";
import type { CreateOrderInput } from "@/lib/db";
import { KDS_ACTIVE_STATUSES } from "@/lib/db/menu-types";

const PGLITE = process.env.PGLITE ? resolve(process.env.PGLITE) : null;
const ROOT = resolve(__dirname, "../../..");
const MAX_ROWS = 1000;

type Db = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  exec: (sql: string) => Promise<unknown>;
  close: () => Promise<void>;
};
let db: Db;
/** Tables read through the fake client (for round-trip assertions). */
const reads: string[] = [];

const jsonParam = (v: unknown) => (v !== null && typeof v === "object" ? JSON.stringify(v) : v);
const isoRow = (r: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v instanceof Date ? v.toISOString() : v]));

/** Just enough of the supabase-js builder for the driver paths under test. */
function fakeClient() {
  return {
    async rpc(name: string, args: Record<string, unknown>) {
      try {
        const keys = Object.keys(args);
        const sql = `select public.${name}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}) as r`;
        const res = await db.query(sql, keys.map((k) => jsonParam(args[k])));
        return { data: res.rows[0]!.r, error: null };
      } catch (e) {
        return { data: null, error: { message: (e as Error).message, code: (e as { code?: string }).code } };
      }
    },
    from(table: string) {
      type F = { col: string; op: "eq" | "in" | "is" | "gte" | "lte" | "gt"; val: unknown };
      const filters: F[] = [];
      let single = false;
      let orderBy = "";
      let lim = ` limit ${MAX_ROWS}`;
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.eq = (col: string, val: unknown) => (filters.push({ col, op: "eq", val }), q);
      q.in = (col: string, val: unknown[]) => (filters.push({ col, op: "in", val }), q);
      q.is = (col: string, val: unknown) => (filters.push({ col, op: "is", val }), q);
      q.gte = (col: string, val: unknown) => (filters.push({ col, op: "gte", val }), q);
      q.lte = (col: string, val: unknown) => (filters.push({ col, op: "lte", val }), q);
      q.gt = (col: string, val: unknown) => (filters.push({ col, op: "gt", val }), q);
      q.order = (col: string, o?: { ascending?: boolean }) => (
        (orderBy = `${orderBy ? orderBy + ", " : " order by "}${col}${o?.ascending === false ? " desc" : ""}`), q
      );
      q.limit = (n: number) => ((lim = ` limit ${Math.min(Number(n), MAX_ROWS)}`), q);
      q.range = (from: number, to: number) => ((lim = ` limit ${Math.min(to - from + 1, MAX_ROWS)} offset ${from}`), q);
      q.maybeSingle = () => ((single = true), q);
      q.single = () => ((single = true), q);
      q.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => run().then(res, rej);
      async function run() {
        reads.push(table);
        try {
          const params: unknown[] = [];
          const where = filters
            .map((f) => {
              if (f.op === "is") return `${f.col} is null`;
              params.push(f.val);
              if (f.op === "in") return `${f.col}::text = any($${params.length})`;
              const o = { eq: "=", gte: ">=", lte: "<=", gt: ">" }[f.op];
              return `${f.col} ${o} $${params.length}`;
            })
            .join(" and ");
          const sql = `select * from public.${table}${where ? ` where ${where}` : ""}${orderBy}${lim}`;
          const rows = (await db.query(sql, params)).rows.map(isoRow);
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
const LOC = "10000000-0000-0000-0000-000000000101";
const LOC2 = "10000000-0000-0000-0000-000000000102";

function orderInput(over: Partial<CreateOrderInput> = {}): CreateOrderInput {
  const lineId = crypto.randomUUID();
  return {
    id: crypto.randomUUID(),
    tenant_id: T,
    location_id: LOC,
    channel: "online_pickup",
    currency: "USD",
    status: "awaiting_payment", // no inventory depletion in these tests
    items: [
      {
        id: lineId,
        item_id: crypto.randomUUID(),
        item_name: "Test pie",
        size_id: null,
        size_name: null,
        base_price_cents: 1000,
        quantity: 1,
        modifiers: [
          {
            group_id: crypto.randomUUID(),
            group_name: "Toppings",
            modifier_id: crypto.randomUUID(),
            modifier_name: "Basil",
            price_cents: 50,
            placement: "whole",
          },
        ],
        notes: null,
        voided: false,
        unit_price_cents: 1050,
        line_total_cents: 1050,
      },
    ],
    discount_cents: 0,
    totals: {
      subtotal_cents: 1050,
      discount_cents: 0,
      taxable_cents: 1050,
      tax_cents: 0,
      tip_cents: 0,
      total_cents: 1050,
    },
    notes: null,
    ...over,
  };
}

const count = async (sql: string, params: unknown[] = []) =>
  Number((await db.query(sql, params)).rows[0]!.n);

describe.skipIf(!PGLITE)("data-layer fixes through the Supabase driver on PGlite", () => {
  let driver: PosDriver;

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
    const { createSupabaseDriver } = await import("@/lib/db/supabase");
    driver = createSupabaseDriver({ url: "http://x", key: "k" });
  }, 60_000);
  afterAll(async () => {
    await db?.close();
  });

  describe("menu (rank 1)", () => {
    it("is complete when OTHER tenants push sizes / modifiers / links past the row cap", async () => {
      const before = await driver.getMenu(T, LOC);
      // Another tenant with 1200 items (one size + one group link each) and a
      // 1200-modifier group: every platform-wide table is now > 1000 rows.
      const t2 = crypto.randomUUID();
      const cat = crypto.randomUUID();
      const big = crypto.randomUUID();
      await db.query("insert into public.tenants (id, name, slug) values ($1, 'Other', $2)", [t2, `o-${t2.slice(0, 8)}`]);
      await db.query("insert into public.menu_categories (id, tenant_id, name) values ($1, $2, 'C')", [cat, t2]);
      await db.query("insert into public.modifier_groups (id, tenant_id, name) values ($1, $2, 'Big')", [big, t2]);
      await db.query(
        `insert into public.menu_items (id, tenant_id, category_id, name)
         select gen_random_uuid(), $1, $2, 'i' || n from generate_series(1, 1200) n`,
        [t2, cat],
      );
      await db.query(
        "insert into public.item_sizes (item_id, name, price_cents) select id, 'R', 100 from public.menu_items where tenant_id = $1",
        [t2],
      );
      await db.query(
        "insert into public.item_modifier_groups (item_id, group_id) select id, $2 from public.menu_items where tenant_id = $1",
        [t2, big],
      );
      await db.query(
        "insert into public.modifiers (group_id, name) select $1, 'm' || n from generate_series(1, 1200) n",
        [big],
      );
      // Move this tenant's rows behind the other tenant's in heap order, so an
      // unordered capped select would return the OTHER tenant's rows first.
      for (const [table, join] of [
        ["item_sizes", "join public.menu_items p on p.id = r.item_id"],
        ["item_modifier_groups", "join public.menu_items p on p.id = r.item_id"],
        ["modifiers", "join public.modifier_groups p on p.id = r.group_id"],
      ] as const) {
        await db.exec(`
          create temp table moved as select r.* from public.${table} r ${join} where p.tenant_id = '${T}';
          delete from public.${table} r using moved m where ${table === "item_modifier_groups" ? "r.item_id = m.item_id and r.group_id = m.group_id" : "r.id = m.id"};
          insert into public.${table} select * from moved;
          drop table moved;`);
      }
      expect(await count("select count(*) n from public.item_sizes")).toBeGreaterThan(MAX_ROWS);
      expect(await count("select count(*) n from public.modifiers")).toBeGreaterThan(MAX_ROWS);
      expect(await count("select count(*) n from public.item_modifier_groups")).toBeGreaterThan(MAX_ROWS);

      const after = await driver.getMenu(T, LOC);
      expect(after).toEqual(before);
      const sizes = after.categories.flatMap((c) => c.items.flatMap((i) => i.sizes));
      expect(sizes.length).toBe(
        await count(
          "select count(*) n from public.item_sizes s join public.menu_items i on i.id = s.item_id where i.tenant_id = $1",
          [T],
        ),
      );
      expect(sizes.length).toBeGreaterThan(0);
    }, 60_000);

    it("pages a single tenant's own menu past the cap", async () => {
      const t3 = crypto.randomUUID();
      const loc = crypto.randomUUID();
      const cat = crypto.randomUUID();
      const grp = crypto.randomUUID();
      await db.query("insert into public.tenants (id, name, slug) values ($1, 'Big', $2)", [t3, `b-${t3.slice(0, 8)}`]);
      await db.query("insert into public.locations (id, tenant_id, name, slug) values ($1, $2, 'L', 'l')", [loc, t3]);
      await db.query("insert into public.menu_categories (id, tenant_id, name) values ($1, $2, 'C')", [cat, t3]);
      await db.query("insert into public.modifier_groups (id, tenant_id, name) values ($1, $2, 'G')", [grp, t3]);
      await db.query(
        `insert into public.menu_items (id, tenant_id, category_id, name)
         select gen_random_uuid(), $1, $2, 'i' || n from generate_series(1, 1100) n`,
        [t3, cat],
      );
      await db.query(
        "insert into public.item_sizes (item_id, name, price_cents, sort_order) select id, s, 100, k from public.menu_items, (values ('S', 0), ('L', 1)) v(s, k) where tenant_id = $1",
        [t3],
      );
      // The group (1500 modifiers) is linked to one item only.
      const first = (await db.query("select id from public.menu_items where tenant_id = $1 order by name limit 1", [t3])).rows[0]!.id;
      await db.query("insert into public.item_modifier_groups (item_id, group_id) values ($1, $2)", [first, grp]);
      await db.query("insert into public.modifiers (group_id, name, sort_order) select $1, 'm' || n, n from generate_series(1, 1500) n", [grp]);

      const menu = await driver.getMenu(t3, loc);
      const items = menu.categories.flatMap((c) => c.items);
      expect(items).toHaveLength(1100);
      expect(items.every((i) => i.sizes.map((s) => s.name).join() === "S,L")).toBe(true);
      const linked = items.find((i) => i.id === first)!;
      expect(linked.modifierGroups[0]!.modifiers).toHaveLength(1500);
      expect(linked.modifierGroups[0]!.modifiers[0]!.name).toBe("m1");
    }, 60_000);

    it("serves an unchanged menu from cache with one read, and sees any menu write", async () => {
      await driver.getMenu(T, LOC2);
      reads.length = 0;
      const cached = await driver.getMenu(T, LOC2);
      expect(reads).toEqual(["menu_versions"]);

      // A price change (item_sizes has no tenant_id: reached via menu_items).
      const size = cached.categories[0]!.items[0]!.sizes[0]!;
      await db.query("update public.item_sizes set price_cents = price_cents + 7 where id = $1", [size.id]);
      const repriced = await driver.getMenu(T, LOC2);
      expect(repriced.categories[0]!.items[0]!.sizes[0]!.price_cents).toBe(size.price_cents + 7);

      // An 86 at this location (location_menu_overrides).
      const item = repriced.categories[0]!.items[0]!;
      await db.query(
        "insert into public.location_menu_overrides (tenant_id, location_id, target_type, target_id, available) values ($1, $2, 'item', $3, false)",
        [T, LOC2, item.id],
      );
      const eighty = await driver.getMenu(T, LOC2);
      expect(eighty.categories.flatMap((c) => c.items).some((i) => i.id === item.id)).toBe(false);

      // A modifier delete (reached via modifier_groups).
      const withMods = eighty.categories.flatMap((c) => c.items).find((i) => i.modifierGroups.some((g) => g.modifiers.length))!;
      const mod = withMods.modifierGroups.find((g) => g.modifiers.length)!.modifiers[0]!;
      await db.query("delete from public.modifiers where id = $1", [mod.id]);
      const fewer = await driver.getMenu(T, LOC2);
      const again = fewer.categories.flatMap((c) => c.items).find((i) => i.id === withMods.id)!;
      expect(again.modifierGroups.flatMap((g) => g.modifiers).some((m) => m.id === mod.id)).toBe(false);

      // Callers may mutate what they get without poisoning the cache.
      fewer.categories.length = 0;
      expect((await driver.getMenu(T, LOC2)).categories.length).toBeGreaterThan(0);
    });
  });

  describe("orders (rank 2)", () => {
    it("assigns distinct A-#### numbers to concurrent creates, continuing after existing numbers", async () => {
      await db.query(
        `insert into public.orders (id, tenant_id, location_id, status, channel, totals, order_number)
         values (gen_random_uuid(), $1, $2, 'completed', 'in_store', '{}'::jsonb, 'A-0040')`,
        [T, LOC],
      );
      const created = await Promise.all(Array.from({ length: 25 }, () => driver.createOrder(orderInput())));
      const numbers = created.map((o) => o.order_number);
      expect(new Set(numbers).size).toBe(25);
      expect(numbers.every((n) => /^A-\d{4,}$/.test(n))).toBe(true);
      expect(Math.min(...numbers.map((n) => Number(n.slice(2))))).toBeGreaterThan(40);
      // Lines + modifiers came back from the one RPC.
      expect(created[0]!.items).toHaveLength(1);
      expect(created[0]!.items[0]!.modifiers[0]!.modifier_name).toBe("Basil");
    });

    it("keeps a free client number; a taken one becomes the provisional label", async () => {
      const a = await driver.createOrder(orderInput({ order_number: "1201-555", channel: "in_store" }));
      const b = await driver.createOrder(orderInput({ order_number: "1201-555", channel: "in_store" }));
      expect(a.order_number).toBe("1201-555");
      expect(b.order_number).toMatch(/^A-\d{4,}$/);
      expect(b.core_ext?.provisional_label).toBe("1201-555");
      // A label the till already set is kept.
      const c = await driver.createOrder(
        orderInput({ order_number: "1201-555", core_ext: { provisional_label: "1201-556" } }),
      );
      expect(c.order_number).toMatch(/^A-/);
      expect(c.core_ext?.provisional_label).toBe("1201-556");
      // Another location may reuse the number.
      const other = await driver.createOrder(orderInput({ location_id: LOC2, order_number: "1201-555" }));
      expect(other.order_number).toBe("1201-555");
    });

    it("is idempotent on the id, within the tenant only", async () => {
      const input = orderInput({ core_ext: { provisional_label: "0930-111" } });
      const first = await driver.createOrder(input);
      expect(first.core_ext?.provisional_label).toBe("0930-111");
      const retry = await driver.createOrder({ ...input, order_number: "ignored" });
      expect(retry.id).toBe(first.id);
      expect(retry.order_number).toBe(first.order_number);
      expect(await count("select count(*) n from public.order_items where order_id = $1", [input.id])).toBe(1);

      const t2 = crypto.randomUUID();
      const l2 = crypto.randomUUID();
      await db.query("insert into public.tenants (id, name, slug) values ($1, 'Y', $2)", [t2, `y-${t2.slice(0, 8)}`]);
      await db.query("insert into public.locations (id, tenant_id, name, slug) values ($1, $2, 'L', 'l')", [l2, t2]);
      await expect(
        driver.createOrder({ ...input, tenant_id: t2, location_id: l2 }),
      ).rejects.toThrow(/already in use/);
    });

    it("widens past 9999 instead of truncating (A-9999, A-10000, A-10001)", async () => {
      const loc = crypto.randomUUID();
      await db.query("insert into public.locations (id, tenant_id, name, slug) values ($1, $2, 'W', $3)", [loc, T, `w-${loc.slice(0, 8)}`]);
      await db.query(
        "insert into public.order_number_counters (location_id, tenant_id, last_value) values ($1, $2, 9998)",
        [loc, T],
      );
      const nums: string[] = [];
      for (let i = 0; i < 3; i++) nums.push((await driver.createOrder(orderInput({ location_id: loc }))).order_number);
      expect(nums).toEqual(["A-9999", "A-10000", "A-10001"]);
    });

    it("writes nothing when a line fails (one transaction)", async () => {
      const ok = await driver.createOrder(orderInput());
      const input = orderInput();
      // A line id that already exists (on another order): the line insert fails.
      input.items[0]!.id = ok.items[0]!.id;
      await expect(driver.createOrder(input)).rejects.toThrow();
      expect(await count("select count(*) n from public.orders where id = $1", [input.id])).toBe(0);
      expect(await count("select count(*) n from public.core_outbox where subject_id = $1", [input.id])).toBe(0);
    });

    it("refuses a location outside the tenant", async () => {
      const t2 = crypto.randomUUID();
      await db.query("insert into public.tenants (id, name, slug) values ($1, 'X', $2)", [t2, `x-${t2.slice(0, 8)}`]);
      await expect(driver.createOrder(orderInput({ tenant_id: t2 }))).rejects.toThrow(/not part of the tenant/);
    });

    it("has a unique (location_id, order_number) index", async () => {
      const n = (await db.query("select order_number from public.orders where location_id = $1 limit 1", [LOC])).rows[0]!
        .order_number;
      await expect(
        db.query(
          `insert into public.orders (id, tenant_id, location_id, totals, order_number)
           values (gen_random_uuid(), $1, $2, '{}'::jsonb, $3)`,
          [T, LOC, n],
        ),
      ).rejects.toThrow(/duplicate key/);
    });

    it("the migration tolerates existing duplicates (partial index from now on)", async () => {
      await db.exec("drop index public.orders_location_order_number_key");
      await db.query(
        `insert into public.orders (id, tenant_id, location_id, totals, order_number, created_at)
         select gen_random_uuid(), $1, $2, '{}'::jsonb, 'DUP-1', now() - interval '1 day' from generate_series(1, 2)`,
        [T, LOC],
      );
      await db.exec(
        readFileSync(join(ROOT, "supabase/migrations/20261114000000_order_numbers_atomic_create.sql"), "utf8"),
      );
      const def = (await db.query("select indexdef from pg_indexes where indexname = 'orders_location_order_number_key'"))
        .rows[0]!.indexdef as string;
      expect(def).toMatch(/UNIQUE/);
      expect(def).toMatch(/WHERE \(created_at >=/);
      // New orders still never reuse a number, old duplicates included.
      const o = await driver.createOrder(orderInput({ order_number: "DUP-1" }));
      expect(o.order_number).toMatch(/^A-/);
      expect(o.core_ext?.provisional_label).toBe("DUP-1");
    });
  });

  describe("kitchen poll (rank 3)", () => {
    it("reads active + recently changed orders in SQL, not the last 1000 of history", async () => {
      const loc = crypto.randomUUID();
      await db.query("insert into public.locations (id, tenant_id, name, slug) values ($1, $2, 'K', $3)", [loc, T, `k-${loc.slice(0, 8)}`]);
      // 1200 old completed orders (more than one capped response).
      await db.query(
        `insert into public.orders (id, tenant_id, location_id, status, channel, totals, order_number, created_at, updated_at)
         select gen_random_uuid(), $1, $2, 'completed', 'in_store', '{}'::jsonb, 'H-' || n,
                now() - interval '2 hours', now() - interval '2 hours'
           from generate_series(1, 1200) n`,
        [T, loc],
      );
      const active = await driver.createOrder(orderInput({ location_id: loc, status: "placed", channel: "in_store" }));
      // An order created and finished long ago but voided just now (STOP banner).
      await db.query(
        `insert into public.orders (id, tenant_id, location_id, status, channel, totals, order_number, created_at, updated_at)
         values (gen_random_uuid(), $1, $2, 'voided', 'in_store', '{}'::jsonb, 'V-1', now() - interval '3 hours', now())`,
        [T, loc],
      );
      // An active order from before the window.
      await db.query(
        `insert into public.orders (id, tenant_id, location_id, status, channel, totals, order_number, created_at, updated_at)
         values (gen_random_uuid(), $1, $2, 'placed', 'in_store', '{}'::jsonb, 'OLD-1', now() - interval '30 days', now() - interval '30 days')`,
        [T, loc],
      );
      // A catering order booked 20 days ahead, released to the kitchen an hour ago.
      await db.query(
        `insert into public.orders (id, tenant_id, location_id, status, channel, totals, order_number, created_at, updated_at)
         values (gen_random_uuid(), $1, $2, 'in_kitchen', 'in_store', '{}'::jsonb, 'CAT-1', now() - interval '20 days', now() - interval '1 hour')`,
        [T, loc],
      );
      const now = Date.now();
      const got = await driver.listKitchenOrders(T, loc, {
        statuses: KDS_ACTIVE_STATUSES,
        activeSince: new Date(now - 7 * 86_400_000).toISOString(),
        updatedSince: new Date(now - 15 * 60_000).toISOString(),
      });
      expect(got.map((o) => o.order_number).sort()).toEqual([active.order_number, "CAT-1", "V-1"].sort());
      expect(got.find((o) => o.id === active.id)!.items).toHaveLength(1);
    }, 60_000);
  });

  describe("new tables are server-only", () => {
    it("RLS enabled + forced, no anon/authenticated privileges", async () => {
      for (const t of ["order_number_counters", "menu_versions"]) {
        const r = (await db.query("select relrowsecurity, relforcerowsecurity from pg_class where oid = $1::regclass", [`public.${t}`])).rows[0]!;
        expect(r).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
        for (const role of ["anon", "authenticated"]) {
          for (const priv of ["select", "insert", "update", "delete", "truncate", "trigger", "references"]) {
            const has = (await db.query("select has_table_privilege($1, $2, $3) as h", [role, `public.${t}`, priv])).rows[0]!.h;
            expect(has, `${role} ${priv} on ${t}`).toBe(false);
          }
        }
      }
      for (const f of ["public.create_order_with_lines(jsonb, jsonb, jsonb)", "public.next_order_number(uuid, uuid)"]) {
        for (const role of ["anon", "authenticated"]) {
          const has = (await db.query("select has_function_privilege($1, $2, 'execute') as h", [role, f])).rows[0]!.h;
          expect(has, `${role} execute ${f}`).toBe(false);
        }
      }
    });
  });
});
