/**
 * Pure ledger math (no I/O; shared by the mock writer and the tests, and
 * mirrored line for line by the SQL writers in
 * supabase/migrations/20261113000910_stored_value.sql).
 */
import type { LedgerEntry, LedgerKind, StoredValueAccount } from "./types";
import { CREDIT_KINDS } from "./types";

export function isCredit(kind: LedgerKind): boolean {
  return CREDIT_KINDS.includes(kind);
}

/** The signed amount a ledger row of `kind` carries for a positive magnitude. */
export function signedAmount(kind: LedgerKind, magnitudeCents: number): number {
  return isCredit(kind) ? magnitudeCents : -magnitudeCents;
}

export type ApplyResult =
  | { ok: true; balanceAfter: number }
  | { ok: false; reason: "bad_amount" | "insufficient" | "exceeds_max" };

/**
 * Apply one movement of `magnitudeCents` (> 0) to a balance. Debits may never
 * take the balance below 0; credits may not exceed `maxBalanceCents` when given.
 */
export function applyMovement(
  balanceCents: number,
  kind: LedgerKind,
  magnitudeCents: number,
  maxBalanceCents?: number | null,
): ApplyResult {
  if (!Number.isInteger(magnitudeCents) || magnitudeCents <= 0) {
    return { ok: false, reason: "bad_amount" };
  }
  const after = balanceCents + signedAmount(kind, magnitudeCents);
  if (after < 0) return { ok: false, reason: "insufficient" };
  if (isCredit(kind) && maxBalanceCents != null && after > maxBalanceCents) {
    return { ok: false, reason: "exceeds_max" };
  }
  return { ok: true, balanceAfter: after };
}

export type LedgerCheck =
  | { ok: true; balanceCents: number }
  | { ok: false; error: string; atEntryId?: string };

/**
 * Re-derive a balance from the ledger (oldest first) and check its integrity:
 * every row's balance_after equals the running sum, nothing goes negative, and
 * credits/debits carry the right sign. The cached account balance must match.
 */
export function verifyLedger(
  entries: readonly LedgerEntry[],
  account?: Pick<StoredValueAccount, "balance_cents">,
): LedgerCheck {
  let running = 0;
  for (const e of entries) {
    if (e.amount_cents === 0 || Math.sign(e.amount_cents) !== (isCredit(e.kind) ? 1 : -1)) {
      return { ok: false, error: "wrong sign", atEntryId: e.id };
    }
    running += e.amount_cents;
    if (running < 0) return { ok: false, error: "negative balance", atEntryId: e.id };
    if (running !== e.balance_after_cents) {
      return { ok: false, error: "balance_after mismatch", atEntryId: e.id };
    }
  }
  if (account && account.balance_cents !== running) {
    return { ok: false, error: "cached balance mismatch" };
  }
  return { ok: true, balanceCents: running };
}

/**
 * A card may be voided (its sale refunded) only while UNREDEEMED: no
 * redemption has ever touched it (even one refunded back), and no reload was
 * reversed. Only its issue (and later reload) credits exist.
 */
export function isUnredeemed(entries: readonly LedgerEntry[]): boolean {
  return entries.every((e) => e.kind === "issue" || e.kind === "load");
}

/**
 * How much a redemption may take: the smaller of what the card holds and what
 * the order still owes, capped by an explicit request when given. 0 = nothing.
 */
export function redeemableCents(
  balanceCents: number,
  orderRemainingCents: number,
  requestedCents?: number | null,
): number {
  const cap = Math.max(0, Math.min(balanceCents, orderRemainingCents));
  if (requestedCents == null) return cap;
  return Math.max(0, Math.min(cap, requestedCents));
}
