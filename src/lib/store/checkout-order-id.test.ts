import { describe, it, expect } from "vitest";
import type { OrderItem } from "@/lib/db";
import {
  checkoutSignature,
  forgetCheckoutOrderId,
  getCheckoutOrderId,
  type CheckoutSignatureInput,
} from "./checkout-order-id";
import { storefrontKey } from "@/lib/shop/storefront";

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

  it("contact details and notes are part of the checkout signature", () => {
    const s = memoryStorage();
    const mint = counter();
    const a = getCheckoutOrderId({ ...base, name: "Ann", phone: "555-0100" }, mint, s);
    expect(getCheckoutOrderId({ ...base, name: "Ann", phone: "555-0100" }, mint, s).id).toBe(a.id);
    for (const change of [
      { name: "Bob" },
      { phone: "555-0199" },
      { notes: "no onions" },
      { deliveryNotes: "ring twice" },
    ]) {
      const next = getCheckoutOrderId(
        { ...base, name: "Ann", phone: "555-0100", ...change },
        mint,
        s,
      );
      expect(next.id).not.toBe(a.id);
      // restore for the next iteration
      getCheckoutOrderId({ ...base, name: "Ann", phone: "555-0100" }, () => a.id, s);
    }
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

describe("keyed by storefront (tenant + location), migrating slug-only entries", () => {
  const keyA = storefrontKey({ tenantSlug: "tenant-a", locationSlug: "downtown" });
  const keyB = storefrontKey({ tenantSlug: "tenant-b", locationSlug: "downtown" });

  it("two tenants' same-slug locations never share or supersede a checkout", () => {
    const s = memoryStorage();
    const mint = counter();
    const a = getCheckoutOrderId({ ...base, slug: keyA }, mint, s);
    const b = getCheckoutOrderId({ ...base, slug: keyB }, mint, s);
    expect(b.id).not.toBe(a.id);
    expect(b.superseded).toBeNull(); // tenant A's unpaid order is not cancelled
    // Same cart, different tenant → different signature too.
    expect(checkoutSignature({ ...base, slug: keyA })).not.toBe(
      checkoutSignature({ ...base, slug: keyB }),
    );
    expect(getCheckoutOrderId({ ...base, slug: keyA }, mint, s).id).toBe(a.id);
    // forget for B leaves A alone.
    forgetCheckoutOrderId(keyB, s);
    expect(getCheckoutOrderId({ ...base, slug: keyA }, mint, s).id).toBe(a.id);
  });

  it("a mid-checkout legacy entry (same checkout) is migrated: same order id", () => {
    const s = memoryStorage();
    const mint = counter();
    // Written by the old build: key + signature by location slug alone.
    const legacy = getCheckoutOrderId({ ...base, slug: "downtown" }, () => "legacy-1", s);
    expect(legacy.id).toBe("legacy-1");
    const now = getCheckoutOrderId({ ...base, slug: keyA }, mint, s);
    expect(now).toEqual({ id: "legacy-1", superseded: null });
    expect(s.getItem("openpizza.checkout.downtown")).toBeNull(); // moved
    expect(getCheckoutOrderId({ ...base, slug: keyA }, mint, s).id).toBe("legacy-1");
  });

  it("a legacy entry for a different checkout is superseded (cancelled best-effort), not orphaned", () => {
    const s = memoryStorage();
    getCheckoutOrderId({ ...base, slug: "downtown", tipCents: 300 }, () => "legacy-2", s);
    const now = getCheckoutOrderId({ ...base, slug: keyA }, counter(), s);
    expect(now.superseded).toBe("legacy-2");
    expect(now.id).not.toBe("legacy-2");
    expect(s.getItem("openpizza.checkout.downtown")).toBeNull();
  });

  it("forget also clears the legacy entry (a paid pre-deploy order can't resurface)", () => {
    const s = memoryStorage();
    getCheckoutOrderId({ ...base, slug: "downtown" }, () => "legacy-paid", s);
    forgetCheckoutOrderId(keyA, s);
    expect(s.getItem("openpizza.checkout.downtown")).toBeNull();
    const next = getCheckoutOrderId({ ...base, slug: keyA }, counter(), s);
    expect(next.superseded).toBeNull();
  });
});
