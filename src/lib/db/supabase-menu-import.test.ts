/**
 * Menu import on the REAL SQL through the Supabase driver (public.import_menu +
 * the paged getMenuSnapshot). Opt-in like supabase-phase3.test.ts:
 *
 *   PGLITE=../core/node_modules/@electric-sql/pglite npx vitest run src/lib/db/supabase-menu-import.test.ts
 *
 * Without PGLITE the suite is skipped (CI). The fake client caps responses at
 * 1000 rows, like PostgREST's max_rows.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { PosDriver } from "@/lib/db/driver";
import { GENERIC_TEMPLATE_CSV, buildImportRows, parseMenuImport } from "@/lib/menu-import";

const PGLITE = process.env.PGLITE ? resolve(process.env.PGLITE) : null;
const ROOT = resolve(__dirname, "../../..");

type Db = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  exec: (sql: string) => Promise<unknown>;
  close: () => Promise<void>;
};
let db: Db;

const jsonParam = (v: unknown) =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? JSON.stringify(v) : v;

/** Just enough of the supabase-js builder for the driver reads under test. */
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
      type F = { col: string; op: "eq" | "in" | "is" | "gte" | "lte" | "gt"; val: unknown };
      const filters: F[] = [];
      let single = false;
      let orderBy = "";
      let lim = "";
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
      q.limit = (n: number) => ((lim = ` limit ${Number(n)}`), q);
      q.range = (from: number, to: number) => ((lim = ` limit ${Math.min(to - from + 1, 1000)} offset ${from}`), q);
      q.maybeSingle =() => ((single = true), q);
      q.single = () => ((single = true), q);
      q.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
        run().then(res, rej);
      async function run() {
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
          // PostgREST returns timestamps as strings, PGlite as Dates.
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
const parse = (csv: string) => parseMenuImport(new TextEncoder().encode(csv));

describe.skipIf(!PGLITE)("menu import through the Supabase driver on PGlite", () => {
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
    await db.query("select public.core_set_outbox_enabled(true)");
    const { createSupabaseDriver } = await import("@/lib/db/supabase");
    driver = createSupabaseDriver({ url: "http://x", key: "k" });
  }, 60_000);
  afterAll(async () => {
    await db?.close();
  });

  it("snapshot pages past the 1000-row response cap", async () => {
    const g = crypto.randomUUID();
    await db.query("insert into public.modifier_groups (id, tenant_id, name) values ($1, $2, 'Huge')", [g, T]);
    await db.query(
      "insert into public.modifiers (group_id, name, price_cents) select $1, 'opt ' || n, 0 from generate_series(1, 2300) n",
      [g],
    );
    const snap = await driver.getMenuSnapshot(T);
    expect(snap.modifiers.filter((m) => m.group_id === g)).toHaveLength(2300);
    expect(new Set(snap.modifiers.map((m) => m.id)).size).toBe(snap.modifiers.length);
  });

  it("replace keeps ids, drops recipes/allergens/overrides of removed items, emits no ghost 'available'", async () => {
    const before = await driver.getMenuSnapshot(T);
    const keep = before.items[0]!;
    const drop = before.items[1]!;
    const loc = (await db.query("select id from public.locations where tenant_id = $1 limit 1", [T])).rows[0]!.id as string;
    await db.query(
      "insert into public.location_menu_overrides (tenant_id, location_id, target_type, target_id, available) values ($1, $2, 'item', $3, false)",
      [T, loc, drop.id],
    );
    await db.query("delete from public.core_outbox");
    const cat = before.categories.find((c) => c.id === keep.category_id)!;
    const built = buildImportRows(T, before, parse(`category,item,price\n${cat.name},${keep.name},5\n`), "replace");
    await driver.applyMenuImport(T, built.changes);
    const after = await driver.getMenuSnapshot(T);
    expect(after.items.map((i) => i.id)).toEqual([keep.id]);
    expect((await db.query("select 1 from public.location_menu_overrides where target_id = $1", [drop.id])).rows).toHaveLength(0);
    expect((await db.query("select 1 from public.item_inventory_links where source_id = $1", [drop.id])).rows).toHaveLength(0);
    const ghost = await db.query("select 1 from public.core_outbox where event_type = 'menu.item.available' and subject_id = $1", [drop.id]);
    expect(ghost.rows).toHaveLength(0);
  });

  it("a stale duplicate apply is refused; cross-tenant ids are refused", async () => {
    const snap = await driver.getMenuSnapshot(T);
    const built = buildImportRows(T, snap, parse(GENERIC_TEMPLATE_CSV), "add");
    await driver.applyMenuImport(T, built.changes);
    await expect(driver.applyMenuImport(T, structuredClone(built.changes))).rejects.toThrow(/menu changed/);
    const attack = buildImportRows(T, await driver.getMenuSnapshot(T), parse("item,price\nZzz,1\n"), "add").changes;
    attack.delete.items.push(crypto.randomUUID());
    await expect(driver.applyMenuImport(T, attack)).rejects.toThrow(/not found/);
  });

  it("times a 2000-item import (outbox triggers on)", async () => {
    const lines = ["category,item,size,price"];
    for (let i = 0; i < 2000; i++) lines.push(`Bulk ${i % 20},Bulk item ${i},Regular,${(i % 30) + 1}.00`);
    await db.query("delete from public.core_outbox");
    const t0 = performance.now();
    const built = buildImportRows(T, await driver.getMenuSnapshot(T), parse(lines.join("\n")), "replace");
    await driver.applyMenuImport(T, built.changes);
    const ms = performance.now() - t0;
    console.log(`import 2000 items (replace, outbox on): ${Math.round(ms)} ms`);
    expect((await driver.getMenuSnapshot(T)).items).toHaveLength(2000);
    // One announcement for the whole import, not one per row.
    const emitted = await db.query("select 1 from public.core_outbox where event_type = 'menu.updated' and tenant_id = $1", [T]);
    expect(emitted.rows).toHaveLength(1);
    expect(ms).toBeLessThan(30_000);
  }, 120_000);
});
