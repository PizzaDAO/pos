/**
 * Phase 4 through the REAL Supabase driver on PGlite: the compare-and-set tender
 * link, allergen publication, the delivery compare-and-set, and the anonymous
 * customer match. Opt-in like supabase-phase2.test.ts:
 *
 *   PGLITE=../core/node_modules/@electric-sql/pglite npx vitest run src/lib/db/supabase-phase4.test.ts
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

const jsonParam = (v: unknown) =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? JSON.stringify(v) : v;

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
const T2 = "10000000-0000-0000-0000-0000000000f2";
const ORDER = "d4000000-0000-4000-8000-000000000001";
const P_OPEN = "d4000000-0000-4000-8000-0000000000a1";
const P_CLOSED = "d4000000-0000-4000-8000-0000000000a2";
const DELIVERY = "d4000000-0000-4000-8000-0000000000d1";

describe.skipIf(!PGLITE)("supabase driver phase 4 on PGlite", () => {
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
    await db.query(`insert into public.tenants (id, name, slug, status) values ($1, 'Other', 'other-p4', 'active')`, [T2]);
    await db.query(
      `insert into public.orders (id, tenant_id, location_id, status, currency, totals, order_number)
       values ($1, $2, $3, 'draft', 'USD', '{"total_cents":2000,"tip_cents":0}'::jsonb, 'S4-1')`,
      [ORDER, T, loc],
    );
    for (const [id, status] of [[P_OPEN, "requires_action"], [P_CLOSED, "canceled"]] as const) {
      await db.query(
        `insert into public.payments (id, order_id, tenant_id, location_id, rail, status, amount_cents, tip_cents, currency, simulated, raw)
         values ($1, $2, $3, $4, 'stripe_online', $5, 1000, 0, 'USD', false, '{"keep":"me"}'::jsonb)`,
        [id, ORDER, T, loc, status],
      );
    }
    await db.query(
      `insert into public.deliveries (id, order_id, tenant_id, location_id, provider, status, fee_cents, currency, dropoff)
       values ($1, $2, $3, $4, 'openpizza_driver', 'dispatched', 300, 'USD', '{"line1":"1 Main","city":"T","country":"US"}'::jsonb)`,
      [DELIVERY, ORDER, T, loc],
    );
    const { createSupabaseDriver } = await import("@/lib/db/supabase");
    driver = createSupabaseDriver({ url: "http://x", key: "k" });
  }, 60_000);
  afterAll(async () => {
    await db?.close();
  });

  it("linkTenderSession links only an open tender of this tenant", async () => {
    expect(await driver.linkTenderSession(T2, P_OPEN, "cs_x")).toMatchObject({ ok: false, reason: "not_found" });
    const ok = await driver.linkTenderSession(T, P_OPEN, "cs_test_1");
    expect(ok.ok).toBe(true);
    expect((await driver.getPayment(P_OPEN))!.raw).toEqual({ keep: "me", checkout_session_id: "cs_test_1" });
    const closed = await driver.linkTenderSession(T, P_CLOSED, "cs_late");
    expect(closed).toMatchObject({ ok: false, reason: "not_open", status: "canceled" });
    expect((await driver.getPayment(P_CLOSED))!.raw).toEqual({ keep: "me" });
  });

  it("a close racing the link: whichever commits first wins, the loser changes nothing", async () => {
    // Cancel lands between the caller's re-read and its write: the link must not
    // resurrect it (the old whole-row upsert did).
    const id = "d4000000-0000-4000-8000-0000000000a3";
    const order2 = "d4000000-0000-4000-8000-000000000002";
    await db.query(
      `insert into public.orders (id, tenant_id, location_id, status, currency, totals, order_number)
       values ($1, $2, $3, 'draft', 'USD', '{"total_cents":2000,"tip_cents":0}'::jsonb, 'S4-2')`,
      [order2, T, loc],
    );
    await db.query(
      `insert into public.payments (id, order_id, tenant_id, location_id, rail, status, amount_cents, tip_cents, currency, simulated, raw)
       values ($1, $2, $3, $4, 'stripe_online', 'requires_action', 1000, 0, 'USD', false, '{}'::jsonb)`,
      [id, order2, T, loc],
    );
    await db.query("update public.payments set status = 'canceled' where id = $1", [id]);
    expect(await driver.linkTenderSession(T, id, "cs_after_cancel")).toMatchObject({ ok: false, reason: "not_open" });
    expect((await driver.getPayment(id))!.status).toBe("canceled");
  });

  it("publishAllergens stores, replays, conflicts and refuses foreign targets", async () => {
    const item = (await db.query("select id from public.menu_items where tenant_id = $1 limit 1", [T])).rows[0]!.id as string;
    const input = (rows: { target_type: "item"; target_id: string; contains: string[]; may_contain: string[]; tags: string[] }[], v = "v1", h = "hash-aaaaaaaa") => ({
      version: v,
      payload_hash: h,
      location_ids: null,
      published_by: "backofhouse",
      rows,
    });
    const row = { target_type: "item" as const, target_id: item, contains: ["milk"], may_contain: [], tags: [] };
    const a = await driver.publishAllergens(T, input([row]));
    expect(a.outcome).toBe("ok");
    expect(await driver.publishAllergens(T, input([row]))).toMatchObject({ outcome: "replay" });
    expect(await driver.publishAllergens(T, input([row], "v1", "hash-bbbbbbbb"))).toEqual({ outcome: "conflict" });
    // Same item from another tenant's token: unknown target.
    expect(await driver.publishAllergens(T2, input([row], "v9"))).toMatchObject({ outcome: "unknown_target" });
    if (a.outcome === "ok") {
      expect((await driver.getAllergenPublication(T, a.publication.id))!.row_count).toBe(1);
      expect(await driver.getAllergenPublication(T2, a.publication.id)).toBeNull();
    }
  });

  it("transitionDelivery is a compare-and-set that never reopens a finished delivery", async () => {
    const first = await driver.transitionDelivery(DELIVERY, T, { status: "picked_up", driver_name: "Dee" });
    expect(first).toMatchObject({ ok: true });
    expect(await driver.transitionDelivery(DELIVERY, T2, { status: "delivered" })).toMatchObject({ ok: false, reason: "not_found" });
    const [a, b] = await Promise.all([
      driver.transitionDelivery(DELIVERY, T, { status: "delivered" }),
      driver.transitionDelivery(DELIVERY, T, { status: "canceled" }),
    ]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    const final = (await driver.getDelivery(DELIVERY))!;
    expect(final.status).toBe(a.ok ? "delivered" : "canceled");
    const late = await driver.transitionDelivery(DELIVERY, T, { status: "assigned" });
    expect(late).toMatchObject({ ok: false, reason: "terminal" });
    expect((await driver.getDelivery(DELIVERY))!.status).toBe(final.status);
    expect(final.driver_name).toBe("Dee");
  });

  it("an anonymous email match writes nothing (no phone planted)", async () => {
    const id = crypto.randomUUID();
    await db.query(
      `insert into public.customers (id, tenant_id, email, name) values ($1, $2, 'victim4@example.com', 'Victim')`,
      [id, T],
    );
    const before = (await db.query("select updated_at, phone, name from public.customers where id = $1", [id])).rows[0]!;
    const out = await driver.upsertCustomer({
      id: crypto.randomUUID(),
      tenant_id: T,
      email: "Victim4@Example.com",
      name: "Attacker",
      phone: "+14155550666",
      verified: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    expect(out.id).toBe(id);
    expect(out.phone).toBeNull();
    const after = (await db.query("select updated_at, phone, name from public.customers where id = $1", [id])).rows[0]!;
    expect(after).toEqual(before);
  });
});
