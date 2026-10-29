import { describe, it, expect } from "vitest";
import { createPendingTenderIds, tenderSignature } from "./pending-tender";

function counter() {
  let n = 0;
  return () => `id-${(n += 1)}`;
}

const base = { orderId: "o1", rail: "stripe_terminal", amountCents: 1000, tipCents: 100 };

describe("pending tender ids (S11)", () => {
  it("reuses the same id for a retry of the same tender", () => {
    const ids = createPendingTenderIds(counter());
    const sig = tenderSignature(base);
    const first = ids.get(sig);
    expect(ids.get(sig)).toBe(first);
    expect(ids.get(tenderSignature({ ...base }))).toBe(first);
  });

  it("mints a new id when the amount, tip, rail or order changes", () => {
    const ids = createPendingTenderIds(counter());
    const a = ids.get(tenderSignature(base));
    const b = ids.get(tenderSignature({ ...base, amountCents: 900 }));
    expect(b).not.toBe(a);
    const c = ids.get(tenderSignature({ ...base, amountCents: 900, tipCents: 0 }));
    expect(c).not.toBe(b);
    const d = ids.get(tenderSignature({ ...base, amountCents: 900, tipCents: 0, rail: "cash" }));
    expect(d).not.toBe(c);
  });

  it("mints a new id after clear() (tender recorded)", () => {
    const ids = createPendingTenderIds(counter());
    const sig = tenderSignature(base);
    const first = ids.get(sig);
    ids.clear();
    expect(ids.get(sig)).not.toBe(first);
  });
});
