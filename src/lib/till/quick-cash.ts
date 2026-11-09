/**
 * Quick-cash note choices for the payment screen — pure, integer cents.
 *
 * "Exact" is its own button, so this returns the notes a customer would
 * actually hand over: the next $5, $10 and $20 above what is owed, then $50 and
 * $100, keeping only amounts above the balance (a note equal to it is Exact),
 * de-duplicated and capped. Owed $52.47 gives $55, $60, $100.
 */
const FIXED_NOTES = [5000, 10000];
const ROUND_TO = [500, 1000, 2000];
const MAX_NOTES = 4;

export function quickCashNotes(dueCents: number): number[] {
  if (!(dueCents > 0)) return [];
  const candidates = [
    ...ROUND_TO.map((step) => Math.ceil(dueCents / step) * step),
    ...FIXED_NOTES,
  ];
  const notes = [...new Set(candidates)]
    .filter((n) => n > dueCents)
    .sort((a, b) => a - b);
  if (notes.length === 0) {
    // Above $100: the next $100 up.
    notes.push((Math.floor(dueCents / 10000) + 1) * 10000);
  }
  return notes.slice(0, MAX_NOTES);
}
