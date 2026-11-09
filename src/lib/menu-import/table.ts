/** Uploaded bytes -> header + data rows, with the size / row-count limits. */
import { parseCsv } from "./csv";
import { isXlsx, parseXlsx } from "./xlsx";
import { IMPORT_LIMITS, MenuImportError } from "./types";

export interface MenuTable {
  headers: string[];
  /** Data rows; `row` is the 1-based spreadsheet row number (header = 1). */
  rows: { row: number; cells: string[] }[];
}

function decodeText(bytes: Uint8Array): string {
  // Excel's "Unicode Text" export is UTF-16LE with a BOM.
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(bytes);
  }
  return new TextDecoder("utf-8").decode(bytes);
}

export function readTable(bytes: Uint8Array): MenuTable {
  if (bytes.length === 0) throw new MenuImportError("The file is empty.", 400);
  if (bytes.length > IMPORT_LIMITS.maxFileBytes) {
    throw new MenuImportError(
      `The file is larger than ${IMPORT_LIMITS.maxFileBytes / 1024 / 1024} MB.`,
      413,
    );
  }
  const grid = isXlsx(bytes) ? parseXlsx(bytes) : parseCsv(decodeText(bytes));
  const [header, ...rest] = grid;
  if (!header || header.every((h) => h.trim() === "")) {
    throw new MenuImportError("The file has no header row.", 422);
  }
  if (rest.length > IMPORT_LIMITS.maxRows) {
    throw new MenuImportError(
      `The file has more than ${IMPORT_LIMITS.maxRows} rows. Split it and import in parts.`,
      413,
    );
  }
  return {
    headers: header.map((h) => h.trim()),
    // Rows are 1-based and the header is row 1; blank lines were dropped, so
    // numbers can drift on files with blank lines (best effort, for messages).
    rows: rest.map((cells, i) => ({ row: i + 2, cells })),
  };
}
