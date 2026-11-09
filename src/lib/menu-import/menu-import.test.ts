import { readFileSync } from "node:fs";
import { join } from "node:path";
import { zipSync, strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { parseCsv } from "./csv";
import { parsePriceCents } from "./price";
import { parseMenuImport } from "./index";
import { IMPORT_LIMITS, MenuImportError } from "./types";
import { buildImportRows, emptySnapshot } from "./apply";
import { GENERIC_TEMPLATE_CSV } from "./template";

const fixture = (name: string) =>
  new Uint8Array(readFileSync(join(__dirname, "__fixtures__", name)));
const bytes = (s: string) => new TextEncoder().encode(s);

function sizesOf(plan: ReturnType<typeof parseMenuImport>, item: string) {
  for (const c of plan.categories) {
    const i = c.items.find((x) => x.name === item);
    if (i) return i.sizes.map((s) => [s.name, s.price_cents]);
  }
  return null;
}

describe("parseCsv", () => {
  it("handles quotes, escaped quotes, embedded newlines, CRLF and a BOM", () => {
    const rows = parseCsv('﻿a,b\r\n"x, y","say ""hi"""\r\n"line1\nline2",z\r\n\r\n');
    expect(rows).toEqual([
      ["a", "b"],
      ["x, y", 'say "hi"'],
      ["line1\nline2", "z"],
    ]);
  });
  it("detects semicolon and tab delimiters", () => {
    expect(parseCsv("a;b\n1;2")).toEqual([["a", "b"], ["1", "2"]]);
    expect(parseCsv("a\tb\n1\t2")).toEqual([["a", "b"], ["1", "2"]]);
  });
});

describe("parsePriceCents", () => {
  it.each([
    ["12.00", 1200],
    ["$12.50", 1250],
    ["12.5", 1250],
    ["1,299.00", 129900],
    ["12,50", 1250],
    ["0", 0],
    ["19.99", 1999],
    ["(3.00)", -300],
    ["1.234,50", 123450],
    ["1,234.5", 123450],
    [".5", 50],
  ])("%s -> %i", (raw, cents) => {
    expect(parsePriceCents(raw)).toBe(cents);
  });
  it.each(["", "abc", "12.3.4", "$", "12.345", "1.234", "1,23,456", "12.3456"])("rejects %j", (raw) => {
    expect(parsePriceCents(raw)).toBeNull();
  });
});

describe("Square item library", () => {
  const plan = parseMenuImport(fixture("square-items.csv"));
  it("is detected and counted", () => {
    expect(plan.format).toBe("square");
    expect(plan.categories.map((c) => c.name)).toEqual(["Pizzas", "Drinks", "Desserts"]);
    expect(plan.stats).toMatchObject({ items: 4, sizes: 5, categories: 3, modifierGroups: 0 });
  });
  it("turns variations into sizes and prices into integer cents", () => {
    expect(sizesOf(plan, "Margherita")).toEqual([["Small", 1200], ["Large", 1800]]);
    expect(sizesOf(plan, "Pepperoni")).toEqual([["Regular", 1950]]);
    expect(sizesOf(plan, "Cola")).toEqual([["Regular", 250]]);
    expect(plan.categories[0]?.items[0]?.description).toBe("Tomato, mozzarella, basil");
  });
  it("skips archived and missing-price rows and says why", () => {
    expect(sizesOf(plan, "Old Special")).toBeNull();
    expect(sizesOf(plan, "Build Your Own")).toBeNull();
    const codes = plan.warnings.map((w) => w.code);
    expect(codes).toContain("missing_price");
    expect(codes).toContain("skipped_archived");
    const missing = plan.warnings.find((w) => w.code === "missing_price");
    expect(missing?.row).toBe(7);
  });
  it("uses the first category of a multi-category cell", () => {
    expect(plan.categories.find((c) => c.name === "Desserts")?.items[0]?.name).toBe("Tiramisu");
  });
  it("warns about modifier sets with no options and unknown columns", () => {
    // Group names are kept on items; the "no options for it" warning is raised
    // against the existing menu when the change set is built.
    expect(plan.categories[0]?.items[0]?.modifier_groups).toEqual(["Toppings", "Crust"]);
    const { warnings, changes } = buildImportRows("t", emptySnapshot(), plan, "add");
    const text = warnings.map((w) => w.message).join(" ");
    expect(text).toMatch(/Toppings/);
    expect(text).toMatch(/Crust/);
    expect(changes.insert.modifierGroups).toEqual([]);
    expect(changes.insert.itemModifierGroups).toEqual([]);
    expect(plan.unknownColumns).toEqual(["Mystery Column"]);
  });
});

describe("Square XLSX", () => {
  /** Build a real .xlsx (zip of XML) from the CSV fixture's grid. */
  function xlsxFrom(grid: string[][]): Uint8Array {
    const esc = (s: string) =>
      s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const col = (i: number) => String.fromCharCode(65 + (i % 26)).padStart(i >= 26 ? 2 : 1, "A");
    const shared: string[] = [];
    const rowsXml = grid
      .map((cells, r) => {
        const cs = cells
          .map((v, c) => {
            const ref = `${col(c)}${r + 1}`;
            if (/^\d+(\.\d+)?$/.test(v) && r > 0 && grid[0]?.[c] === "Price") {
              return `<c r="${ref}"><v>${v}</v></c>`;
            }
            shared.push(v);
            return `<c r="${ref}" t="s"><v>${shared.length - 1}</v></c>`;
          })
          .join("");
        return `<row r="${r + 1}">${cs}</row>`;
      })
      .join("");
    const sheet = `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rowsXml}</sheetData></worksheet>`;
    const sst = `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${shared
      .map((s) => `<si><t xml:space="preserve">${esc(s)}</t></si>`)
      .join("")}</sst>`;
    const workbook = `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Instructions" sheetId="1" r:id="rId9"/><sheet name="Items" sheetId="2" r:id="rId1"/></sheets></workbook>`;
    const rels = `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="x" Target="worksheets/sheet1.xml"/><Relationship Id="rId9" Type="x" Target="worksheets/sheet2.xml"/></Relationships>`;
    return zipSync({
      "[Content_Types].xml": strToU8("<Types/>"),
      "xl/workbook.xml": strToU8(workbook),
      "xl/_rels/workbook.xml.rels": strToU8(rels),
      "xl/sharedStrings.xml": strToU8(sst),
      "xl/worksheets/sheet1.xml": strToU8(sheet),
      "xl/worksheets/sheet2.xml": strToU8(
        `<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Read me</t></is></c></row></sheetData></worksheet>`,
      ),
    });
  }

  it("reads the Items sheet and matches the CSV result", () => {
    const grid = parseCsv(new TextDecoder().decode(fixture("square-items.csv")));
    const fromXlsx = parseMenuImport(xlsxFrom(grid));
    const fromCsv = parseMenuImport(fixture("square-items.csv"));
    expect(fromXlsx.categories).toEqual(fromCsv.categories);
    expect(fromXlsx.stats).toEqual(fromCsv.stats);
  });
  it("rejects a corrupt workbook", () => {
    expect(() => parseMenuImport(new Uint8Array([0x50, 0x4b, 1, 2, 3, 4, 5]))).toThrow(MenuImportError);
  });
});

describe("Toast menu export", () => {
  const plan = parseMenuImport(fixture("toast-menu.csv"));
  it("maps Menu Group to categories and sizes to sizes", () => {
    expect(plan.format).toBe("toast");
    expect(plan.categories.map((c) => c.name)).toEqual(["Pizzas", "Wings", "Beverages"]);
    expect(sizesOf(plan, "Margherita")).toEqual([["Small", 1200], ["Large", 1800]]);
    expect(sizesOf(plan, "Buffalo Wings")).toEqual([["Regular", 1050]]);
  });
  it("guesses stations from the category and flags unreadable prices", () => {
    const station = (n: string) =>
      plan.categories.flatMap((c) => c.items).find((i) => i.name === n)?.station;
    expect(station("Lemonade")).toBe("none");
    expect(station("Buffalo Wings")).toBe("fryer");
    expect(station("Margherita")).toBe("oven");
    expect(plan.warnings.some((w) => w.code === "invalid_price" && /Mystery Pie/.test(w.message))).toBe(true);
  });
});

describe("Clover inventory", () => {
  const plan = parseMenuImport(fixture("clover-inventory.csv"));
  it("maps names, categories and prices; skips hidden and variable-price items", () => {
    expect(plan.format).toBe("clover");
    expect(plan.categories.map((c) => c.name)).toEqual(["Slices", "Drinks"]);
    expect(sizesOf(plan, "Pepperoni Slice")).toEqual([["Regular", 425]]);
    expect(sizesOf(plan, "Retired Dish")).toBeNull();
    expect(sizesOf(plan, "Market Item")).toBeNull();
    expect(plan.warnings.map((w) => w.code)).toEqual(
      expect.arrayContaining(["missing_price", "skipped_archived"]),
    );
    const { warnings } = buildImportRows("t", emptySnapshot(), plan, "add");
    expect(warnings.map((w) => w.code)).toContain("modifiers_without_options");
  });
});

describe("Generic template", () => {
  const plan = parseMenuImport(bytes(GENERIC_TEMPLATE_CSV));
  it("round-trips the downloadable template", () => {
    expect(plan.format).toBe("generic");
    expect(plan.stats).toMatchObject({ categories: 3, items: 4, sizes: 5, modifierGroups: 2, modifiers: 4 });
    expect(plan.warnings).toEqual([]);
  });
  it("builds modifier groups with min/max/options and links items to them", () => {
    const crust = plan.modifierGroups.find((g) => g.name === "Crust");
    expect(crust).toMatchObject({ min_select: 1, max_select: 1 });
    expect(crust?.modifiers).toEqual([
      { name: "Thin", price_cents: 0 },
      { name: "Thick", price_cents: 100 },
    ]);
    const toppings = plan.modifierGroups.find((g) => g.name === "Toppings");
    expect(toppings).toMatchObject({ min_select: 0, max_select: 5 });
    const margherita = plan.categories[0]?.items[0];
    expect(margherita?.modifier_groups).toEqual(["Toppings", "Crust"]);
    expect(margherita?.half_and_half).toBe(true);
    expect(plan.categories[1]?.items[0]?.station).toBe("none");
  });
  it("maps headers tolerantly by synonym", () => {
    const p = parseMenuImport(bytes("Product Name,Reporting Category,Unit Price\nCalzone,Mains,9.99\n"));
    expect(sizesOf(p, "Calzone")).toEqual([["Regular", 999]]);
  });
  it("warns on duplicate sizes, same name in two categories and unknown columns", () => {
    const p = parseMenuImport(
      bytes(
        "category,item,size,price,flavor\nA,Pie,Reg,5,x\nA,Pie,Reg,6,x\nB,Pie,Reg,7,x\n",
      ),
    );
    const codes = p.warnings.map((w) => w.code);
    expect(codes).toEqual(
      expect.arrayContaining(["duplicate_size", "name_in_multiple_categories", "unknown_columns"]),
    );
    expect(sizesOf(p, "Pie")).toEqual([["Reg", 500]]);
  });
});

describe("limits and errors", () => {
  it("rejects empty and oversized files", () => {
    expect(() => parseMenuImport(new Uint8Array())).toThrow(/empty/);
    const big = new Uint8Array(IMPORT_LIMITS.maxFileBytes + 1);
    expect(() => parseMenuImport(big)).toThrow(MenuImportError);
    try {
      parseMenuImport(big);
    } catch (e) {
      expect((e as MenuImportError).status).toBe(413);
    }
  });
  it("rejects too many rows", () => {
    const lines = ["item,price"];
    for (let i = 0; i <= IMPORT_LIMITS.maxRows; i++) lines.push(`Item ${i},1.00`);
    expect(() => parseMenuImport(bytes(lines.join("\n")))).toThrow(/more than 5000 rows/);
  });
  it("explains a missing item or price column", () => {
    expect(() => parseMenuImport(bytes("foo,bar\n1,2\n"))).toThrow(/item-name column/);
    expect(() => parseMenuImport(bytes("item,bar\n1,2\n"))).toThrow(/price column/);
  });
  it("errors when nothing is importable", () => {
    expect(() => parseMenuImport(bytes("item,price\nA,\nB,zzz\n"))).toThrow(/No importable items/);
  });
  it("truncates over-long names with a warning", () => {
    const p = parseMenuImport(bytes(`item,price\n${"x".repeat(300)},1\n`));
    expect(p.categories[0]?.items[0]?.name).toHaveLength(IMPORT_LIMITS.maxNameLength);
    expect(p.warnings.some((w) => w.code === "truncated")).toBe(true);
  });
});

describe("hostile XLSX input", () => {
  const WB = `<workbook xmlns:r="x"><sheets><sheet name="Items" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const RELS = `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`;
  function xlsx(sheet: string, sst = "<sst/>") {
    return zipSync({
      "xl/workbook.xml": strToU8(WB),
      "xl/_rels/workbook.xml.rels": strToU8(RELS),
      "xl/sharedStrings.xml": strToU8(sst),
      "xl/worksheets/sheet1.xml": strToU8(sheet),
    });
  }
  const sheetWith = (cells: string) =>
    `<worksheet><sheetData><row r="1">${cells}</row></sheetData></worksheet>`;
  const timed = (fn: () => unknown) => {
    const t = performance.now();
    try {
      fn();
    } catch (e) {
      expect(e).toBeInstanceOf(MenuImportError);
    }
    return performance.now() - t;
  };

  it("rejects a cell with an absurd column index instead of allocating it", () => {
    for (const ref of ["ZZZZZZ1", "ZZZZ1", "XFE1", "GR1"]) {
      expect(() => parseMenuImport(xlsx(sheetWith(`<c r="${ref}"/>`)))).toThrow(MenuImportError);
    }
  });

  it("is linear on unclosed tags (no quadratic regex backtracking)", () => {
    const evil = "<si>".repeat(100_000);
    expect(timed(() => parseMenuImport(xlsx(sheetWith(`<c r="A1"/>`), `<sst>${evil}</sst>`)))).toBeLessThan(1000);
    expect(timed(() => parseMenuImport(xlsx(`<worksheet><sheetData>${"<row>".repeat(100_000)}</sheetData></worksheet>`)))).toBeLessThan(1000);
    expect(timed(() => parseMenuImport(xlsx(sheetWith("<c r=\"A1\">".repeat(100_000)))))).toBeLessThan(1000);
    expect(timed(() => parseMenuImport(xlsx(sheetWith(`<c r="A1" t="inlineStr"><is>${"<t>".repeat(100_000)}</is></c>`))))).toBeLessThan(1000);
  });

  it("caps shared strings, cells and unpacked size", () => {
    const many = `<sst>${"<si><t>x</t></si>".repeat(IMPORT_LIMITS.maxXlsxSharedStrings + 1)}</sst>`;
    expect(() => parseMenuImport(xlsx(sheetWith(`<c r="A1"/>`), many))).toThrow(/too many strings|too large/);
    const bomb = zipSync({
      "xl/workbook.xml": strToU8(WB),
      "xl/_rels/workbook.xml.rels": strToU8(RELS),
      "xl/worksheets/sheet1.xml": new Uint8Array(IMPORT_LIMITS.maxXlsxUncompressedBytes + 1),
    });
    expect(bomb.length).toBeLessThan(IMPORT_LIMITS.maxFileBytes);
    expect(() => parseMenuImport(bomb)).toThrow(/too large/);
  });

  it("turns invalid numeric entities into a replacement char, not a crash", () => {
    const sheet = `<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>item</t></is></c><c r="B1" t="inlineStr"><is><t>price</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>Pie&#x110000;&#xD800;&#99999999999;</t></is></c><c r="B2"><v>5</v></c></row></sheetData></worksheet>`;
    const plan = parseMenuImport(xlsx(sheet));
    expect(plan.categories[0]?.items[0]?.name).toContain("Pie\ufffd");
  });
});
