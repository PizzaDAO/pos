import { describe, expect, it } from "vitest";
import { cleanProvisionalLabel, orderNumberLabel, sanitizeTillCoreExt } from "./order-meta";

describe("provisional order labels", () => {
  it("the server keeps a clean provisional label from the till", () => {
    expect(sanitizeTillCoreExt({ provisional_label: "1405-123" })).toEqual({ provisional_label: "1405-123" });
    expect(
      sanitizeTillCoreExt({ callout_name: "Al", provisional_label: "1405-123", fees: [{}] }),
    ).toEqual({ callout_name: "Al", provisional_label: "1405-123" });
    expect(cleanProvisionalLabel("<script>")).toBeNull();
    expect(cleanProvisionalLabel("x".repeat(33))).toBeNull();
  });

  it("shows the real number with what the till showed", () => {
    expect(orderNumberLabel({ order_number: "A-0412", core_ext: { provisional_label: "1405-123" } })).toBe(
      "A-0412 (was 1405-123)",
    );
    expect(orderNumberLabel({ order_number: "1405-123", core_ext: { provisional_label: "1405-123" } })).toBe(
      "1405-123",
    );
    expect(orderNumberLabel({ order_number: "A-0001", core_ext: null })).toBe("A-0001");
  });
});
