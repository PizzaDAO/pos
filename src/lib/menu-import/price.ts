/** Price text -> integer cents, without float drift. Null when unparseable. */
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
  // "12,50" (decimal comma) vs "1,299.00" / "1,299" (thousands comma).
  if (/^\d+,\d{1,2}$/.test(s)) s = s.replace(",", ".");
  else s = s.replace(/,/g, "");
  if (!/^\d*\.?\d+$|^\d+\.$/.test(s)) return null;
  const cents = Math.round(Number(s) * 100);
  if (!Number.isFinite(cents)) return null;
  return negative ? -cents : cents;
}
