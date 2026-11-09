/**
 * Pure cash-tender rule shared by the payment screen and the server (no imports:
 * safe in client bundles).
 *
 * What the cashier typed decides the tender:
 * - Nothing typed: exact cash for the balance + tip.
 * - At least balance + tip: the whole balance, with the tip, and change back.
 * - Less than the balance: a PARTIAL tender for exactly what was handed over,
 *   with NO tip (the tip only rides on the tender that finishes the order). The
 *   rest stays due, for more cash or a card.
 * - At least the balance but less than balance + tip: refused ("short_of_tip"):
 *   the cashier lowers the tip or takes more cash. Splitting a tip across a
 *   short tender is never guessed.
 */

export type CashTenderPlan =
  | {
      kind: "full";
      amountCents: number;
      tipCents: number;
      cashTenderedCents: number;
      changeCents: number;
    }
  | {
      kind: "partial";
      amountCents: number;
      tipCents: 0;
      cashTenderedCents: number;
      changeCents: 0;
      /** Balance still due after this tender. */
      remainingCents: number;
    }
  | {
      kind: "short_of_tip";
      /** How much more cash would cover the tip. */
      shortCents: number;
    }
  | { kind: "nothing_due" };

export function planCashTender(input: {
  balanceCents: number;
  tipCents: number;
  /** What the cashier typed, in cents; 0 / undefined means "exact". */
  tenderedCents?: number;
}): CashTenderPlan {
  const balance = Math.max(0, Math.round(input.balanceCents));
  const tip = Math.max(0, Math.round(input.tipCents));
  const tendered = Math.max(0, Math.round(input.tenderedCents ?? 0));
  if (balance <= 0) return { kind: "nothing_due" };
  const due = balance + tip;
  if (tendered === 0 || tendered >= due) {
    const cash = tendered === 0 ? due : tendered;
    return {
      kind: "full",
      amountCents: balance,
      tipCents: tip,
      cashTenderedCents: cash,
      changeCents: cash - due,
    };
  }
  if (tendered < balance) {
    return {
      kind: "partial",
      amountCents: tendered,
      tipCents: 0,
      cashTenderedCents: tendered,
      changeCents: 0,
      remainingCents: balance - tendered,
    };
  }
  return { kind: "short_of_tip", shortCents: due - tendered };
}

/**
 * Server rule: a cash tender must be covered by the cash handed over. Returns
 * an error message, or null when the tender is fine. An omitted tendered amount
 * means exact cash.
 */
export function cashTenderError(input: {
  amountCents: number;
  tipCents: number;
  cashTenderedCents?: number;
}): string | null {
  if (input.cashTenderedCents === undefined) return null;
  const due = input.amountCents + input.tipCents;
  if (input.cashTenderedCents < due) {
    return "Cash handed over is less than the amount due. Reload the till and take it as a partial payment.";
  }
  return null;
}
