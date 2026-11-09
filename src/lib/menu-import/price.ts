/**
 * Price text -> integer cents, without float drift and WITHOUT guessing.
 *
 * Accepted shapes (after stripping currency symbols/spaces):
 *   12 | 12.5 | 12.50 | .5            decimal point, 1-2 decimals
 *   12,50                              decimal comma, 1-2 decimals
 *   1,299 | 1,299.50                   US thousands commas
 *   1.299,50                           EU thousands points + decimal comma
 * Anything else ("12.345", "1.234", "1,23,456", "12.3.4") is ambiguous or
 * malformed and returns null so the importer warns instead of mispricing.
 */
export function parsePriceCents(raw: string | undefined | null): number | null {
  if (raw == null) return null;
  let s = raw.trim().replace(/[\s$€£]/g, "").replace(/^usd/i, "");
  if (s === "") return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (s.startsWith("-")) {
    negative = true;
    s = s.slice(1);
  }
  let normalized: string;
  if (/^\d+$|^\d*\.\d{1,2}$/.test(s)) normalized = s;
  else if (/^\d+,\d{1,2}$/.test(s)) normalized = s.replace(",", ".");
  else if (/^\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(s)) normalized = s.replace(/,/g, "");
  else if (/^\d{1,3}(\.\d{3})+,\d{1,2}$/.test(s)) normalized = s.replace(/\./g, "").replace(",", ".");
  else return null;
  const cents = Math.round(Number(normalized) * 100);
  if (!Number.isFinite(cents)) return null;
  return negative ? -cents : cents;
}

/** True when the text looks like a number but is rejected as ambiguous. */
export function looksAmbiguousPrice(raw: string): boolean {
  return /\d[.,]\d{3}(?!\d)|\d[.,]\d{3,}/.test(raw) && parsePriceCents(raw) === null;
}
