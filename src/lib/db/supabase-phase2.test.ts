/**
 * The Supabase driver's phase 2 methods (recordExternalTender,
 * upsertCustomerIdentity, setStaffPinHash) against the REAL SQL: every migration
 * and the seed are applied to an in-memory PGlite, and a tiny supabase-js stand-in
 * routes `.rpc()` / `.from()` to it. Opt-in, because PGlite is not a POS
 * dependency:
 *
 *   PGLITE=../core/node_modules/@electric-sql/pglite npx vitest run src/lib/db/supabase-phase2.test.ts
 *
 * Without PGLITE the suite is skipped (CI). scripts/pglite-migrate.mjs +
 * supabase/tests/phase2_external_and_customers.sql cover the SQL on its own.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { PosDriver } from "@/lib/db/driver";
import { tenderFingerprint } from "@/lib/db/payment-types";

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
      type F = { col: string; op: "eq" | "in" | "is"; val: unknown };
      const filters: F[] = [];
      let patch: Record<string, unknown> | null = null;
      let single = false;
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.update = (p: Record<string, unknown>) => ((patch = p), q);
      q.eq = (col: string, val: unknown) => (filters.push({ col, op: "eq", val }), q);
      q.in = (col: string, val: unknown[]) => (filters.push({ col, op: "in", val }), q);
      q.is = (col: string, val: unknown) => (filters.push({ col, op: "is", val }), q);
      let orderBy = "";
      q.order = (col: string) => ((orderBy = ` order by ${col}`), q);
      q.maybeSingle = () => ((single = true), q);
      q.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
        run().then(res, rej);
      async function run() {
        try {
          const params: unknown[] = [];
          const where = filters
            .map((f) => {
              if (f.op === "is") return `${f.col} is null`;
              params.push(f.val);
              return f.op === "in"
                ? `${f.col}::text = any($${params.length})`
                : `${f.col} = $${params.length}`;
            })
            .join(" and ");
          let sql: string;
          if (patch) {
            const sets = Object.entries(patch).map(([k, v]) => {
              params.push(v);
              return `${k} = $${params.length}`;
            });
            sql = `update public.${table} set ${sets.join(", ")} where ${where} returning *`;
          } else {
            sql = `select * from public.${table}${where ? ` where ${where}` : ""}${orderBy}`;
          }
          const rows = (await db.query(sql, params)).rows;
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
const TONY = "80000000-0000-0000-0000-000000000001";
const ORDER = "d2000000-0000-4000-8000-000000000001";
const ORDER2 = "d2000000-0000-4000-8000-000000000002";

describe.skipIf(!PGLITE)("supabase driver phase 2 on PGlite", () => {
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
    for (const [id, n] of [[ORDER, "S2-1"], [ORDER2, "S2-2"]] as const) {
      await db.query(
        `insert into public.orders (id, tenant_id, location_id, status, currency, totals, order_number)
         values ($1, $2, $3, 'draft', 'USD', '{"total_cents":2000,"tip_cents":0}'::jsonb, $4)`,
        [id, T, loc, n],
      );
    }
    const { createSupabaseDriver } = await import("@/lib/db/supabase");
    driver = createSupabaseDriver({ url: "http://x", key: "k" });
  }, 60_000);
  afterAll(async () => {
    await db?.close();
  });

  const write = (over: Partial<Parameters<PosDriver["recordExternalTender"]>[0]> = {}) => ({
    tenantId: T,
    orderId: ORDER,
    paymentId: crypto.randomUUID(),
    method: "card",
    processor: "stripe_terminal",
    processorRef: null,
    amountCents: 500,
    tipCents: 50,
    status: "captured" as const,
    requestedStatus: "captured" as const,
    collection: "terminal",
    staffId: null,
    expect: { n: 0, amount: 0, tip: 0, refunded: 0 },
    recordedBy: { principal_id: "hub:kiosk-1", module: "kiosk" },
    ...over,
  });

  it("recordExternalTender: ok, replay, stale, duplicate ref, invalid state, supersede", async () => {
    const pending = await driver.recordExternalTender(
      write({ paymentId: "d2000000-0000-4000-8000-0000000000a1", processor: "catering", processorRef: "inv_1", status: "pending", requestedStatus: "authorized", collection: "invoice", method: "external" }),
    );
    expect(pending.outcome).toBe("ok");
    if (pending.outcome !== "ok") return;
    expect(pending.payment).toMatchObject({
      rail: "external",
      status: "pending",
      simulated: false,
      method: "external",
      processor: "catering",
      processor_ref: "inv_1",
      collection: "invoice",
      amount_cents: 500,
      tip_cents: 50,
      currency: "USD",
      location_id: loc,
      charge_id: null,
    });
    expect(pending.payment.raw).toEqual({
      requested_status: "authorized",
      recorded_by: { principal_id: "hub:kiosk-1", module: "kiosk" },
    });

    // stale: the fingerprint no longer matches (a pending tender exists now)
    const stale = await driver.recordExternalTender(write());
    expect(stale.outcome).toBe("stale");

    const tenders = await driver.listPaymentsForOrder(ORDER);
    const expect1 = tenderFingerprint(tenders);
    const captured = await driver.recordExternalTender(
      write({ paymentId: "d2000000-0000-4000-8000-0000000000a2", processor: "catering", processorRef: "inv_1", method: "external", collection: "invoice", expect: expect1 }),
    );
    expect(captured.outcome).toBe("ok");
    if (captured.outcome !== "ok") return;
    expect(captured.superseded).toEqual(["d2000000-0000-4000-8000-0000000000a1"]);
    expect((await driver.getPayment("d2000000-0000-4000-8000-0000000000a1"))?.status).toBe("canceled");

    const again = await driver.recordExternalTender(write({ paymentId: captured.payment.id }));
    expect(again.outcome).toBe("exists");

    const dup = await driver.recordExternalTender(
      write({ orderId: ORDER2, processor: "catering", processorRef: "inv_1", method: "external", collection: "invoice" }),
    );
    expect(dup.outcome).toBe("duplicate_ref");

    await db.query("update public.orders set status = 'voided' where id = $1", [ORDER2]);
    expect((await driver.recordExternalTender(write({ orderId: ORDER2 }))).outcome).toBe("invalid_state");
    expect((await driver.recordExternalTender(write({ orderId: crypto.randomUUID() }))).outcome).toBe("not_found");
    // foreign tenant: not_found, nothing leaked
    expect(
      (await driver.recordExternalTender(write({ tenantId: crypto.randomUUID() }))).outcome,
    ).toBe("not_found");
  });

  it("upsertCustomerIdentity: phone-only, merge-by-phone, no merge across emails, consent order", async () => {
    const base = { newId: crypto.randomUUID(), email: "pat@example.com", phone: "+15555550101", name: "Pat", marketing: {}, tags: ["a"], externalIds: { g: "1" } };
    // a phone-only row never gains an email through an ordinary upsert
    const lone = await driver.upsertCustomerIdentity(T, { ...base, email: null, newId: crypto.randomUUID(), phone: "+15555550102" });
    const offered = await driver.upsertCustomerIdentity(T, { ...base, newId: crypto.randomUUID(), email: "offer@example.com", phone: "+15555550102" });
    expect(offered.created).toBe(true);
    expect(offered.customer.id).not.toBe(lone.customer.id);
    expect(offered.customer.phone).toBeNull();
    expect((await driver.getCustomer(lone.customer.id))?.email).toBeNull();
    const a = await driver.upsertCustomerIdentity(T, { ...base, phone: null });
    expect(a).toMatchObject({ created: true, changed: true });
    expect(a.customer.phone).toBeNull();
    const b = await driver.upsertCustomerIdentity(T, {
      ...base, newId: crypto.randomUUID(), email: "Pat@Example.com", phone: "(555) 555-0101", name: "X", tags: ["b"],
      marketing: { sms: { opt_in: true, at: "2026-01-02T00:00:00Z" } },
    });
    expect(b.created).toBe(false);
    expect(b.customer).toMatchObject({ id: a.customer.id, email: "pat@example.com", name: "Pat", tags: ["a", "b"] });
    expect(b.customer.marketing?.sms?.opt_in).toBe(true);
    const noop = await driver.upsertCustomerIdentity(T, { ...base, email: "pat@example.com", phone: null, name: null, tags: [], externalIds: {} });
    expect(noop.changed).toBe(false);
    const other = await driver.upsertCustomerIdentity(T, { ...base, newId: crypto.randomUUID(), email: "sam@example.com" });
    expect(other.created).toBe(true);
    expect(other.customer.id).not.toBe(a.customer.id);
    expect(other.customer.phone).toBeNull();
    const older = await driver.upsertCustomerIdentity(T, {
      ...base, email: "pat@example.com", phone: null, name: null, tags: [], externalIds: {},
      marketing: { sms: { opt_in: false, at: "2026-01-01T00:00:00Z" } },
    });
    expect(older.customer.marketing?.sms?.opt_in).toBe(true);
    expect((await driver.getCustomer(a.customer.id))?.tags).toEqual(["a", "b"]);
  });

  it("setStaffPinHash is one targeted update and resets the lockout", async () => {
    await db.query("update public.staff set pin_failed_attempts = 3, pin_locked_until = now() + interval '10 minutes' where id = $1", [TONY]);
    expect(await driver.setStaffPinHash(T, TONY, "scrypt$aa$bb")).toBe(true);
    const row = (await db.query("select pin_hash, pin_failed_attempts, pin_locked_until, name from public.staff where id = $1", [TONY])).rows[0]!;
    expect(row).toMatchObject({ pin_hash: "scrypt$aa$bb", pin_failed_attempts: 0, pin_locked_until: null, name: "Tony Soprano" });
    expect(await driver.setStaffPinHash(T, crypto.randomUUID(), "x")).toBe(false);
    expect(await driver.setStaffPinHash(crypto.randomUUID(), TONY, "x")).toBe(false);
    expect(await driver.setStaffPinHash(T, TONY, null)).toBe(true);
    expect((await db.query("select pin_hash from public.staff where id = $1", [TONY])).rows[0]!.pin_hash).toBeNull();
  });
});
