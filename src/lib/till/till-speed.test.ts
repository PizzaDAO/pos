import { describe, it, expect } from "vitest";
import type { ItemSize, MenuItemDetail, Order } from "@/lib/db";
import { quickCashNotes } from "./quick-cash";
import { canQuickAdd, pickDefaultSize, sizeNamesOf } from "./default-size";
import { shouldAutoSubmitPin } from "./pin";
import {
  buildTillCoreExt,
  cleanCustomerName,
  displayOrderNumber,
  orderTypeLabel,
  sanitizeTillCoreExt,
} from "./order-meta";

describe("quickCashNotes", () => {
  it("$52.47 offers $55, $60, $100", () => {
    expect(quickCashNotes(5247)).toEqual([5500, 6000, 10000]);
  });
  it("skips notes at or below the balance and de-duplicates", () => {
    expect(quickCashNotes(1800)).toEqual([2000, 5000, 10000]);
    expect(quickCashNotes(2000)).toEqual([5000, 10000]);
    expect(quickCashNotes(4100)).toEqual([4500, 5000, 6000, 10000]);
  });
  it("above $100 rounds up to the next $100", () => {
    expect(quickCashNotes(10001)).toEqual([10500, 11000, 12000]);
    expect(quickCashNotes(25000)).toEqual([26000]);
  });
  it("nothing for a zero balance", () => {
    expect(quickCashNotes(0)).toEqual([]);
  });
});

const size = (id: string, name: string, cents = 1000): ItemSize => ({
  id,
  item_id: "i",
  name,
  price_cents: cents,
  sort_order: 0,
});
const sizes = [size("s", "Small"), size("m", "Medium"), size("l", "Large")];

describe("pickDefaultSize", () => {
  it("uses the preferred size, else Large, else the first in stock", () => {
    expect(pickDefaultSize(sizes, new Set(), "Medium")?.id).toBe("m");
    expect(pickDefaultSize(sizes, new Set())?.id).toBe("l");
    expect(pickDefaultSize(sizes, new Set(), "XL")?.id).toBe("l");
    expect(pickDefaultSize([size("s", "Small")], new Set())?.id).toBe("s");
  });
  it("skips sold-out sizes and matches case-insensitively", () => {
    expect(pickDefaultSize(sizes, new Set(["l"]))?.id).toBe("s");
    expect(pickDefaultSize(sizes, new Set(), "large")?.id).toBe("l");
    expect(pickDefaultSize(sizes, new Set(["s", "m", "l"]))).toBeNull();
    expect(pickDefaultSize([], new Set())).toBeNull();
  });
  it("matches the leading word of names with dimensions", () => {
    const dim = [size("s", 'Small (10")'), size("l", 'Large (16")')];
    expect(pickDefaultSize(dim, new Set())?.id).toBe("l");
    expect(pickDefaultSize(dim, new Set(), "Small")?.id).toBe("s");
  });
  it("lists distinct size names", () => {
    const items = [{ sizes }, { sizes: [size("x", "large")] }] as MenuItemDetail[];
    expect(sizeNamesOf(items)).toEqual(["Small", "Medium", "Large"]);
  });
});

describe("canQuickAdd", () => {
  const item = (over: Partial<MenuItemDetail>) =>
    ({
      sizes: [size("r", "Regular")],
      modifierGroups: [],
      is_half_and_half_capable: false,
      ...over,
    }) as MenuItemDetail;
  it("adds a one-size item with no options straight away", () => {
    expect(canQuickAdd(item({}))).toBe(true);
    expect(canQuickAdd(item({ sizes: [] }))).toBe(true);
  });
  it("opens the builder when there is something to choose", () => {
    expect(canQuickAdd(item({ sizes }))).toBe(false);
    expect(canQuickAdd(item({ is_half_and_half_capable: true }))).toBe(false);
    const req = { min_select: 1, supports_half: false } as never;
    expect(canQuickAdd(item({ modifierGroups: [req] }))).toBe(false);
    const opt = { min_select: 0, supports_half: false } as never;
    expect(canQuickAdd(item({ modifierGroups: [opt] }))).toBe(true);
    const half = { min_select: 0, supports_half: true } as never;
    expect(canQuickAdd(item({ modifierGroups: [half] }))).toBe(false);
  });
});

describe("shouldAutoSubmitPin", () => {
  it("submits at 6 digits when the length is unknown", () => {
    expect(shouldAutoSubmitPin("1234")).toBe(false);
    expect(shouldAutoSubmitPin("12345")).toBe(false);
    expect(shouldAutoSubmitPin("123456")).toBe(true);
  });
  it("submits at the known 4-6 length", () => {
    expect(shouldAutoSubmitPin("1234", 4)).toBe(true);
    expect(shouldAutoSubmitPin("123", 4)).toBe(false);
    expect(shouldAutoSubmitPin("12345", 5)).toBe(true);
  });
  it("ignores an out-of-range known length and non-digits", () => {
    expect(shouldAutoSubmitPin("1234", 9)).toBe(false);
    expect(shouldAutoSubmitPin("", 4)).toBe(false);
    expect(shouldAutoSubmitPin("12a4", 4)).toBe(false);
  });
});

describe("order type, name and number display", () => {
  it("round-trips through core_ext and the server sanitizer", () => {
    const ext = buildTillCoreExt("pickup", "  Maria   G ");
    expect(ext).toEqual({ callout_name: "Maria G", metadata: { order_type: "pickup" } });
    expect(sanitizeTillCoreExt(ext)).toEqual(ext);
    expect(orderTypeLabel({ core_ext: ext } as Order)).toBe("Pickup");
  });
  it("drops everything else a client sends, and bad values", () => {
    expect(
      sanitizeTillCoreExt({
        fees: [{ label: "x", amount_cents: 99999 }],
        tax_exempt: true,
        callout_name: "Al",
        metadata: { order_type: "teleport", other: "y" },
      }),
    ).toEqual({ callout_name: "Al" });
    expect(sanitizeTillCoreExt(null)).toBeNull();
    expect(buildTillCoreExt(null, "  ")).toBeNull();
    expect(cleanCustomerName("x".repeat(100))).toHaveLength(40);
  });
  it("shows one order-number format", () => {
    expect(displayOrderNumber("1526-406")).toBe("#406");
    expect(displayOrderNumber("A-0003")).toBe("#3");
    expect(displayOrderNumber("K-103")).toBe("#103");
    expect(displayOrderNumber("0000")).toBe("#0");
    expect(displayOrderNumber("walk-in")).toBe("walk-in");
  });
});
