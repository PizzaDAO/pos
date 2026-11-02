import { describe, it, expect } from "vitest";
import { canEscDismissCheckout } from "./checkout-dismiss";

describe("canEscDismissCheckout", () => {
  it("allows Esc on the input steps", () => {
    for (const step of ["fulfillment", "identity", "payment"] as const) {
      expect(canEscDismissCheckout(step, false)).toBe(true);
    }
  });
  it("blocks Esc on done and waiting, and while loading", () => {
    expect(canEscDismissCheckout("done", false)).toBe(false);
    expect(canEscDismissCheckout("waiting", false)).toBe(false);
    expect(canEscDismissCheckout("payment", true)).toBe(false);
  });
});
