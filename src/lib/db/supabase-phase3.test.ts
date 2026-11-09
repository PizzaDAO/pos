/**
 * Tip events on the REAL SQL through the Supabase driver: the payments trigger
 * (20261107000000) writes thin outbox rows, the outbox worker's hydrator rebuilds
 * each TipFact through the driver, and it must equal what `tipFactsForOrder` (the
 * `GET /v1/tips` builder) says for the same state. Opt-in like
 * supabase-phase2.test.ts:
 *
 *   PGLITE=../core/node_modules/@electric-sql/pglite npx vitest run src/lib/db/supabase-phase3.test.ts
 *
 * Without PGLITE the suite is skipped (CI).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { PosDriver } from "@/lib/db/driver";
import { hydrateEvent, type OutboxRow } from "@/lib/core/outbox";
import { tipFactsForOrder } from "@/lib/core/tips";
import { businessDate } from "@openpizza/core";

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
      q.range = (from: number, to: number) => ((lim = ` limit ${to - from + 1} offset ${from}`), q);
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
const ORD = "e3000000-0000-4000-8000-000000000001";
const ORD_ONLINE = "e3000000-0000-4000-8000-000000000002";
const P1 = "e3000000-0000-4000-8000-0000000000a1";
const P2 = "e3000000-0000-4000-8000-0000000000a2";
const P3 = "e3000000-0000-4000-8000-0000000000a3";

describe.skipIf(!PGLITE)("tip events through the Supabase driver on PGlite", () => {
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
    await db.query("select public.core_set_outbox_enabled(true)");
    loc = (await db.query("select id from public.locations where tenant_id = $1 limit 1", [T])).rows[0]!
      .id as string;
    for (const [id, n, tip] of [
      [ORD, "S3-1", 0],
      [ORD_ONLINE, "S3-2", 500],
    ] as const) {
      await db.query(
        `insert into public.orders (id, tenant_id, location_id, status, currency, totals, order_number, core_announced)
         values ($1, $2, $3, 'placed', 'USD', $5::jsonb, $4, true)`,
        [id, T, loc, n, JSON.stringify({ subtotal_cents: 2000, discount_cents: 0, taxable_cents: 2000, tax_cents: 0, total_cents: 2000 + tip, tip_cents: tip })],
      );
    }
    await db.query("delete from public.core_outbox where event_type like 'tip.%'");
    const { createSupabaseDriver } = await import("@/lib/db/supabase");
    driver = createSupabaseDriver({ url: "http://x", key: "k" });
  }, 60_000);
  afterAll(async () => {
    await db?.close();
  });

  const insertPay = (id: string, order: string, status: string, tip: number, refunded = 0) =>
    db.query(
      `insert into public.payments (id, order_id, tenant_id, location_id, rail, status, amount_cents, tip_cents, currency, simulated, refunded_cents)
       values ($1, $2, $3, $4, 'cash', $5, 1000, $6, 'USD', false, $7)`,
      [id, order, T, loc, status, tip, refunded],
    );
  const factsOf = async (orderId: string) => {
    const o = (await driver.getOrder(orderId))!;
    const tz = "America/New_York";
    return tipFactsForOrder(
      {
        id: o.id,
        tenant_id: o.tenant_id,
        location_id: o.location_id,
        business_date: businessDate(o.created_at, tz),
        currency: o.currency,
        staff_id: o.staff_id ?? null,
        status: o.status,
        tip_cents: o.totals.tip_cents,
        timezone: tz,
      },
      await driver.listPaymentsForOrder(orderId),
    );
  };
  const tipRows = async () =>
    (await db.query("select * from public.core_outbox where event_type like 'tip.%' order by sequence"))
      .rows as unknown as OutboxRow[];

  it("every emitted row hydrates to the fact the list builder produces; replays add none", async () => {
    await insertPay(P1, ORD, "pending", 300);
    await insertPay(P3, ORD_ONLINE, "captured", 0);
    expect(await tipRows()).toHaveLength(1); // only the online fact (P1 is pending)
    await db.query("update public.payments set status = 'captured' where id = $1", [P1]);
    await db.query("update public.payments set status = 'captured' where id = $1", [P1]); // replay
    // Refunds written raw (refunded_cents + a refunds[] entry with no tip part in
    // the same UPDATE): the legacy rule, base first, only beyond the base is tip.
    const refund = (id: string, n: number, at: string) => ({ id, amount_cents: n, at, processor_ref: null, reason: null });
    const r1 = [refund("r1", 1120, "2026-06-04T20:00:00.000Z")];
    const r2 = [...r1, refund("r2", 180, "2026-06-04T21:00:00.000Z")];
    await db.query("update public.payments set refunded_cents = 1120, refunds = $2::jsonb where id = $1", [P1, JSON.stringify(r1)]);
    await db.query("update public.payments set refunded_cents = 1120, refunds = $2::jsonb where id = $1", [P1, JSON.stringify(r1)]); // replay
    await db.query("update public.payments set refunded_cents = 1300, status = 'refunded', refunds = $2::jsonb where id = $1", [P1, JSON.stringify(r2)]);
    const rows = await tipRows();
    expect(rows.map((r) => r.row_snapshot?.fact_id)).toEqual([
      `tip_online_${ORD_ONLINE}`,
      `tip_${P1}`,
      `tipadj_${P1}_c120`,
      `tipadj_${P1}_c300`,
    ]);
    expect(new Set(rows.map((r) => r.sequence)).size).toBe(rows.length);

    const facts = new Map<string, unknown>();
    for (const orderId of [ORD, ORD_ONLINE]) {
      for (const f of await factsOf(orderId)) facts.set(f.id, f);
    }
    for (const row of rows) {
      const ev = await hydrateEvent(row, driver);
      expect(ev, String(row.row_snapshot?.fact_id)).not.toBeNull();
      expect(ev!.data).toEqual(facts.get(String(row.row_snapshot?.fact_id)));
    }
    expect(facts.size).toBe(rows.length);
  });

  it("a second tender cannot mint a second online fact (sequential twin of the advisory-lock race)", async () => {
    await insertPay(P2, ORD_ONLINE, "captured", 0);
    const n = (await tipRows()).filter(
      (r) => r.row_snapshot?.fact_id === `tip_online_${ORD_ONLINE}`,
    ).length;
    expect(n).toBe(1);
  });

  it("shop flow: a card tip captured while the checkout is unannounced is emitted once when it is paid", async () => {
    const SHOP = "e3000000-0000-4000-8000-000000000003";
    const PS = "e3000000-0000-4000-8000-0000000000b1";
    await db.query(
      `insert into public.orders (id, tenant_id, location_id, status, currency, totals, order_number, core_announced)
       values ($1, $2, $3, 'awaiting_payment', 'USD', $5::jsonb, $4, false)`,
      [SHOP, T, loc, "S3-3", JSON.stringify({ subtotal_cents: 2000, discount_cents: 0, taxable_cents: 2000, tax_cents: 0, total_cents: 2000, tip_cents: 0 })],
    );
    const before = (await tipRows()).length;
    await db.query(
      `insert into public.payments (id, order_id, tenant_id, location_id, rail, status, amount_cents, tip_cents, currency, simulated)
       values ($1, $2, $3, $4, 'stripe_online', 'captured', 2000, 250, 'USD', false)`,
      [PS, SHOP, T, loc],
    );
    expect(await tipRows()).toHaveLength(before);
    await db.query("update public.orders set status = 'paid' where id = $1", [SHOP]);
    await db.query("update public.orders set status = 'paid' where id = $1", [SHOP]); // replay
    const mine = (await tipRows()).filter((r) => r.row_snapshot?.order_id === SHOP);
    expect(mine.map((r) => r.row_snapshot?.fact_id)).toEqual([`tip_${PS}`]);
    const ev = await hydrateEvent(mine[0]!, driver);
    expect(ev!.data).toEqual((await factsOf(SHOP))[0]);
  });

  it("the read endpoints run on the Supabase driver: tips (incl. a refund after the fact), hourly, kitchen load", async () => {
    const { handleV1 } = await import("@/lib/core/v1");
    const principal = {
      kind: "service" as const,
      id: "hub:test",
      tenant_id: T,
      location_ids: null,
      scopes: ["*"],
      module: "workforce",
    };
    const get = async (path: string) => {
      const res = await handleV1(new Request(`https://pos.test/api/v1${path}`), path.split("?")[0]!.split("/").filter(Boolean), { principal, driver });
      return { status: res.status, json: JSON.parse(await res.text()) };
    };
    const day = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);
    const tips = await get(`/tips?from=${day(-2)}&to=${day(2)}`);
    expect(tips.status).toBe(200);
    const byId = new Map<string, { kind: string; amount_cents: number; business_date: string }>(
      tips.json.data.map((f: { id: string }) => [f.id, f]),
    );
    expect(byId.get(`tip_${P1}`)).toMatchObject({ kind: "cash_on_tender", amount_cents: 300 });
    // The refunds were recorded `at` 2026-06-04: adjustments are dated by the
    // refund, so they appear in THAT range even though the order is from today.
    expect(byId.has(`tipadj_${P1}_c120`)).toBe(false);
    const refundDay = await get("/tips?from=2026-06-03&to=2026-06-05");
    const adj = new Map<string, { kind: string; amount_cents: number }>(
      refundDay.json.data.map((f: { id: string }) => [f.id, f]),
    );
    expect(adj.get(`tipadj_${P1}_c120`)).toMatchObject({ kind: "adjustment", amount_cents: -120 });
    expect(adj.get(`tipadj_${P1}_c300`)).toMatchObject({ kind: "adjustment", amount_cents: -180 });
    expect(adj.has(`tip_${P1}`)).toBe(false);
    const paged = await get(`/tips?from=${day(-2)}&to=${day(2)}&limit=1`);
    expect(paged.json.data).toHaveLength(1);
    expect(paged.json.next_cursor).toBeTruthy();
    const hourly = await get(`/locations/${loc}/sales/hourly?from=${day(-2)}&to=${day(2)}`);
    expect(hourly.status).toBe(200);
    expect(hourly.json.data.reduce((n: number, r: { order_count: number }) => n + r.order_count, 0)).toBeGreaterThan(0);
    const kitchen = await get(`/locations/${loc}/kitchen-load`);
    expect(kitchen.status).toBe(200);
    expect(kitchen.json.active_orders).toBeGreaterThan(0);
  });
});
