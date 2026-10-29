import { describe, it, expect } from "vitest";
import type { OrderItem } from "@/lib/db";
import {
  checkoutSignature,
  forgetCheckoutOrderId,
  getCheckoutOrderId,
  type CheckoutSignatureInput,
} from "./checkout-order-id";

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, v),
  };
}

function counter() {
  let n = 0;
  return () => `id-${(n += 1)}`;
}

const line = (over: Partial<OrderItem> = {}): OrderItem => ({
  id: "line-1",
  item_id: "pep",
  item_name: "Pepperoni",
  size_id: "lg",
  size_name: "Large",
  base_price_cents: 1500,
  quantity: 1,
  modifiers: [],
  notes: null,
  voided: false,
  unit_price_cents: 1500,
  line_total_cents: 1500,
  ...over,
});

const base: CheckoutSignatureInput = {
  slug: "downtown",
  items: [line()],
  fulfillmentType: "pickup",
  scheduledFor: "asap",
  email: "a@b.co",
  tipCents: 0,
};

describe("one order id per checkout", () => {
  it("reuses the id across retries / reloads of the same checkout", () => {
    const s = memoryStorage();
    const mint = counter();
    const a = getCheckoutOrderId(base, mint, s);
    const b = getCheckoutOrderId({ ...base }, mint, s);
    expect(b.id).toBe(a.id);
    expect(b.superseded).toBeNull();
  });

  it("ignores client-generated line ids and email case", () => {
    const s = memoryStorage();
    const mint = counter();
    const a = getCheckoutOrderId(base, mint, s);
    const b = getCheckoutOrderId(
      { ...base, items: [line({ id: "other" })], email: " A@B.co " },
      mint,
      s,
    );
    expect(b.id).toBe(a.id);
  });

  it("mints a new id (and returns the old one) on a material change", () => {
    const s = memoryStorage();
    const mint = counter();
    const a = getCheckoutOrderId(base, mint, s);
    for (const change of [
      { tipCents: 200 },
      { scheduledFor: "2026-11-01T18:00:00Z" },
      { fulfillmentType: "delivery" as const },
      { items: [line({ quantity: 2 })] },
    ]) {
      const fresh = memoryStorage();
      const mintFresh = counter();
      const first = getCheckoutOrderId(base, mintFresh, fresh);
      const next = getCheckoutOrderId({ ...base, ...change }, mintFresh, fresh);
      expect(next.id).not.toBe(first.id);
      expect(next.superseded).toBe(first.id);
    }
    expect(a.id).toBe("id-1");
  });

  it("forget starts a fresh checkout", () => {
    const s = memoryStorage();
    const mint = counter();
    const a = getCheckoutOrderId(base, mint, s);
    forgetCheckoutOrderId(base.slug, s);
    const b = getCheckoutOrderId(base, mint, s);
    expect(b.id).not.toBe(a.id);
    expect(b.superseded).toBeNull();
  });

  it("degrades to a fresh id per call when storage is unavailable", () => {
    const mint = counter();
    const a = getCheckoutOrderId(base, mint, null);
    const b = getCheckoutOrderId(base, mint, null);
    expect(a.id).not.toBe(b.id);
  });

  it("signature is deterministic", () => {
    expect(checkoutSignature(base)).toBe(checkoutSignature({ ...base }));
  });
});
