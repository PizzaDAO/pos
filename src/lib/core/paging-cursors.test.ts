import { beforeEach, describe, expect, it } from "vitest";
import {
  getPosDriver,
  DEMO_LOCATION_DOWNTOWN_ID,
  DEMO_TENANT_ID,
  type Order,
  type PosDriver,
} from "@/lib/db";
import { fetchAllPages, safeKeyset } from "@/lib/db/paging";
import { resetMockOrders } from "@/lib/db/mock";
import { DEV_TOKEN } from "./auth";
import { handleV1 } from "./v1";
import { deliverOutbox, isOutboxOwner, memoryOutbox } from "./outbox";

beforeEach(() => {
  resetMockOrders();
  memoryOutbox.clear();
});

describe("fetchAllPages (PostgREST row cap)", () => {
  it("pages past a server cap until a short page", async () => {
    const SERVER_CAP = 1000;
    const data = Array.from({ length: 2750 }, (_, i) => i);
    let calls = 0;
    // Simulates PostgREST: honors .range() but never returns more than the cap.
    const fetchPage = async (from: number, to: number) => {
      calls += 1;
      return data.slice(from, Math.min(to + 1, from + SERVER_CAP));
    };
    const all = await fetchAllPages(fetchPage, 500);
    expect(all).toHaveLength(2750);
    expect(new Set(all).size).toBe(2750);
    expect(calls).toBe(6);
    // exact multiple of the page size needs one more (empty) probe
    expect(await fetchAllPages(async (f, t) => data.slice(f, Math.min(t + 1, 1000)), 500)).toHaveLength(1000);
  });
});

describe("cursor validation", () => {
  it("safeKeyset accepts ISO + GUID and normalizes to Z", () => {
    expect(
      safeKeyset({ created_at: "2026-06-04T22:00:00+00:00", id: "b0000000-0000-4000-8000-0000000000a1" }),
    ).toEqual({ created_at: "2026-06-04T22:00:00.000Z", id: "b0000000-0000-4000-8000-0000000000a1" });
  });

  it("rejects filter-injection attempts", () => {
    for (const bad of [
      { created_at: "2026-06-04T22:00:00Z),id.gt.0", id: "b0000000-0000-4000-8000-0000000000a1" },
      { created_at: "2026-06-04T22:00:00Z", id: "x),tenant_id.neq.0" },
      { created_at: "yesterday", id: "b0000000-0000-4000-8000-0000000000a1" },
    ]) {
      expect(() => safeKeyset(bad)).toThrow();
    }
  });

  it("the API answers 422 for a forged cursor", async () => {
    const forged = Buffer.from(JSON.stringify(["x),id.gt.0", "y"])).toString("base64url");
    const res = await handleV1(
      new Request(`https://pos.test/api/v1/orders?cursor=${forged}`, {
        headers: { authorization: `Bearer ${DEV_TOKEN}` },
      }),
      ["orders"],
    );
    expect(res.status).toBe(422);
  });
});

describe("filtered scans keep a cursor", () => {
  function fakeDriver(): PosDriver {
    const real = getPosDriver();
    let n = 0;
    return {
      ...real,
      // Endless supply of non-matching (placed) orders, 200 per page.
      async listOrdersPage(_t, loc, opts) {
        const base = opts.after ? Date.parse(opts.after.created_at) : Date.parse("2026-01-01T00:00:00Z");
        return Array.from({ length: opts.limit }, (_, i) => {
          n += 1;
          const ts = new Date(base + (i + 1) * 1000).toISOString();
          return {
            id: `c0000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`,
            tenant_id: DEMO_TENANT_ID,
            location_id: loc,
            status: "placed",
            channel: "in_store",
            currency: "USD",
            items: [],
            discount_cents: 0,
            totals: {
              subtotal_cents: 0,
              discount_cents: 0,
              taxable_cents: 0,
              tax_cents: 0,
              tip_cents: 0,
              total_cents: 0,
            },
            notes: null,
            order_number: String(n),
            created_at: ts,
            updated_at: ts,
          } satisfies Order;
        });
      },
    } as PosDriver;
  }

  it("a cut-short filtered scan reports a resume cursor instead of null", async () => {
    const res = await handleV1(
      new Request(
        `https://pos.test/api/v1/orders?fulfillment_status=ready&location_id=${DEMO_LOCATION_DOWNTOWN_ID}`,
        { headers: { authorization: `Bearer ${DEV_TOKEN}` } },
      ),
      ["orders"],
      { driver: fakeDriver() },
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.data).toEqual([]);
    expect(json.next_cursor).toBeTruthy(); // not "done"
  });
});

describe("outbox run budget + ownership", () => {
  it("releases unattempted claims WITHOUT counting an attempt", async () => {
    const d = getPosDriver();
    for (let i = 0; i < 3; i++) {
      memoryOutbox.append({
        tenant_id: DEMO_TENANT_ID,
        location_id: DEMO_LOCATION_DOWNTOWN_ID,
        event_type: "order.updated",
        subject_type: "order",
        subject_id: `d0000000-0000-4000-8000-00000000000${i}`,
      });
    }
    let fetched = 0;
    const res = await deliverOutbox({
      ingestUrl: "https://hub.test/ingest",
      secret: "whsec_" + Buffer.from("0123456789abcdef0123456789abcdef").toString("base64"),
      store: memoryOutbox,
      unsafeAllowMockStore: true,
      driver: d,
      deadlineMs: -1, // already out of time
      now: () => new Date(Date.now() + 1000),
      fetch: (async () => {
        fetched += 1;
        return new Response(null, { status: 200 });
      }) as unknown as typeof fetch,
    });
    expect(res).toMatchObject({ claimed: 3, released: 3, delivered: 0 });
    expect(fetched).toBe(0);
    expect(memoryOutbox.rows.map((r) => r.attempts)).toEqual([0, 0, 0]);
    expect(memoryOutbox.rows.every((r) => r.status === "pending")).toBe(true);
  });

  it("only the production deployment (or OUTBOX_OWNER=1) owns the outbox", async () => {
    expect(isOutboxOwner({})).toBe(false);
    expect(isOutboxOwner({ VERCEL_ENV: "preview" })).toBe(false);
    expect(isOutboxOwner({ VERCEL_ENV: "production" })).toBe(true);
    expect(isOutboxOwner({ OUTBOX_OWNER: "1" })).toBe(true);
    const { GET } = await import("@/app/api/core/outbox/route");
    const res = await GET(new Request("https://pos.test/api/core/outbox"));
    expect(await res.json()).toEqual({ skipped: "not_outbox_owner" });
  });
});
