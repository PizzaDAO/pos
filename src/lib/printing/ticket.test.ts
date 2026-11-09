import { describe, expect, it } from "vitest";
import type { Order, OrderItem } from "@/lib/db";
import { buildTestDoc, buildTicketDoc, cleanText, wrapText } from "./ticket";
import { renderEposPrint, renderEpsonSdp, renderPlainText, renderStarMarkup } from "./render";

function item(over: Partial<OrderItem>): OrderItem {
  return {
    id: "i1",
    item_id: "m1",
    item_name: "Margherita",
    size_id: "s",
    size_name: "Large",
    base_price_cents: 1500,
    quantity: 2,
    modifiers: [],
    notes: null,
    voided: false,
    unit_price_cents: 1500,
    line_total_cents: 3000,
    ...over,
  };
}

function order(over: Partial<Order> = {}): Order {
  return {
    id: "o1",
    tenant_id: "t1",
    location_id: "l1",
    status: "paid",
    channel: "online_delivery",
    currency: "USD",
    items: [item({})],
    discount_cents: 0,
    totals: {
      subtotal_cents: 3000,
      discount_cents: 0,
      taxable_cents: 3000,
      tax_cents: 0,
      tip_cents: 0,
      total_cents: 3000,
    },
    notes: "Ring the back bell",
    order_number: "A-1042",
    fulfillment: { type: "delivery", scheduled_for: "asap", promised_at: "2026-11-09T18:30:00Z" },
    created_at: "2026-11-09T18:00:00Z",
    updated_at: "2026-11-09T18:00:00Z",
    ...over,
  } as Order;
}

const mod = (name: string, placement: "whole" | "left" | "right") => ({
  group_id: "g",
  group_name: "Toppings",
  modifier_id: name,
  modifier_name: name,
  price_cents: 0,
  placement,
});

describe("ticket document", () => {
  it("has the large order number, fulfilment, channel, items, notes", () => {
    const doc = buildTicketDoc(order(), { columns: 42, timezone: "America/New_York" });
    const first = doc.lines[0]!;
    expect(first).toMatchObject({ text: "A-1042", size: 3, bold: true, align: "center" });
    const text = doc.lines.map((l) => l.text).join("\n");
    expect(text).toContain("DELIVERY");
    expect(text).toContain("2x Margherita (Large)");
    expect(text).toContain("NOTE: Ring the back bell");
    expect(text).toContain("1:00 PM"); // 18:00Z in New York
  });

  it("splits half-and-half modifiers and prints line notes, skips voided lines", () => {
    const doc = buildTicketDoc(
      order({
        items: [
          item({ modifiers: [mod("Basil", "whole"), mod("Mushroom", "left"), mod("Sausage", "right")], notes: "well done" }),
          item({ id: "i2", item_name: "VOIDED PIE", voided: true }),
        ],
      }),
      { columns: 42 },
    );
    const text = doc.lines.map((l) => l.text).join("\n");
    expect(text).toContain("+ Basil");
    expect(text).toContain("LEFT: Mushroom");
    expect(text).toContain("RIGHT: Sausage");
    expect(text).toContain("** well done");
    expect(text).not.toContain("VOIDED PIE");
  });

  it.each([42, 48] as const)("never exceeds %i columns (magnification counted)", (cols) => {
    const long = "Extra-long-named-pizza-with-everything ".repeat(4);
    const doc = buildTicketDoc(
      order({ items: [item({ item_name: long, notes: long })], notes: long, order_number: "ORDER-123456789012" }),
      { columns: cols },
    );
    for (const l of doc.lines) {
      expect(l.text.length * (l.size ?? 1)).toBeLessThanOrEqual(cols);
    }
    expect(doc.lines.length).toBeGreaterThan(8);
  });

  it("marks reprints and scheduled orders", () => {
    const doc = buildTicketDoc(
      order({ fulfillment: { type: "pickup", scheduled_for: "2026-11-09T20:00:00Z", promised_at: "x" } }),
      { columns: 42, reprint: true, timezone: "UTC" },
    );
    const text = doc.lines.map((l) => l.text).join("\n");
    expect(text).toContain("*** REPRINT ***");
    expect(text).toContain("PICKUP");
    expect(text).toContain("FOR Nov 9, 8:00 PM");
  });

  it("wraps and cleans text", () => {
    expect(wrapText("aaa bbb ccc", 7)).toEqual(["aaa bbb", "ccc"]);
    expect(wrapText("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
    expect(cleanText("Café [x] “q” ×3 \u{1F355}")).toBe('Cafe (x) "q" x3 ?');
  });
});

describe("renderers", () => {
  const doc = buildTicketDoc(order(), { columns: 42, timezone: "UTC" });

  it("Star markup: magnify/bold/align tags and a cut", () => {
    const r = renderStarMarkup(doc, 42);
    expect(r.contentType).toBe("text/vnd.star.markup");
    expect(r.body).toContain("[align: centre][magnify: width 3; height 3][bold: on]A-1042");
    expect(r.body).toContain("-".repeat(42));
    expect(r.body.trimEnd().endsWith("[cut: feed; partial]")).toBe(true);
  });

  it("plain text: no markup, every line within width", () => {
    const r = renderPlainText(doc, 42);
    expect(r.contentType).toBe("text/plain");
    expect(r.body).not.toContain("[");
    for (const line of r.body.split("\n")) expect(line.length).toBeLessThanOrEqual(42);
  });

  it("ePOS-Print: escaped XML in an SDP envelope with the job id", () => {
    const d = buildTicketDoc(order({ notes: "Fish & <chips>" }), { columns: 48 });
    const xml = renderEpsonSdp(d, 48, "JOBID");
    expect(xml).toContain("<printjobid>JOBID</printjobid>");
    expect(xml).toContain("Fish &amp; &lt;chips&gt;");
    expect(xml).toContain('<cut type="feed"/>');
    expect(renderEposPrint(d, 48).startsWith("<epos-print ")).toBe(true);
  });

  it("test ticket fits the columns", () => {
    const t = buildTestDoc({ columns: 48, label: "Kitchen", locationName: "Downtown" });
    expect(t.lines[0]!.text).toBe("TEST TICKET");
    expect(t.lines.every((l) => l.text.length * (l.size ?? 1) <= 48)).toBe(true);
  });
});
