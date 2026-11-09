/**
 * Stored value at the edges: the shared guess limiter, hub (core) mapping, and
 * kitchen printing.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { DEMO_LOCATION_DOWNTOWN_ID, DEMO_TENANT_ID, getPosDriver, type Order, type Payment } from "@/lib/db";
import { resetMockOrders, resetMockPayments } from "@/lib/db/mock";
import { railToMethod, toContractOrder, toContractPayment } from "@/lib/core/mappers";
import { autoPrintOnFire } from "@/lib/printing/queue";
import { OrderSchema, PaymentSchema } from "@openpizza/core";
import { lookupKeys } from "./http";
import { mockStoredValueStore, resetMockStoredValue } from "./store-mock";

beforeEach(() => {
  resetMockOrders();
  resetMockPayments();
  resetMockStoredValue();
});

describe("shared guess limiter (store-backed)", () => {
  it("locks keys out after the limit, per key, and scopes keys to the tenant", async () => {
    const keys = lookupKeys({ ip: "1.2.3.4", device: "dev", surface: "shop" }, "tenant-a");
    expect(keys).toEqual(["shop:ip:1.2.3.4:tenant-a", "shop:dev:dev:tenant-a"]);
    // The device key is attacker-controlled; the IP + tenant key is not.
    for (let i = 0; i < 3; i += 1) await mockStoredValueStore.guardFail(keys, 2, 900);
    expect(await mockStoredValueStore.guardCheck([keys[0]!])).toBeGreaterThan(0);
    expect(await mockStoredValueStore.guardCheck(["shop:dev:fresh-cookie:tenant-a", keys[0]!])).toBeGreaterThan(0);
    expect(await mockStoredValueStore.guardCheck(["shop:ip:1.2.3.4:tenant-b"])).toBe(0);
  });
});

function saleOrder(): Order {
  const at = new Date().toISOString();
  return {
    id: randomUUID(),
    tenant_id: DEMO_TENANT_ID,
    location_id: DEMO_LOCATION_DOWNTOWN_ID,
    status: "paid",
    channel: "in_store",
    currency: "USD",
    items: [],
    discount_cents: 0,
    totals: { subtotal_cents: 0, discount_cents: 0, taxable_cents: 0, tax_cents: 0, tip_cents: 0, total_cents: 5000 },
    notes: null,
    order_number: "1",
    core_ext: { stored_value: { op: "sell", account_id: randomUUID(), amount_cents: 5000, code_last4: "ABCD" } },
    created_at: at,
    updated_at: at,
  };
}

describe("till lockout keys", () => {
  it("the authenticated till is keyed by device login and staff, never by IP", () => {
    expect(lookupKeys({ ip: "9.9.9.9", device: "user-1", staff: "staff-1", surface: "till" }, "t")).toEqual([
      "till:dev:user-1:t",
      "till:staff:staff-1:t",
    ]);
    expect(lookupKeys({ ip: "9.9.9.9", device: "user-1", surface: "till" }, "t")).toEqual(["till:dev:user-1:t"]);
  });
});

describe("hub mapping", () => {
  it("flags sale orders and maps stored-value tenders to their own method", () => {
    const o = saleOrder();
    expect(toContractOrder({ order: o, payments: [], timezone: "UTC" }).metadata).toEqual({ stored_value: "gift_card_sale" });
    const reload = { ...o, core_ext: { stored_value: { ...o.core_ext!.stored_value!, op: "reload" as const } } };
    expect(toContractOrder({ order: reload, payments: [], timezone: "UTC" }).metadata.stored_value).toBe("gift_card_reload");
    expect(railToMethod("gift_card")).toBe("gift_card");
    expect(railToMethod("store_credit")).toBe("gift_card");
    const mapped = toContractOrder({ order: o, payments: [], timezone: "UTC" });
    expect(mapped.lines).toEqual([
      expect.objectContaining({ line_type: "gift_card_load", kind: "gift_card", line_total_cents: 5000, tax_exempt: true }),
    ]);
    // The hub contract accepts it as is.
    expect(() => OrderSchema.parse(mapped)).not.toThrow();
    const p = {
      id: randomUUID(), order_id: o.id, tenant_id: o.tenant_id, location_id: o.location_id, rail: "gift_card",
      status: "captured", amount_cents: 100, tip_cents: 0, application_fee_cents: 0, currency: "USD",
      charge_id: null, connect_account_id: null, crypto_tx_hash: null, crypto_chain: null,
      cash_tendered_cents: null, cash_change_cents: null, refunded_cents: 0, simulated: false, raw: null,
      created_at: o.created_at, updated_at: o.created_at,
    } as Payment;
    expect(toContractPayment(p)).toMatchObject({ method: "gift_card", processor: "pos" });
    const sc = toContractPayment({ ...p, rail: "store_credit" });
    expect(sc).toMatchObject({ method: "gift_card", processor: "store_credit" });
    expect(() => PaymentSchema.parse(sc)).not.toThrow();
  });
});

describe("printing", () => {
  it("never auto-prints a kitchen ticket for a gift card sale", async () => {
    const spy = vi.spyOn(getPosDriver(), "getPrintSettings");
    expect(await autoPrintOnFire(saleOrder())).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  });
});
