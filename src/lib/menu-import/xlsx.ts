/**
 * Minimal XLSX reader (first / "Items" worksheet -> string grid). XLSX is a zip
 * of XML parts; we only need workbook.xml (sheet names), its rels, the shared
 * strings table and one worksheet. Dependency: fflate (zip inflate only).
 *
 * Hardened against zip bombs: every part we inflate is size-checked first.
 */
import { unzipSync } from "fflate";
import { IMPORT_LIMITS, MenuImportError } from "./types";

const dec = new TextDecoder("utf-8");

function decodeXml(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) =>
      String.fromCodePoint(Number.parseInt(h, 16)),
    )
    .replace(/&#(\d+);/g, (_, d: string) =>
      String.fromCodePoint(Number.parseInt(d, 10)),
    )
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Concatenate every <t> run in a fragment (rich-text strings have several). */
function textOf(fragment: string): string {
  let out = "";
  for (const m of fragment.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) {
    out += decodeXml(m[1] ?? "");
  }
  return out;
}

function colIndex(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? "A";
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export function isXlsx(bytes: Uint8Array): boolean {
  return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
}

export function parseXlsx(bytes: Uint8Array): string[][] {
  let budget = IMPORT_LIMITS.maxXlsxUncompressedBytes;
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, {
      filter: (f) => {
        if (!/^xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|worksheets\/[^/]+\.xml)$/.test(f.name)) {
          return false;
        }
        budget -= f.originalSize;
        if (budget < 0) {
          throw new MenuImportError("The spreadsheet is too large once unpacked.", 413);
        }
        return true;
      },
    });
  } catch (err) {
    if (err instanceof MenuImportError) throw err;
    throw new MenuImportError("Could not read the .xlsx file (is it corrupt?).", 400);
  }
  const read = (name: string) => {
    const f = files[name];
    return f ? dec.decode(f) : null;
  };

  const workbook = read("xl/workbook.xml");
  if (!workbook) throw new MenuImportError("Not a valid .xlsx workbook.", 400);
  const rels = read("xl/_rels/workbook.xml.rels") ?? "";
  const relTarget = new Map<string, string>();
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = /\bId="([^"]*)"/.exec(m[0])?.[1];
    const target = /\bTarget="([^"]*)"/.exec(m[0])?.[1];
    if (id && target) relTarget.set(id, target);
  }
  const sheets: { name: string; path: string }[] = [];
  for (const m of workbook.matchAll(/<sheet\b[^>]*>/g)) {
    const name = decodeXml(/\bname="([^"]*)"/.exec(m[0])?.[1] ?? "");
    const rid = /\br:id="([^"]*)"/.exec(m[0])?.[1];
    const target = rid ? relTarget.get(rid) : undefined;
    if (target) {
      const path = target.startsWith("/")
        ? target.slice(1)
        : `xl/${target.replace(/^\.\//, "")}`;
      sheets.push({ name, path });
    }
  }
  const chosen = sheets.find((s) => /^items?$/i.test(s.name)) ?? sheets[0];
  const sheetXml = chosen ? read(chosen.path) : null;
  if (!sheetXml) throw new MenuImportError("The workbook has no readable sheet.", 400);

  const shared: string[] = [];
  const sst = read("xl/sharedStrings.xml");
  if (sst) {
    for (const m of sst.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
      shared.push(textOf(m[1] ?? ""));
    }
  }

  const grid: string[][] = [];
  for (const rowMatch of sheetXml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: string[] = [];
    const rowXml = rowMatch[1] ?? "";
    for (const c of rowXml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1] ?? "";
      const body = c[2] ?? "";
      const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1];
      const type = /\bt="([^"]*)"/.exec(attrs)?.[1];
      const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      let value = "";
      if (type === "s") value = shared[Number.parseInt(v ?? "", 10)] ?? "";
      else if (type === "inlineStr") value = textOf(body);
      else if (type === "b") value = v === "1" ? "TRUE" : "FALSE";
      else if (v !== undefined) value = decodeXml(v);
      const idx = ref ? colIndex(ref) : cells.length;
      while (cells.length < idx) cells.push("");
      cells[idx] = value;
    }
    if (cells.some((x) => x.trim() !== "")) grid.push(cells);
    if (grid.length > IMPORT_LIMITS.maxRows + 1) break; // bounded; caller rejects
  }
  return grid;
}
