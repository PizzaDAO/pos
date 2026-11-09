/**
 * Minimal XLSX reader (first / "Items" worksheet -> string grid). XLSX is a zip
 * of XML parts; we only need workbook.xml (sheet names), its rels, the shared
 * strings table and one worksheet. Dependency: fflate (zip inflate only).
 *
 * Hardened for untrusted uploads:
 *   - zip bombs: parts are size-checked before inflating, total budget is small;
 *   - XML is scanned with a LINEAR indexOf scanner (no lazy-regex backtracking:
 *     an unclosed "<si>" repeated n times must not cost O(n^2));
 *   - column indexes are bounded (`<c r="ZZZZZZ1"/>` must not allocate millions
 *     of slots) and total cells / shared strings are budgeted.
 */
import { unzipSync } from "fflate";
import { IMPORT_LIMITS, MenuImportError } from "./types";

const dec = new TextDecoder("utf-8");

function codePoint(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) {
    return "�";
  }
  return String.fromCodePoint(n);
}

function decodeXml(s: string): string {
  if (!s.includes("&")) return s;
  return s
    .replace(/&#x([0-9a-fA-F]{1,8});/g, (_, h: string) => codePoint(Number.parseInt(h, 16)))
    .replace(/&#(\d{1,9});/g, (_, d: string) => codePoint(Number.parseInt(d, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

interface Element {
  attrs: string;
  body: string;
}

/**
 * Linear scan for `<tag ...>body</tag>` / `<tag .../>` elements. Each indexOf
 * resumes where the last one ended, and an element with no closing tag ends the
 * scan, so total work is O(length) whatever the input looks like. Elements are
 * assumed not to nest (true for si / row / c / t / sheet / Relationship).
 */
function* elements(xml: string, tag: string): Generator<Element> {
  const open = `<${tag}`;
  const close = `</${tag}>`;
  let pos = 0;
  for (;;) {
    const start = xml.indexOf(open, pos);
    if (start < 0) return;
    const after = xml.charCodeAt(start + open.length);
    // Must be "<tag" followed by space/>/ (not "<tagfoo").
    if (!(after === 32 || after === 62 || after === 47 || after === 10 || after === 13 || after === 9)) {
      pos = start + open.length;
      continue;
    }
    const gt = xml.indexOf(">", start + open.length);
    if (gt < 0) return;
    if (xml.charCodeAt(gt - 1) === 47) {
      yield { attrs: xml.slice(start + open.length, gt - 1), body: "" };
      pos = gt + 1;
      continue;
    }
    const end = xml.indexOf(close, gt + 1);
    if (end < 0) return;
    yield { attrs: xml.slice(start + open.length, gt), body: xml.slice(gt + 1, end) };
    pos = end + close.length;
  }
}

function attr(attrs: string, name: string): string | undefined {
  // Attribute lists are tiny in real files; bound the scan so a hostile
  // megabyte-long "attribute" can't make repeated lookups quadratic.
  const a = attrs.length > 2000 ? attrs.slice(0, 2000) : attrs;
  const needle = `${name}="`;
  let from = 0;
  for (;;) {
    const i = a.indexOf(needle, from);
    if (i < 0) return undefined;
    if (i === 0 || /\s/.test(a.charAt(i - 1))) {
      const end = a.indexOf('"', i + needle.length);
      return end < 0 ? undefined : a.slice(i + needle.length, end);
    }
    from = i + needle.length;
  }
}

/** Concatenate every <t> run in a fragment (rich-text strings have several). */
function textOf(fragment: string): string {
  let out = "";
  for (const t of elements(fragment, "t")) out += decodeXml(t.body);
  return out;
}

/** Text of the first <v>...</v> (capped), via indexOf: no regex backtracking. */
function valueOf(body: string): string | undefined {
  const start = body.indexOf("<v>");
  if (start < 0) return undefined;
  const end = body.indexOf("</v>", start + 3);
  if (end < 0 || end - start - 3 > 4096) return undefined;
  return body.slice(start + 3, end);
}

/** 0-based column from a cell ref ("B2" -> 1); -1 when malformed or absurd. */
function colIndex(ref: string): number {
  let n = 0;
  let i = 0;
  for (; i < ref.length; i++) {
    const c = ref.charCodeAt(i);
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
    if (n > 16384) return -1; // Excel's hard limit is XFD = 16384
  }
  return i === 0 ? -1 : n - 1;
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
  const relTarget = new Map<string, string>();
  for (const r of elements(read("xl/_rels/workbook.xml.rels") ?? "", "Relationship")) {
    const id = attr(r.attrs, "Id");
    const target = attr(r.attrs, "Target");
    if (id && target) relTarget.set(id, target);
  }
  const sheets: { name: string; path: string }[] = [];
  for (const s of elements(workbook, "sheet")) {
    const rid = attr(s.attrs, "r:id");
    const target = rid ? relTarget.get(rid) : undefined;
    if (target) {
      const path = target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`;
      sheets.push({ name: decodeXml(attr(s.attrs, "name") ?? ""), path });
    }
  }
  const chosen = sheets.find((s) => /^items?$/i.test(s.name)) ?? sheets[0];
  const sheetXml = chosen ? read(chosen.path) : null;
  if (!sheetXml) throw new MenuImportError("The workbook has no readable sheet.", 400);

  const shared: string[] = [];
  const sst = read("xl/sharedStrings.xml");
  if (sst) {
    for (const si of elements(sst, "si")) {
      if (shared.length >= IMPORT_LIMITS.maxXlsxSharedStrings) {
        throw new MenuImportError("The spreadsheet has too many strings.", 413);
      }
      shared.push(textOf(si.body));
    }
  }

  const grid: string[][] = [];
  let cellBudget = IMPORT_LIMITS.maxXlsxCells;
  let rowTags = 0;
  for (const row of elements(sheetXml, "row")) {
    if (++rowTags > IMPORT_LIMITS.maxRows * 4) {
      throw new MenuImportError("The spreadsheet has too many rows.", 413);
    }
    // Sparse first: only real cells are stored, then densified to the widest
    // populated column (bounded by maxColumns, so the fill is bounded too).
    const sparse = new Map<number, string>();
    let next = 0;
    for (const c of elements(row.body, "c")) {
      if (--cellBudget < 0) {
        throw new MenuImportError("The spreadsheet has too many cells.", 413);
      }
      const ref = attr(c.attrs, "r");
      const idx = ref ? colIndex(ref) : next;
      if (idx < 0) throw new MenuImportError("The spreadsheet has an invalid cell reference.", 400);
      if (idx >= IMPORT_LIMITS.maxColumns) {
        throw new MenuImportError(`The spreadsheet has more than ${IMPORT_LIMITS.maxColumns} columns.`, 413);
      }
      next = idx + 1;
      const type = attr(c.attrs, "t");
      const v = valueOf(c.body);
      let value = "";
      if (type === "s") value = shared[Number.parseInt(v ?? "", 10)] ?? "";
      else if (type === "inlineStr") value = textOf(c.body);
      else if (type === "b") value = v === "1" ? "TRUE" : "FALSE";
      else if (v !== undefined) value = decodeXml(v);
      if (value !== "") sparse.set(idx, value);
    }
    if (sparse.size === 0) continue;
    const width = Math.max(...sparse.keys()) + 1;
    const cells = new Array<string>(width).fill("");
    for (const [i, v] of sparse) cells[i] = v;
    grid.push(cells);
    if (grid.length > IMPORT_LIMITS.maxRows + 1) break; // caller rejects with a clear error
  }
  return grid;
}
